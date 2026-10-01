import { randomUUID } from "node:crypto";
import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	type ApplicationMetadataV1,
	type ApplicationRegistrationErrorCodeV1,
	ApplicationRegistrationErrorV1,
	type ApplicationRegistrationRequestV1,
	type ApplicationRegistrationStoreV1,
} from "./application-registration-contract.js";
import { platformIdempotencyV1 } from "./idempotency.js";
import {
	PersonalApiCredentialErrorV1,
	requirePersonalApiUserActiveV1,
	requirePersonalApiUserEnabledV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";
import type { TaskUserDirectoryV1 } from "./task-authorization.js";

export * from "./application-registration-contract.js";

function snapshot(input: unknown, keys: readonly string[]) {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, keys);
	return value;
}
function text(input: unknown): string {
	if (!isAgentManagementText(input)) throw new Error();
	return input;
}
function name(input: unknown): string {
	const value = text(input);
	if (value.length > 200 || value.trim().length === 0) throw new Error();
	return value;
}
function parseMetadata(input: unknown): ApplicationMetadataV1 {
	const value = snapshot(input, [
		"applicationId",
		"name",
		"responsibleUserId",
		"status",
		"authorizationRevision",
		"createdAt",
		"updatedAt",
	]);
	if (value.status !== "active" && value.status !== "disabled")
		throw new Error();
	const createdAt = text(value.createdAt);
	const updatedAt = text(value.updatedAt);
	if (
		![createdAt, updatedAt].every((date) => Number.isFinite(Date.parse(date)))
	)
		throw new Error();
	return {
		applicationId: text(value.applicationId),
		name: name(value.name),
		responsibleUserId: text(value.responsibleUserId),
		status: value.status,
		authorizationRevision: text(value.authorizationRevision),
		createdAt,
		updatedAt,
	};
}

export function createApplicationRegistrationUseCaseV1(dependencies: {
	readonly store: ApplicationRegistrationStoreV1;
	readonly userDirectory: TaskUserDirectoryV1;
}) {
	async function recordRefusal(
		metadata: Pick<ApplicationRegistrationRequestV1, "requestId" | "traceId">,
		reason: ApplicationRegistrationErrorCodeV1,
		userId: string | null = null,
	): Promise<void> {
		try {
			await dependencies.store.recordAudit({
				...metadata,
				userId,
				applicationId: null,
				action: "application.registered",
				outcome: reason === "unavailable" ? "failed" : "rejected",
				details: { reason },
			});
		} catch {
			/* Refusal remains refusal when the audit dependency is unavailable. */
		}
	}
	return {
		recordRefusal,
		async register(
			context: ApplicationRegistrationRequestV1,
			idempotencyKey: string,
			input: unknown,
		): Promise<{ metadata: ApplicationMetadataV1; replayed: boolean }> {
			let command: { name: string; key: string } | null = null;
			try {
				const value = snapshot(input, ["name"]);
				if (
					typeof idempotencyKey !== "string" ||
					!/^[A-Za-z0-9._~-]{1,128}$/.test(idempotencyKey)
				)
					throw new Error();
				command = { name: name(value.name), key: idempotencyKey };
			} catch {
				/* Report invalid input only after current identity admission. */
			}
			let request: ApplicationRegistrationRequestV1;
			try {
				const values = snapshot(context, ["userId", "requestId", "traceId"]);
				request = {
					userId: text(values.userId),
					requestId: text(values.requestId),
					traceId: text(values.traceId),
				};
			} catch {
				throw new ApplicationRegistrationErrorV1("invalid_input");
			}
			try {
				return await dependencies.store.execute(async (transaction) => {
					requirePersonalApiUserEnabledV1(
						await transaction.lockUserDisabled(request.userId),
					);
					const first = await resolveCurrentPersonalApiUserV1(
						dependencies.userDirectory,
						request.userId,
					);
					requirePersonalApiUserActiveV1(first);
					if (command === null)
						throw new ApplicationRegistrationErrorV1("invalid_input");
					const digest = platformIdempotencyV1.canonicalRequestDigest({
						name: command.name,
					});
					const prior = await transaction.lockIdempotency(request, command.key);
					let metadata: ApplicationMetadataV1;
					if (prior !== null) {
						if (prior.requestDigest !== digest)
							throw new ApplicationRegistrationErrorV1("idempotency_conflict");
						if (prior.status !== "completed")
							throw new ApplicationRegistrationErrorV1("unavailable");
						metadata = parseMetadata(prior.result);
						const own = await transaction.readOwn(
							metadata.applicationId,
							request.userId,
						);
						if (own === null)
							throw new ApplicationRegistrationErrorV1("not_found");
						if (
							parseMetadata(own).responsibleUserId !== request.userId ||
							metadata.responsibleUserId !== request.userId
						)
							throw new ApplicationRegistrationErrorV1("unavailable");
					} else {
						const applicationId = `app_${randomUUID()}`;
						metadata = parseMetadata(
							await transaction.insert({
								applicationId,
								name: command.name,
								responsibleUserId: request.userId,
								authorizationRevision: randomUUID(),
							}),
						);
						if (
							metadata.applicationId !== applicationId ||
							metadata.responsibleUserId !== request.userId ||
							metadata.status !== "active" ||
							metadata.name !== command.name
						)
							throw new ApplicationRegistrationErrorV1("unavailable");
						await transaction.completeIdempotency(
							request,
							command.key,
							digest,
							metadata,
						);
					}
					await transaction.recordAudit({
						...request,
						applicationId: metadata.applicationId,
						action: "application.registered",
						outcome: "succeeded",
						details: { replayed: prior !== null },
					});
					// Final directory check follows every persistence/audit await. The disable
					// lock and application row lock remain held through transaction commit.
					const current = await resolveCurrentPersonalApiUserV1(
						dependencies.userDirectory,
						request.userId,
					);
					requirePersonalApiUserActiveV1(current);
					if (current.authorizationRevision !== first.authorizationRevision)
						throw new ApplicationRegistrationErrorV1("unavailable");
					return { metadata, replayed: prior !== null };
				});
			} catch (error) {
				const failure =
					error instanceof ApplicationRegistrationErrorV1
						? error
						: new ApplicationRegistrationErrorV1(
								error instanceof PersonalApiCredentialErrorV1
									? error.code
									: "unavailable",
							);
				await recordRefusal(request, failure.code, request.userId);
				throw failure;
			}
		},
	};
}
export type ApplicationRegistrationUseCaseV1 = ReturnType<
	typeof createApplicationRegistrationUseCaseV1
>;
