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
	| "api.credential.revoked"
	| "api.credential.narrowed";

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

/** PATCH only restricts existing material; it never issues replacement material. */
export interface PersonalApiCredentialNarrowingV1 {
	readonly scopes?: readonly PersonalApiCredentialScopeV1[];
	readonly expiresAt?: string;
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
	readonly action:
		| PersonalApiCredentialMutationV1
		| "api.credential.metadata.read";
	readonly outcome: "succeeded" | "failed" | "rejected";
	readonly details: {
		readonly reason?: PersonalApiCredentialErrorCodeV1;
		readonly scopes?: readonly PersonalApiCredentialScopeV1[];
		readonly expiresAt?: string | null;
		readonly returnedCredentialIds?: readonly string[];
	};
}

export interface PersonalApiCredentialListV1 {
	readonly limit: number;
	readonly cursor?: string;
}

export interface PersonalApiCredentialPageV1 {
	readonly items: readonly PersonalApiCredentialMetadataV1[];
	readonly nextCursor: string | null;
}

/** Operations available only inside one personal credential transaction. */
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
	/** Personal owner predicate and deterministic ID ordering apply before projection. */
	listCredentials(
		userId: string,
		limit: number,
		afterId: string | null,
	): Promise<readonly PersonalApiCredentialMetadataV1[]>;
	narrowCredential(
		credentialId: string,
		input: PersonalApiCredentialIssuanceV1,
	): Promise<PersonalApiCredentialMetadataV1>;
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
	narrow(
		request: PersonalApiCredentialRequestV1,
		credentialId: string,
		input: unknown,
	): Promise<{
		readonly metadata: PersonalApiCredentialMetadataV1;
		readonly replayed: boolean;
	}>;
	list(
		request: Pick<
			PersonalApiCredentialRequestV1,
			"userId" | "requestId" | "traceId"
		>,
		input: unknown,
	): Promise<PersonalApiCredentialPageV1>;
	/** The optional actor is supplied only after the HTTP identity boundary succeeds. */
	recordRefusal(
		metadata: Pick<PersonalApiCredentialRequestV1, "requestId" | "traceId">,
		action: PersonalApiCredentialMutationV1 | "api.credential.metadata.read",
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

function parsePersonalApiCredentialExpiryV1(expiresAt: unknown): string | null {
	if (
		expiresAt !== null &&
		(typeof expiresAt !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiresAt) ||
			!Number.isFinite(Date.parse(expiresAt)) ||
			new Date(expiresAt).toISOString().slice(0, 19) !== expiresAt.slice(0, 19))
	) {
		throw new Error();
	}
	return expiresAt === null ? null : new Date(expiresAt).toISOString();
}

export function parsePersonalApiCredentialIssuanceV1(
	input: unknown,
): PersonalApiCredentialIssuanceV1 {
	try {
		const value = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(value, ["scopes", "expiresAt"]);
		const expiresAt = parsePersonalApiCredentialExpiryV1(value.expiresAt);
		return Object.freeze({
			scopes: parsePersonalApiCredentialScopesV1(value.scopes),
			expiresAt,
		});
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

/** Snapshot all PATCH fields before identity/transaction awaits. */
export function parsePersonalApiCredentialNarrowingV1(
	input: unknown,
): PersonalApiCredentialNarrowingV1 {
	try {
		const values = snapshotAgentManagementDataObject(input);
		const keys = Object.keys(values);
		if (
			keys.length === 0 ||
			keys.some((key) => key !== "scopes" && key !== "expiresAt")
		)
			throw new Error();
		const scopes = Object.hasOwn(values, "scopes")
			? parsePersonalApiCredentialScopesV1(values.scopes)
			: undefined;
		const expiresAt = Object.hasOwn(values, "expiresAt")
			? parsePersonalApiCredentialExpiryV1(values.expiresAt)
			: undefined;
		// Null would remove the deadline and is never a narrowing operation.
		if (expiresAt === null) throw new Error();
		return Object.freeze({
			...(scopes === undefined ? {} : { scopes }),
			...(expiresAt === undefined ? {} : { expiresAt }),
		});
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

/** Scope and expiry are intersected with the currently locked credential. */
export function requirePersonalApiCredentialNarrowingV1(
	current: PersonalApiCredentialMetadataV1,
	command: PersonalApiCredentialNarrowingV1,
): PersonalApiCredentialIssuanceV1 {
	const scopes = parsePersonalApiCredentialScopesV1(current.scopes);
	if (
		command.scopes?.some((scope) => !scopes.includes(scope)) ||
		(command.expiresAt !== undefined &&
			current.expiresAt !== null &&
			Date.parse(command.expiresAt) > Date.parse(current.expiresAt))
	) {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
	if (
		current.expiresAt !== null &&
		!Number.isFinite(Date.parse(current.expiresAt))
	) {
		throw new PersonalApiCredentialErrorV1("unavailable");
	}
	return Object.freeze({
		scopes: command.scopes ?? scopes,
		expiresAt: command.expiresAt ?? current.expiresAt,
	});
}

function parsePersonalApiCredentialListV1(
	input: unknown,
): PersonalApiCredentialListV1 {
	try {
		const values = snapshotAgentManagementDataObject(input);
		if (Object.keys(values).some((key) => key !== "limit" && key !== "cursor"))
			throw new Error();
		const limit = Object.hasOwn(values, "limit") ? values.limit : 20;
		if (
			typeof limit !== "number" ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new Error();
		if (
			Object.hasOwn(values, "cursor") &&
			(typeof values.cursor !== "string" ||
				!/^[A-Za-z0-9_-]{1,4096}$/.test(values.cursor))
		)
			throw new Error();
		return Object.freeze({
			limit,
			...(Object.hasOwn(values, "cursor")
				? { cursor: values.cursor as string }
				: {}),
		});
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

function cursorFingerprint(userId: string, limit: number): string {
	return createHash("sha256")
		.update(JSON.stringify(["personal_api_credential", userId, limit]))
		.digest("hex");
}

function decodePersonalCredentialCursor(
	input: PersonalApiCredentialListV1,
	userId: string,
): string | null {
	if (input.cursor === undefined) return null;
	try {
		const bytes = Buffer.from(input.cursor, "base64url");
		if (bytes.toString("base64url") !== input.cursor) throw new Error();
		const cursor = snapshotAgentManagementDataObject(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		);
		requireAgentManagementExactKeys(cursor, [
			"version",
			"fingerprint",
			"credentialId",
		]);
		if (
			cursor.version !== 1 ||
			cursor.fingerprint !== cursorFingerprint(userId, input.limit)
		)
			throw new Error();
		return parsePersonalApiCredentialIdV1(cursor.credentialId);
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
		action: PersonalApiCredentialMutationV1 | "api.credential.metadata.read",
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
		action: PersonalApiCredentialMutationV1 | "api.credential.metadata.read",
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
		async narrow(context, credentialId, input) {
			const request = parsePersonalApiCredentialRequestV1(context);
			const snapshot = snapshotCommand(() => ({
				credentialId: parsePersonalApiCredentialIdV1(credentialId),
				command: parsePersonalApiCredentialNarrowingV1(input),
			}));
			return execute(
				request,
				"api.credential.narrowed",
				async (transaction, ownCredential) => {
					if (snapshot instanceof PersonalApiCredentialErrorV1) throw snapshot;
					const digest = platformIdempotencyV1.canonicalRequestDigest(snapshot);
					const replayId = await replayCredentialId(
						transaction,
						request,
						"api.credential.narrowed",
						digest,
					);
					if (replayId !== null && replayId !== snapshot.credentialId)
						throw new PersonalApiCredentialErrorV1("unavailable");
					const current = await ownCredential(snapshot.credentialId);
					if (replayId !== null)
						return { result: { metadata: current, replayed: true } };
					const restricted = requirePersonalApiCredentialNarrowingV1(
						current,
						snapshot.command,
					);
					const metadata = await transaction.narrowCredential(
						snapshot.credentialId,
						restricted,
					);
					await complete(
						transaction,
						request,
						"api.credential.narrowed",
						digest,
						metadata,
					);
					return { result: { metadata, replayed: false } };
				},
			);
		},
		async list(context, input) {
			const values = snapshotAgentManagementDataObject(context);
			requireAgentManagementExactKeys(values, [
				"userId",
				"requestId",
				"traceId",
			]);
			const request = parsePersonalApiCredentialRequestV1({
				...values,
				idempotencyKey: "unkeyed",
			});
			const snapshot = snapshotCommand(() =>
				parsePersonalApiCredentialListV1(input),
			);
			return execute(
				request,
				"api.credential.metadata.read",
				async (transaction) => {
					if (snapshot instanceof PersonalApiCredentialErrorV1) throw snapshot;
					const rows = await transaction.listCredentials(
						request.userId,
						snapshot.limit + 1,
						decodePersonalCredentialCursor(snapshot, request.userId),
					);
					const items = rows.slice(0, snapshot.limit);
					const last = items.at(-1);
					const nextCursor =
						rows.length > snapshot.limit && last
							? Buffer.from(
									JSON.stringify({
										version: 1,
										fingerprint: cursorFingerprint(
											request.userId,
											snapshot.limit,
										),
										credentialId: last.credentialId,
									}),
								).toString("base64url")
							: null;
					await transaction.recordAudit({
						requestId: request.requestId,
						traceId: request.traceId,
						userId: request.userId,
						credentialId: null,
						action: "api.credential.metadata.read",
						outcome: "succeeded",
						details: {
							returnedCredentialIds: items.map((item) => item.credentialId),
						},
					});
					return { result: { items, nextCursor } };
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
