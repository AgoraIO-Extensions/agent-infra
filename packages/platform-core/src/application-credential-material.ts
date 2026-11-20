import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type ApplicationApiCredentialCommandV1,
	ApplicationApiCredentialErrorV1,
	type ApplicationApiCredentialRequestV1,
	type ApplicationApiCredentialTransactionV1,
	type ApplicationCredentialDeliveryReceiptV1,
	parseApplicationApiCredentialCommandV1,
} from "./application-api-credentials.js";
import { authorizeApplicationCredentialDeliveryV1 } from "./application-credential-authority.js";
import { platformIdempotencyV1 } from "./idempotency.js";
import {
	PersonalApiCredentialErrorV1,
	type PersonalApiCredentialScopeV1,
	requirePersonalApiCredentialFutureExpiryV1,
	requirePersonalApiUserActiveV1,
	resolveCurrentPersonalApiUserV1,
} from "./personal-api-credentials.js";
import type { TaskUserDirectoryV1 } from "./task-authorization.js";

export interface ApplicationCredentialMaterialConfigurationV1 {
	readonly schemaVersion: 1;
	readonly enabled: boolean;
	readonly publicOrigin?: string;
	readonly recipients?: readonly {
		readonly applicationId: string;
		readonly principalType: "user";
		readonly principalId: string;
	}[];
}
export type MaterialFailureReasonV1 =
	| "deadline_exceeded"
	| "authorization_changed"
	| "credential_changed"
	| "request_aborted"
	| "dependency_unavailable"
	| "claim_commit_unconfirmed"
	| "generation_failed"
	| "generation_commit_unconfirmed"
	| "transport_failed"
	| "transmission_failed"
	| "transmission_commit_unconfirmed"
	| "confirmation_failed"
	| "confirmation_commit_unconfirmed";
class MaterialFailure extends ApplicationApiCredentialErrorV1 {
	constructor(readonly reason: MaterialFailureReasonV1) {
		super("unavailable");
	}
}
export interface ApplicationCredentialMaterialRecordV1 {
	readonly failureReason?: MaterialFailureReasonV1 | null;
	readonly schemaVersion: 1;
	readonly managerUserId: string;
	readonly managerRevision: string;
	readonly recipientRevision: string | null;
	readonly idempotencyKey: string;
	readonly requestDigest: string;
	readonly command: ApplicationApiCredentialCommandV1;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly result: {
		readonly metadata: {
			readonly applicationId: string;
			readonly credentialId: string;
			readonly phase:
				| "pending"
				| "claimed"
				| "generated"
				| "transmitted"
				| "accepted";
			readonly fence: string | null;
		};
		readonly delivery: ApplicationCredentialDeliveryReceiptV1;
	};
}
export interface ApplicationCredentialMaterialMetadataV1 {
	readonly schemaVersion: 1;
	readonly applicationId: string;
	readonly credentialId: string;
	readonly attemptId: string;
	readonly recipient: ApplicationApiCredentialCommandV1["recipient"];
	readonly grantRevision: string;
	readonly scopes: readonly PersonalApiCredentialScopeV1[];
	readonly credentialExpiresAt: string | null;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly status: ApplicationCredentialDeliveryReceiptV1["status"];
	readonly phase: ApplicationCredentialMaterialRecordV1["result"]["metadata"]["phase"];
	readonly fence: string | null;
	readonly replayed: boolean;
}
export interface ApplicationCredentialMaterialTransactionV1
	extends Pick<
		ApplicationApiCredentialTransactionV1,
		| "databaseTime"
		| "lockUserDisabled"
		| "lockApplication"
		| "lockGrant"
		| "lockActiveCredential"
		| "insertCredential"
		| "revokeCredential"
	> {
	lockByKey(
		request: ApplicationApiCredentialRequestV1,
	): Promise<ApplicationCredentialMaterialRecordV1 | null>;
	lockByAttempt(
		applicationId: string,
		attemptId: string,
	): Promise<ApplicationCredentialMaterialRecordV1 | null>;
	save(record: ApplicationCredentialMaterialRecordV1): Promise<void>;
	audit(
		request: Pick<
			ApplicationApiCredentialRequestV1,
			"userId" | "requestId" | "traceId"
		>,
		record: ApplicationCredentialMaterialRecordV1,
		phase: string,
		outcome: "succeeded" | "failed" | "rejected",
	): Promise<void>;
}
export interface ApplicationCredentialMaterialStoreV1 {
	execute<T>(
		work: (tx: ApplicationCredentialMaterialTransactionV1) => Promise<T>,
	): Promise<T>;
	inspect(
		applicationId: string,
		attemptId: string,
	): Promise<ApplicationCredentialMaterialRecordV1 | null>;
}
export function applicationCredentialMaterialMetadataV1(
	record: ApplicationCredentialMaterialRecordV1,
	replayed = false,
): ApplicationCredentialMaterialMetadataV1 {
	const { metadata, delivery } = record.result;
	return {
		schemaVersion: 1,
		...metadata,
		...delivery,
		scopes: [...record.command.scopes],
		credentialExpiresAt: record.command.expiresAt,
		createdAt: record.createdAt,
		expiresAt: record.expiresAt,
		replayed,
	};
}
function validateApplicationCredentialMaterialConfigurationV1(
	value: ApplicationCredentialMaterialConfigurationV1 | undefined,
) {
	if (value === undefined) return undefined;
	if (
		!value ||
		value.schemaVersion !== 1 ||
		typeof value.enabled !== "boolean" ||
		Object.keys(value).some(
			(key) =>
				!["schemaVersion", "enabled", "publicOrigin", "recipients"].includes(
					key,
				),
		)
	)
		throw new Error("Application credential material configuration invalid");
	if (!value.enabled) return undefined;
	const origin = new URL(value.publicOrigin ?? "");
	if (
		origin.protocol !== "https:" ||
		origin.origin !== value.publicOrigin ||
		!value.recipients?.length ||
		value.recipients.length > 100
	)
		throw new Error("Application credential material configuration invalid");
	const recipients = value.recipients.map((recipient) => {
		if (
			Object.keys(recipient).sort().join() !==
				"applicationId,principalId,principalType" ||
			recipient.principalType !== "user" ||
			!recipient.applicationId?.trim() ||
			!recipient.principalId?.trim()
		)
			throw new Error("Application credential material recipient invalid");
		return JSON.stringify([
			recipient.applicationId,
			recipient.principalType,
			recipient.principalId,
		]);
	});
	if (new Set(recipients).size !== recipients.length)
		throw new Error("Application credential material recipients duplicated");
	return { publicOrigin: origin.origin, recipients: new Set(recipients) };
}
export type MaterialRequest = Pick<
	ApplicationApiCredentialRequestV1,
	"userId" | "requestId" | "traceId" | "applicationId"
> & { readonly attemptId: string; readonly signal?: AbortSignal };
function fail(code: ApplicationApiCredentialErrorV1["code"]): never {
	throw new ApplicationApiCredentialErrorV1(code);
}
function change(
	record: ApplicationCredentialMaterialRecordV1,
	phase: ApplicationCredentialMaterialMetadataV1["phase"],
	status: ApplicationCredentialDeliveryReceiptV1["status"],
	fence = record.result.metadata.fence,
): ApplicationCredentialMaterialRecordV1 {
	return {
		...record,
		result: {
			metadata: { ...record.result.metadata, phase, fence },
			delivery: { ...record.result.delivery, status },
		},
	};
}
export function createApplicationCredentialMaterialDeliveryV1(input: {
	readonly store: ApplicationCredentialMaterialStoreV1;
	readonly userDirectory: TaskUserDirectoryV1;
	readonly configuration?: ApplicationCredentialMaterialConfigurationV1;
}) {
	const policy = validateApplicationCredentialMaterialConfigurationV1(
		input.configuration,
	);
	function requireConfigured(
		applicationId: string,
		recipient: ApplicationApiCredentialCommandV1["recipient"],
	) {
		if (!policy) throw new ApplicationApiCredentialErrorV1("unavailable");
		if (
			!policy.recipients.has(
				JSON.stringify([
					applicationId,
					recipient.principalType,
					recipient.principalId,
				]),
			)
		)
			throw new ApplicationApiCredentialErrorV1("forbidden");
	}
	async function inspect(request: MaterialRequest, recipientOnly: boolean) {
		if (recipientOnly && !policy) fail("unavailable");
		const record = await input.store.inspect(
			request.applicationId,
			request.attemptId,
		);
		if (!record) fail("not_found");
		if (
			recipientOnly &&
			(record.command.recipient.principalType !== "user" ||
				record.command.recipient.principalId !== request.userId)
		)
			fail("not_found");
		if (recipientOnly)
			requireConfigured(request.applicationId, record.command.recipient);
		return record;
	}
	async function authorized(
		tx: ApplicationCredentialMaterialTransactionV1,
		request: MaterialRequest,
		snapshot: ApplicationCredentialMaterialRecordV1,
	) {
		const authority = await authorizeApplicationCredentialDeliveryV1(
			tx,
			input.userDirectory,
			{
				...request,
				userId: snapshot.managerUserId,
				idempotencyKey: snapshot.idempotencyKey,
			},
			snapshot.command.recipient,
		);
		const record = await tx.lockByAttempt(
			request.applicationId,
			request.attemptId,
		);
		if (
			!record ||
			record.managerUserId !== snapshot.managerUserId ||
			record.requestDigest !== snapshot.requestDigest
		)
			fail("unavailable");
		if (
			authority.manager.authorizationRevision !== record.managerRevision ||
			authority.recipientRevision !== record.recipientRevision ||
			authority.grant.authorizationRevision !==
				record.result.delivery.grantRevision
		)
			fail("forbidden");
		return record;
	}
	async function live(
		tx: ApplicationCredentialMaterialTransactionV1,
		record: ApplicationCredentialMaterialRecordV1,
		fence: string | null,
		signal?: AbortSignal,
	) {
		if ((await tx.databaseTime()).getTime() >= Date.parse(record.expiresAt))
			throw new MaterialFailure("deadline_exceeded");
		if (signal?.aborted) throw new MaterialFailure("request_aborted");
		if (
			!fence ||
			record.result.metadata.fence !== fence ||
			record.result.delivery.status !== "delivery_in_flight" ||
			(await tx.databaseTime()).getTime() >= Date.parse(record.expiresAt)
		)
			fail("unavailable");
	}
	async function expire(
		tx: ApplicationCredentialMaterialTransactionV1,
		request: MaterialRequest,
		record: ApplicationCredentialMaterialRecordV1,
	) {
		if (
			["delivery_pending", "delivery_in_flight"].includes(
				record.result.delivery.status,
			) &&
			(await tx.databaseTime()).getTime() >= Date.parse(record.expiresAt)
		) {
			const expired = {
				...change(
					record,
					record.result.metadata.phase,
					record.result.metadata.phase === "pending" ? "failed" : "unknown",
				),
				failureReason: "deadline_exceeded" as const,
			};
			await tx.save(expired);
			await tx.audit(request, expired, "expired", "failed");
			return expired;
		}
		return record;
	}
	function reasonFor(
		error: unknown,
		stage: "claim" | "generation" | "transmission",
		prepared: boolean,
		signal?: AbortSignal,
		written = false,
	): MaterialFailureReasonV1 {
		if (error instanceof MaterialFailure) return error.reason;
		if (
			error instanceof PersonalApiCredentialErrorV1 &&
			["forbidden", "authentication_required"].includes(error.code)
		)
			return "authorization_changed";
		if (
			error instanceof ApplicationApiCredentialErrorV1 &&
			error.code === "forbidden"
		)
			return "authorization_changed";
		if (
			error instanceof ApplicationApiCredentialErrorV1 &&
			error.code === "idempotency_conflict"
		)
			return "credential_changed";
		if (signal?.aborted) return "request_aborted";
		if (prepared) return `${stage}_commit_unconfirmed`;
		return stage === "claim"
			? "dependency_unavailable"
			: stage === "generation"
				? "generation_failed"
				: written
					? "transmission_failed"
					: "transport_failed";
	}
	async function recordFailure(
		request: MaterialRequest,
		snapshot: ApplicationCredentialMaterialRecordV1,
		fence: string | null,
		reason: MaterialFailureReasonV1,
	) {
		try {
			await input.store.execute(async (tx) => {
				await tx.lockUserDisabled(snapshot.managerUserId);
				await tx.lockApplication(request.applicationId);
				await tx.lockGrant(request.applicationId, snapshot.command.recipient);
				const saved = await tx.lockByAttempt(
					request.applicationId,
					request.attemptId,
				);
				if (
					!saved ||
					saved.result.delivery.status === "accepted" ||
					(saved.result.metadata.fence !== fence &&
						saved.result.metadata.phase !== "pending")
				)
					return;
				const failed = {
					...change(
						saved,
						saved.result.metadata.phase,
						fence === null && saved.result.metadata.phase === "pending"
							? "failed"
							: "unknown",
						saved.result.metadata.fence ?? fence,
					),
					failureReason: reason,
				};
				await tx.save(failed);
				await tx.audit(request, failed, "unknown", "failed");
			});
		} catch {
			/* Durable original claim remains non-replayable if reconciliation fails. */
		}
	}
	return {
		publicOrigin: policy?.publicOrigin,
		async read(request: MaterialRequest) {
			const snapshot = await inspect(request, false);
			return input.store.execute(async (tx) => {
				if (await tx.lockUserDisabled(request.userId)) fail("forbidden");
				const user = await resolveCurrentPersonalApiUserV1(
					input.userDirectory,
					request.userId,
				);
				requirePersonalApiUserActiveV1(user);
				const app = await tx.lockApplication(request.applicationId);
				if (!app) fail("not_found");
				if (app.responsibleUserId !== request.userId) {
					if (
						snapshot.command.recipient.principalType !== "user" ||
						snapshot.command.recipient.principalId !== request.userId
					)
						fail("not_found");
					const grant = await tx.lockGrant(
						request.applicationId,
						snapshot.command.recipient,
					);
					if (
						!grant ||
						grant.revokedAt !== null ||
						grant.applicationId !== request.applicationId ||
						grant.principalType !== snapshot.command.recipient.principalType ||
						grant.principalId !== snapshot.command.recipient.principalId
					)
						fail("not_found");
				}
				const saved = await tx.lockByAttempt(
					request.applicationId,
					request.attemptId,
				);
				if (!saved) fail("not_found");
				return applicationCredentialMaterialMetadataV1(
					await expire(tx, request, saved),
				);
			});
		},
		async receive(
			request: MaterialRequest,
			write: (
				material: string,
				metadata: ApplicationCredentialMaterialMetadataV1,
				signal: AbortSignal,
			) => Promise<void>,
		) {
			const snapshot = await inspect(request, true);
			const claimFence = randomUUID();
			let claimPrepared = false;
			let claim: {
				record: ApplicationCredentialMaterialRecordV1;
				fresh: boolean;
			};
			try {
				claim = await input.store.execute(async (tx) => {
					const saved = await authorized(tx, request, snapshot);
					const current = await expire(tx, request, saved);
					if (
						current.result.delivery.status !== "delivery_pending" ||
						current.result.metadata.phase !== "pending"
					)
						return { record: current, fresh: false };
					request.signal?.throwIfAborted();
					const record = change(
						current,
						"claimed",
						"delivery_in_flight",
						claimFence,
					);
					await tx.save(record);
					await tx.audit(request, record, "claimed", "succeeded");
					claimPrepared = true;
					return { record, fresh: true };
				});
			} catch (error) {
				await recordFailure(
					request,
					snapshot,
					claimPrepared ? claimFence : null,
					reasonFor(error, "claim", claimPrepared, request.signal),
				);
				throw error;
			}

			if (!claim.fresh)
				return applicationCredentialMaterialMetadataV1(claim.record, true);
			const controller = new AbortController();
			const signal = request.signal
				? AbortSignal.any([controller.signal, request.signal])
				: controller.signal;
			const timer = setTimeout(
				() => controller.abort(),
				Math.max(
					0,
					Math.min(30_000, Date.parse(claim.record.expiresAt) - Date.now()),
				),
			);
			let material: string | undefined;
			let stage: "generation" | "transmission" = "generation";
			let prepared = false;
			let written = false;
			try {
				await input.store.execute(async (tx) => {
					const record = await authorized(tx, request, snapshot);
					await live(tx, record, claim.record.result.metadata.fence, signal);
					if (record.result.metadata.phase !== "claimed")
						fail("idempotency_conflict");
					const old = await tx.lockActiveCredential(request.applicationId);
					if (
						record.command.operation === "issue"
							? old !== null
							: old?.credentialId !== record.command.credentialId
					)
						fail("idempotency_conflict");
					const now = await tx.databaseTime();
					requirePersonalApiCredentialFutureExpiryV1(record.command, now);
					signal.throwIfAborted();
					material ??= `papi_${randomBytes(32).toString("base64url")}`;
					if (old)
						await tx.revokeCredential(old.credentialId, now.toISOString());
					await tx.insertCredential(
						request.applicationId,
						record.result.metadata.credentialId,
						createHash("sha256").update(material).digest("hex"),
						record.command,
					);
					const generated = change(record, "generated", "delivery_in_flight");
					await tx.save(generated);
					await tx.audit(
						request,
						generated,
						record.command.operation === "issue" ? "issued" : "rotated",
						"succeeded",
					);
					prepared = true;
				});
				stage = "transmission";
				prepared = false;
				return await input.store.execute(async (tx) => {
					const record = await authorized(tx, request, snapshot);
					await live(tx, record, claim.record.result.metadata.fence, signal);
					const credential = await tx.lockActiveCredential(
						request.applicationId,
					);
					if (
						record.result.metadata.phase !== "generated" ||
						credential?.credentialId !== record.result.metadata.credentialId ||
						material === undefined
					)
						fail("idempotency_conflict");
					// The HTTP adapter writes the actual Node response while these authority locks remain held.
					await write(
						material,
						applicationCredentialMaterialMetadataV1(record),
						signal,
					);
					written = true;
					await live(tx, record, claim.record.result.metadata.fence, signal);
					const transmitted = change(
						record,
						"transmitted",
						"delivery_in_flight",
					);
					await tx.save(transmitted);
					await tx.audit(request, transmitted, "transmitted", "succeeded");
					prepared = true;
					return applicationCredentialMaterialMetadataV1(transmitted);
				});
			} catch (error) {
				const reason = controller.signal.aborted
					? "deadline_exceeded"
					: reasonFor(error, stage, prepared, signal, written);
				controller.abort();
				await recordFailure(
					request,
					snapshot,
					claim.record.result.metadata.fence,
					reason,
				);
				if (error instanceof ApplicationApiCredentialErrorV1) throw error;
				fail("unavailable");
			} finally {
				clearTimeout(timer);
				material = undefined;
			}
		},
		async confirm(
			request: MaterialRequest,
			confirmation: { credentialId: string; fence: string },
		) {
			const snapshot = await inspect(request, true);
			let confirming = false;
			let committing = false;
			try {
				return await input.store.execute(async (tx) => {
					const record = await authorized(tx, request, snapshot);
					if (
						confirmation.credentialId !== record.result.metadata.credentialId ||
						confirmation.fence !== record.result.metadata.fence
					)
						fail("not_found");
					if (record.result.delivery.status === "accepted")
						return applicationCredentialMaterialMetadataV1(record, true);
					await live(tx, record, confirmation.fence);
					const credential = await tx.lockActiveCredential(
						request.applicationId,
					);
					if (
						record.result.metadata.phase !== "transmitted" ||
						credential?.credentialId !== confirmation.credentialId
					)
						fail("idempotency_conflict");
					confirming = true;
					const accepted = change(record, "accepted", "accepted");
					await tx.save(accepted);
					await tx.audit(request, accepted, "accepted", "succeeded");
					committing = true;
					return applicationCredentialMaterialMetadataV1(accepted);
				});
			} catch (error) {
				if (confirming)
					await recordFailure(
						request,
						snapshot,
						confirmation.fence,
						committing
							? "confirmation_commit_unconfirmed"
							: "confirmation_failed",
					);
				throw error;
			}
		},

		async prepare(
			request: ApplicationApiCredentialRequestV1,
			commandInput: unknown,
		): Promise<ApplicationCredentialMaterialMetadataV1> {
			const command = parseApplicationApiCredentialCommandV1(commandInput);
			if (!policy) fail("unavailable");
			const requestDigest = platformIdempotencyV1.canonicalRequestDigest({
				...command,
				recipient: { ...command.recipient },
			});
			return input.store.execute(async (tx) => {
				const authority = await authorizeApplicationCredentialDeliveryV1(
					tx,
					input.userDirectory,
					request,
					command.recipient,
				);
				requireConfigured(request.applicationId, command.recipient);
				const previous = await tx.lockByKey(request);
				if (previous) {
					if (previous.requestDigest !== requestDigest)
						throw new ApplicationApiCredentialErrorV1("idempotency_conflict");
					return applicationCredentialMaterialMetadataV1(previous, true);
				}
				const now = await tx.databaseTime();
				requirePersonalApiCredentialFutureExpiryV1(command, now);
				const record: ApplicationCredentialMaterialRecordV1 = {
					schemaVersion: 1,
					managerUserId: request.userId,
					managerRevision: authority.manager.authorizationRevision,
					recipientRevision: authority.recipientRevision,
					idempotencyKey: request.idempotencyKey,
					requestDigest,
					command,
					createdAt: now.toISOString(),
					expiresAt: new Date(
						Math.min(
							now.getTime() + 30_000,
							command.expiresAt === null
								? Number.POSITIVE_INFINITY
								: Date.parse(command.expiresAt),
						),
					).toISOString(),
					result: {
						metadata: {
							applicationId: request.applicationId,
							credentialId: randomUUID(),
							phase: "pending",
							fence: null,
						},
						delivery: {
							attemptId: randomUUID(),
							recipient: command.recipient,
							grantRevision: authority.grant.authorizationRevision,
							status: "delivery_pending",
						},
					},
				};
				await tx.save(record);
				await tx.audit(request, record, "intent", "succeeded");
				return applicationCredentialMaterialMetadataV1(record);
			});
		},
	};
}
