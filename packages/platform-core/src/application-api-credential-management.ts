import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	ApplicationApiCredentialErrorV1,
	type ApplicationApiCredentialRequestV1,
	type ApplicationApiCredentialTransactionV1,
} from "./application-api-credentials.js";
import {
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialMetadataV1,
	parsePersonalApiCredentialRequestV1,
	requirePersonalApiUserActiveV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";
import type { TaskUserDirectoryV1 } from "./task-authorization.js";

export type ApplicationApiCredentialMetadataV1 =
	PersonalApiCredentialMetadataV1 & {
		readonly applicationId: string;
	};
export interface ApplicationApiCredentialPageV1 {
	readonly items: readonly ApplicationApiCredentialMetadataV1[];
	readonly nextCursor: string | null;
}
export interface ApplicationApiCredentialRevocationV1 {
	readonly metadata: ApplicationApiCredentialMetadataV1;
	readonly replayed: boolean;
}
export type ApplicationApiCredentialReadRequestV1 = Omit<
	ApplicationApiCredentialRequestV1,
	"idempotencyKey"
>;
export interface ApplicationApiCredentialManagementTransactionV1
	extends Pick<
		ApplicationApiCredentialTransactionV1,
		"lockUserDisabled" | "lockApplication" | "databaseTime" | "revokeCredential"
	> {
	listCredentials(
		applicationId: string,
		limit: number,
		afterId: string | null,
	): Promise<readonly PersonalApiCredentialMetadataV1[]>;
	lockCredential(
		applicationId: string,
		credentialId: string,
	): Promise<PersonalApiCredentialMetadataV1 | null>;
	lockRevocation(
		request: ApplicationApiCredentialRequestV1,
	): Promise<string | null>;
	saveRevocation(
		request: ApplicationApiCredentialRequestV1,
		credentialId: string,
	): Promise<void>;
	recordManagementAudit(
		request: ApplicationApiCredentialReadRequestV1,
		action:
			| "application.credential.metadata.read"
			| "application.credential.revoked",
		credentialIds: readonly string[],
	): Promise<void>;
}
export interface ApplicationApiCredentialManagementStoreV1 {
	execute<T>(
		work: (tx: ApplicationApiCredentialManagementTransactionV1) => Promise<T>,
	): Promise<T>;
}

export function createApplicationApiCredentialManagementV1(input: {
	readonly store: ApplicationApiCredentialManagementStoreV1;
	readonly userDirectory: TaskUserDirectoryV1;
}) {
	function parseRequest(
		value: ApplicationApiCredentialRequestV1,
	): ApplicationApiCredentialRequestV1 {
		const snapshot = snapshotAgentManagementDataObject(value);
		requireAgentManagementExactKeys(snapshot, [
			"applicationId",
			"userId",
			"requestId",
			"traceId",
			"idempotencyKey",
		]);
		if (!isAgentManagementText(snapshot.applicationId))
			throw new ApplicationApiCredentialErrorV1("invalid_input");
		const { applicationId, ...personal } = snapshot;
		return { ...parsePersonalApiCredentialRequestV1(personal), applicationId };
	}
	async function execute<T>(
		request: ApplicationApiCredentialRequestV1,
		work: (tx: ApplicationApiCredentialManagementTransactionV1) => Promise<T>,
	): Promise<T> {
		try {
			return await input.store.execute(async (tx) => {
				if (await tx.lockUserDisabled(request.userId))
					throw new ApplicationApiCredentialErrorV1("forbidden");
				const first = await resolveCurrentPersonalApiUserV1(
					input.userDirectory,
					request.userId,
				);
				requirePersonalApiUserActiveV1(first);
				const application = await tx.lockApplication(request.applicationId);
				if (!application || application.responsibleUserId !== request.userId)
					throw new ApplicationApiCredentialErrorV1("not_found");
				// Disabled applications remain manageable; only credential authentication is disabled.
				const result = await work(tx);
				const current = await resolveCurrentPersonalApiUserV1(
					input.userDirectory,
					request.userId,
				);
				requirePersonalApiUserActiveV1(current);
				if (current.authorizationRevision !== first.authorizationRevision)
					throw new ApplicationApiCredentialErrorV1("forbidden");
				return result;
			});
		} catch (error) {
			if (error instanceof ApplicationApiCredentialErrorV1) throw error;
			if (error instanceof PersonalApiCredentialErrorV1)
				throw new ApplicationApiCredentialErrorV1(
					error.code === "authentication_required" ? "forbidden" : error.code,
				);
			throw new ApplicationApiCredentialErrorV1("unavailable");
		}
	}
	return {
		async list(
			requestInput: ApplicationApiCredentialReadRequestV1,
			queryInput: unknown,
		): Promise<ApplicationApiCredentialPageV1> {
			let request: ApplicationApiCredentialRequestV1;
			let limit: number;
			let cursor: string | null;
			try {
				request = parseRequest({
					...requestInput,
					idempotencyKey: "metadata-read",
				});
				const query = snapshotAgentManagementDataObject(queryInput);
				if (
					Object.keys(query).some((key) => key !== "limit" && key !== "cursor")
				)
					throw new Error();
				const requestedLimit = query.limit ?? 20;
				if (
					typeof requestedLimit !== "number" ||
					!Number.isInteger(requestedLimit) ||
					requestedLimit < 1 ||
					requestedLimit > 100
				)
					throw new Error();
				if (query.cursor !== undefined && !isAgentManagementText(query.cursor))
					throw new Error();
				limit = requestedLimit;
				cursor = (query.cursor as string | undefined) ?? null;
			} catch {
				throw new ApplicationApiCredentialErrorV1("invalid_input");
			}
			return execute(request, async (tx) => {
				const rows = await tx.listCredentials(
					request.applicationId,
					limit + 1,
					cursor,
				);
				const items = rows
					.slice(0, limit)
					.map((row) => ({ ...row, applicationId: request.applicationId }));
				await tx.recordManagementAudit(
					request,
					"application.credential.metadata.read",
					items.map((row) => row.credentialId),
				);
				return {
					items,
					nextCursor:
						rows.length > limit ? (items.at(-1)?.credentialId ?? null) : null,
				};
			});
		},
		async revoke(
			requestInput: ApplicationApiCredentialRequestV1,
			credentialIdInput: unknown,
		): Promise<ApplicationApiCredentialRevocationV1> {
			let request: ApplicationApiCredentialRequestV1;
			try {
				request = parseRequest(requestInput);
			} catch {
				throw new ApplicationApiCredentialErrorV1("invalid_input");
			}
			if (!isAgentManagementText(credentialIdInput))
				throw new ApplicationApiCredentialErrorV1("invalid_input");
			const credentialId = credentialIdInput;
			return execute(request, async (tx) => {
				const credential = await tx.lockCredential(
					request.applicationId,
					credentialId,
				);
				if (!credential) throw new ApplicationApiCredentialErrorV1("not_found");
				const savedId = await tx.lockRevocation(request);
				if (savedId !== null && savedId !== credentialId)
					throw new ApplicationApiCredentialErrorV1("idempotency_conflict");
				let revokedAt = credential.revokedAt;
				if (revokedAt === null) {
					revokedAt = (await tx.databaseTime()).toISOString();
					await tx.revokeCredential(credentialId, revokedAt);
				}
				if (savedId === null) {
					await tx.saveRevocation(request, credentialId);
					await tx.recordManagementAudit(
						request,
						"application.credential.revoked",
						[credentialId],
					);
				}
				return {
					metadata: {
						...credential,
						revokedAt,
						applicationId: request.applicationId,
					},
					replayed: savedId !== null,
				};
			});
		},
	};
}
