import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	isAgentManagementText,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
	snapshotAgentManagementDenseArray,
} from "./agent-management-input.js";
import { platformIdempotencyV1 } from "./idempotency.js";
import {
	type CurrentTaskUserV1,
	parseCurrentTaskUserV1,
	type TaskUserDirectoryV1,
} from "./task-authorization.js";

export const personalApiCredentialScopesV1 = [
	"agent:create",
	"agent:manage",
	"agent:use",
	"agent:read",
] as const;

export type PersonalApiCredentialScopeV1 =
	(typeof personalApiCredentialScopesV1)[number];

export type PersonalApiCredentialMutationV1 =
	| "api.credential.issued"
	| "api.credential.revoked";

export type PersonalApiCredentialErrorCodeV1 =
	| "invalid_input"
	| "authentication_required"
	| "forbidden"
	| "not_found"
	| "idempotency_conflict"
	| "unavailable";

export class PersonalApiCredentialErrorV1 extends Error {
	constructor(readonly code: PersonalApiCredentialErrorCodeV1) {
		super("Personal API credential operation failed");
		this.name = "PersonalApiCredentialErrorV1";
	}
}

export interface PersonalApiCredentialIssuanceV1 {
	readonly scopes: readonly PersonalApiCredentialScopeV1[];
	readonly expiresAt: string | null;
}

export interface PersonalApiCredentialMetadataV1 {
	readonly credentialId: string;
	readonly scopes: readonly PersonalApiCredentialScopeV1[];
	readonly expiresAt: string | null;
	readonly revokedAt: string | null;
	readonly createdAt: string;
	readonly lastUsedAt: string | null;
}

export interface PersonalApiCredentialRequestV1 {
	/** Supplied only by the server's trusted browser identity boundary. */
	readonly userId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface PersonalApiCredentialIssueResultV1 {
	readonly metadata: PersonalApiCredentialMetadataV1;
	readonly credential: string | null;
	readonly replayed: boolean;
}

export interface PersonalApiCredentialAuditV1 {
	readonly requestId: string;
	readonly traceId: string;
	readonly userId: string | null;
	readonly credentialId: string | null;
	readonly action: PersonalApiCredentialMutationV1;
	readonly outcome: "succeeded" | "failed" | "rejected";
	readonly details: {
		readonly reason?: PersonalApiCredentialErrorCodeV1;
		readonly scopes?: readonly PersonalApiCredentialScopeV1[];
		readonly expiresAt?: string | null;
	};
}

/** Operations available only inside one issuance/revocation transaction. */
export interface PersonalApiCredentialTransactionV1 {
	lockUserDisabled(userId: string): Promise<boolean>;
	databaseTime(): Promise<Date>;
	lockIdempotency(
		request: PersonalApiCredentialRequestV1,
		action: PersonalApiCredentialMutationV1,
	): Promise<{
		readonly requestDigest: string;
		readonly status: string;
		readonly result: unknown;
	} | null>;
	/** Lock only this caller's personal credential; other owners and missing IDs are null. */
	lockCredential(
		credentialId: string,
		userId: string,
	): Promise<PersonalApiCredentialMetadataV1 | null>;
	insertCredential(input: {
		readonly credentialId: string;
		readonly userId: string;
		readonly credentialHash: string;
		readonly scopes: readonly PersonalApiCredentialScopeV1[];
		readonly expiresAt: string | null;
	}): Promise<PersonalApiCredentialMetadataV1>;
	revokeCredential(
		credentialId: string,
		revokedAt: string,
	): Promise<PersonalApiCredentialMetadataV1>;
	completeIdempotency(
		request: PersonalApiCredentialRequestV1,
		action: PersonalApiCredentialMutationV1,
		requestDigest: string,
		credentialId: string,
	): Promise<void>;
	recordAudit(event: PersonalApiCredentialAuditV1): Promise<void>;
}

export interface PersonalApiCredentialTransactionPortV1 {
	/** Resolve only after commit; a failed commit must never deliver material. */
	execute<T>(
		work: (transaction: PersonalApiCredentialTransactionV1) => Promise<T>,
	): Promise<T>;
	recordAudit(event: PersonalApiCredentialAuditV1): Promise<void>;
}

export interface PersonalApiCredentialUseCaseV1 {
	issue(
		request: PersonalApiCredentialRequestV1,
		input: unknown,
	): Promise<PersonalApiCredentialIssueResultV1>;
	revoke(
		request: PersonalApiCredentialRequestV1,
		credentialId: string,
	): Promise<{
		readonly metadata: PersonalApiCredentialMetadataV1;
		readonly replayed: boolean;
	}>;
	/** The optional actor is supplied only after the HTTP identity boundary succeeds. */
	recordRefusal(
		metadata: Pick<PersonalApiCredentialRequestV1, "requestId" | "traceId">,
		action: PersonalApiCredentialMutationV1,
		reason: PersonalApiCredentialErrorCodeV1,
		trustedUserId?: string,
	): Promise<void>;
}

export function parsePersonalApiCredentialIdV1(input: unknown): string {
	if (!isAgentManagementText(input)) {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
	return input;
}

export function parsePersonalApiCredentialScopesV1(
	input: unknown,
): readonly PersonalApiCredentialScopeV1[] {
	try {
		const scopes = snapshotAgentManagementDenseArray(input, 4);
		if (
			scopes.length === 0 ||
			new Set(scopes).size !== scopes.length ||
			scopes.some(
				(scope) =>
					typeof scope !== "string" ||
					!personalApiCredentialScopesV1.includes(
						scope as PersonalApiCredentialScopeV1,
					),
			)
		) {
			throw new Error();
		}
		return Object.freeze((scopes as PersonalApiCredentialScopeV1[]).toSorted());
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function parsePersonalApiCredentialIssuanceV1(
	input: unknown,
): PersonalApiCredentialIssuanceV1 {
	try {
		const value = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(value, ["scopes", "expiresAt"]);
		const expiresAt = value.expiresAt;
		if (
			expiresAt !== null &&
			(typeof expiresAt !== "string" ||
				!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
					expiresAt,
				) ||
				!Number.isFinite(Date.parse(expiresAt)) ||
				new Date(expiresAt).toISOString().slice(0, 19) !==
					expiresAt.slice(0, 19))
		) {
			throw new Error();
		}
		return Object.freeze({
			scopes: parsePersonalApiCredentialScopesV1(value.scopes),
			expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
		});
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function parsePersonalApiCredentialRequestV1(
	input: unknown,
): PersonalApiCredentialRequestV1 {
	try {
		const value = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(value, [
			"userId",
			"idempotencyKey",
			"requestId",
			"traceId",
		]);
		if (
			![value.userId, value.requestId, value.traceId].every((item) =>
				isAgentManagementText(item),
			) ||
			!isAgentManagementText(value.idempotencyKey, 128) ||
			!/^[A-Za-z0-9._~-]{1,128}$/.test(value.idempotencyKey)
		) {
			throw new Error();
		}
		return Object.freeze({
			userId: value.userId as string,
			idempotencyKey: value.idempotencyKey,
			requestId: value.requestId as string,
			traceId: value.traceId as string,
		});
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function personalApiCredentialIssuanceDigestV1(
	input: PersonalApiCredentialIssuanceV1,
): string {
	return platformIdempotencyV1.canonicalRequestDigest({
		scopes: input.scopes,
		expiresAt: input.expiresAt,
	});
}

export function requirePersonalApiCredentialFutureExpiryV1(
	input: Pick<PersonalApiCredentialIssuanceV1, "expiresAt">,
	databaseTime: Date,
): void {
	if (!Number.isFinite(databaseTime.getTime())) {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
	if (
		input.expiresAt !== null &&
		Date.parse(input.expiresAt) <= databaseTime.getTime()
	) {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function requirePersonalApiUserEnabledV1(disabled: boolean): void {
	if (disabled) throw new PersonalApiCredentialErrorV1("forbidden");
}

export function requirePersonalApiUserActiveV1(user: CurrentTaskUserV1): void {
	if (user.accountStatus !== "active") {
		throw new PersonalApiCredentialErrorV1("forbidden");
	}
}

/** Resolve again within the Store transaction; a saved browser Request is not authority. */
export async function resolveCurrentPersonalApiUserV1(
	directory: TaskUserDirectoryV1 | undefined,
	userId: string,
): Promise<CurrentTaskUserV1> {
	try {
		if (!directory || !isAgentManagementText(userId)) {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		const value = await directory.resolveUser(userId);
		if (value === null) throw new PersonalApiCredentialErrorV1("forbidden");
		const user = parseCurrentTaskUserV1(value);
		if (user.userId !== userId) {
			throw new PersonalApiCredentialErrorV1("unavailable");
		}
		return user;
	} catch (error) {
		if (error instanceof PersonalApiCredentialErrorV1) throw error;
		// Identity dependency errors may contain confidential upstream payloads.
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

function snapshotCommand<T>(parse: () => T): T | PersonalApiCredentialErrorV1 {
	try {
		return parse();
	} catch {
		return new PersonalApiCredentialErrorV1("invalid_input");
	}
}

async function replayCredentialId(
	transaction: PersonalApiCredentialTransactionV1,
	request: PersonalApiCredentialRequestV1,
	action: PersonalApiCredentialMutationV1,
	digest: string,
): Promise<string | null> {
	const row = await transaction.lockIdempotency(request, action);
	if (row === null) return null;
	if (row.requestDigest !== digest) {
		throw new PersonalApiCredentialErrorV1("idempotency_conflict");
	}
	try {
		const result = snapshotAgentManagementDataObject(row.result);
		requireAgentManagementExactKeys(result, ["credentialId"]);
		if (row.status !== "completed") throw new Error();
		return parsePersonalApiCredentialIdV1(result.credentialId);
	} catch {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
}

export function createPersonalApiCredentialUseCaseV1(dependencies: {
	readonly transaction: PersonalApiCredentialTransactionPortV1;
	readonly userDirectory: TaskUserDirectoryV1;
}): PersonalApiCredentialUseCaseV1 {
	const port = dependencies.transaction;
	async function refusal(
		request: Pick<PersonalApiCredentialRequestV1, "requestId" | "traceId">,
		action: PersonalApiCredentialMutationV1,
		reason: PersonalApiCredentialErrorCodeV1,
		evidence: { userId: string | null; credentialId: string | null },
	): Promise<void> {
		try {
			await port.recordAudit({
				requestId: request.requestId,
				traceId: request.traceId,
				...evidence,
				action,
				outcome: reason === "unavailable" ? "failed" : "rejected",
				details: { reason },
			});
		} catch {
			// A failed refusal audit must never turn a refusal into permission.
		}
	}
	async function execute<T>(
		request: PersonalApiCredentialRequestV1,
		action: PersonalApiCredentialMutationV1,
		work: (
			transaction: PersonalApiCredentialTransactionV1,
			ownCredential: (id: string) => Promise<PersonalApiCredentialMetadataV1>,
		) => Promise<{ result: T; firstIssueExpiresAt?: string | null }>,
	): Promise<T> {
		const evidence: { userId: string | null; credentialId: string | null } = {
			// Governance Requests arrive only after the trusted browser identity boundary.
			// Current-state refusal does not erase that confirmed operation actor.
			userId: request.userId,
			credentialId: null,
		};
		try {
			return await port.execute(async (transaction) => {
				requirePersonalApiUserEnabledV1(
					await transaction.lockUserDisabled(request.userId),
				);
				const first = await resolveCurrentPersonalApiUserV1(
					dependencies.userDirectory,
					request.userId,
				);
				requirePersonalApiUserActiveV1(first);
				const result = await work(transaction, async (id) => {
					const row = await transaction.lockCredential(id, request.userId);
					if (row === null) {
						throw new PersonalApiCredentialErrorV1("not_found");
					}
					if (row.credentialId !== id) {
						throw new PersonalApiCredentialErrorV1("unavailable");
					}
					evidence.credentialId = row.credentialId;
					return row;
				});
				const current = await resolveCurrentPersonalApiUserV1(
					dependencies.userDirectory,
					request.userId,
				);
				requirePersonalApiUserActiveV1(current);
				if (current.authorizationRevision !== first.authorizationRevision) {
					throw new PersonalApiCredentialErrorV1("unavailable");
				}
				if (result.firstIssueExpiresAt != null) {
					requirePersonalApiCredentialFutureExpiryV1(
						{ expiresAt: result.firstIssueExpiresAt },
						await transaction.databaseTime(),
					);
				}
				return result.result;
			});
		} catch (error) {
			const failure =
				error instanceof PersonalApiCredentialErrorV1
					? error
					: new PersonalApiCredentialErrorV1("unavailable");
			await refusal(request, action, failure.code, evidence);
			throw failure;
		}
	}
	async function complete(
		transaction: PersonalApiCredentialTransactionV1,
		request: PersonalApiCredentialRequestV1,
		action: PersonalApiCredentialMutationV1,
		digest: string,
		metadata: PersonalApiCredentialMetadataV1,
	): Promise<void> {
		await transaction.recordAudit({
			requestId: request.requestId,
			traceId: request.traceId,
			userId: request.userId,
			credentialId: metadata.credentialId,
			action,
			outcome: "succeeded",
			details: { scopes: metadata.scopes, expiresAt: metadata.expiresAt },
		});
		await transaction.completeIdempotency(
			request,
			action,
			digest,
			metadata.credentialId,
		);
	}
	return {
		async issue(context, input) {
			const request = parsePersonalApiCredentialRequestV1(context);
			const snapshot = snapshotCommand(() =>
				parsePersonalApiCredentialIssuanceV1(input),
			);
			return execute<PersonalApiCredentialIssueResultV1>(
				request,
				"api.credential.issued",
				async (transaction, ownCredential) => {
					if (snapshot instanceof PersonalApiCredentialErrorV1) throw snapshot;
					const digest = personalApiCredentialIssuanceDigestV1(snapshot);
					const replayId = await replayCredentialId(
						transaction,
						request,
						"api.credential.issued",
						digest,
					);
					if (replayId !== null) {
						return {
							result: {
								metadata: await ownCredential(replayId),
								credential: null,
								replayed: true,
							},
						};
					}
					requirePersonalApiCredentialFutureExpiryV1(
						snapshot,
						await transaction.databaseTime(),
					);
					const credential = `papi_${randomBytes(32).toString("base64url")}`;
					const metadata = await transaction.insertCredential({
						credentialId: `api_credential_${randomUUID()}`,
						userId: request.userId,
						credentialHash: createHash("sha256")
							.update(credential)
							.digest("hex"),
						...snapshot,
					});
					await complete(
						transaction,
						request,
						"api.credential.issued",
						digest,
						metadata,
					);
					return {
						result: { metadata, credential, replayed: false },
						firstIssueExpiresAt: snapshot.expiresAt,
					};
				},
			);
		},
		async revoke(context, credentialId) {
			const request = parsePersonalApiCredentialRequestV1(context);
			const snapshot = snapshotCommand(() =>
				parsePersonalApiCredentialIdV1(credentialId),
			);
			return execute<{
				metadata: PersonalApiCredentialMetadataV1;
				replayed: boolean;
			}>(
				request,
				"api.credential.revoked",
				async (transaction, ownCredential) => {
					if (snapshot instanceof PersonalApiCredentialErrorV1) throw snapshot;
					const digest = platformIdempotencyV1.canonicalRequestDigest({
						credentialId: snapshot,
					});
					const replayId = await replayCredentialId(
						transaction,
						request,
						"api.credential.revoked",
						digest,
					);
					if (replayId !== null && replayId !== snapshot) {
						throw new PersonalApiCredentialErrorV1("unavailable");
					}
					const current = await ownCredential(snapshot);
					if (replayId !== null)
						return { result: { metadata: current, replayed: true } };
					const revokedAt =
						current.revokedAt ??
						(await transaction.databaseTime()).toISOString();
					const metadata = await transaction.revokeCredential(
						snapshot,
						revokedAt,
					);
					await complete(
						transaction,
						request,
						"api.credential.revoked",
						digest,
						metadata,
					);
					return { result: { metadata, replayed: false } };
				},
			);
		},
		async recordRefusal(metadata, action, reason, trustedUserId) {
			const request = parsePersonalApiCredentialRequestV1({
				...metadata,
				userId: trustedUserId ?? "unknown",
				idempotencyKey: "unkeyed",
			});
			await refusal(
				{ requestId: request.requestId, traceId: request.traceId },
				action,
				reason,
				{
					userId: trustedUserId === undefined ? null : request.userId,
					credentialId: null,
				},
			);
		},
	};
}
