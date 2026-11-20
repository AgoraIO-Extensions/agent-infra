import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type AgentManagementStateV1,
	isAgentAccessAllowedV1,
} from "./agent-management.js";
import { isAgentManagementText } from "./agent-management-input.js";
import type { ConversationRuntimeEventRequestV1 } from "./conversation-dispatch-types.js";
import {
	type CurrentTaskUserV1,
	isTaskAuthorizationCurrentV1,
	type TaskAuthorizationBoundaryV1,
} from "./task-authorization.js";

// Domain facts stay independent of transport schemas; API/Store validate the shared DTO.
export type ConnectionInstallationExecutionV1 = Pick<
	ConversationRuntimeEventRequestV1,
	"agentId" | "conversationId" | "executionId" | "sessionGeneration"
>;
export interface ConnectionInstallationScopeV1 {
	readonly agentId: string;
	readonly sandboxId: string;
	readonly podUid: string;
	readonly sessionGeneration: number;
	readonly configFingerprint: string;
	readonly source: { readonly ref: string; readonly revision: string };
	readonly oauthConfiguration: {
		readonly ref: string;
		readonly revision: string;
	};
}
export interface ConnectionInstallationAuthorizationFactV1 {
	readonly schemaVersion: 1;
	readonly authorizationId: string;
	readonly confirmationRevision: string;
	readonly principal: { readonly kind: "user"; readonly id: string };
	readonly reference: ConnectionInstallationExecutionV1;
	readonly scope: ConnectionInstallationScopeV1;
	readonly status:
		| "awaiting_confirmation"
		| "confirmed"
		| "revoked"
		| "expired"
		| "unknown";
	readonly expiresAt: number;
	/** Runtime-generated OAuth entry point; no credential material. */
	readonly authorizationUrl?: string;
	readonly callback?: ConnectionInstallationCallbackV1;
}
export interface ConnectionInstallationCallbackV1 {
	readonly stateHash: string;
	readonly runtimeOrigin: string;
	readonly expiresAt: number;
	readonly status: "pending" | "sending" | "delivered" | "unknown";
	readonly attemptExpiresAt?: number;
}
export interface ConnectionInstallationCommandFactV1 {
	readonly schemaVersion: 1;
	readonly commandId: string;
	readonly authorizationId: string;
	readonly command:
		| "begin"
		| "confirm"
		| "status"
		| "prepare"
		| "revoke"
		| "begin_status";
	readonly requestDigest: string;
	readonly status: "pending" | "sending" | "completed" | "unknown" | "rejected";
	readonly attemptId: string | null;
	readonly attemptOwner: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}
/**
 * Spec §13.5.6/§13.5.7 manual EP-1060 route before its client receipt: the
 * original Execution and Host facts the pre-registration authorization binds.
 */
export interface ConnectionManualInstallationPreparationV1 {
	readonly agentId: string;
	readonly sandboxId: string;
	readonly podUid: string;
	readonly sessionGeneration: number;
	readonly hostRef: string;
	readonly resourceFence: number;
	readonly resourceName: string;
	readonly association: {
		readonly connectionAgentId: string;
		readonly revision: number;
	};
}
export interface ConnectionManualInstallationCurrentV1 {
	readonly user: CurrentTaskUserV1;
	readonly agent: AgentManagementStateV1;
	readonly boundary: TaskAuthorizationBoundaryV1;
	readonly agentAuthorizationRevision: string;
	readonly reference: ConnectionInstallationExecutionV1;
	readonly preparation: ConnectionManualInstallationPreparationV1;
	/** Current original outbox claim; the template binds it and readback rechecks it. */
	readonly claim: { readonly owner: string; readonly fence: number };
}
export interface ConnectionManualInstallationSavedV1 {
	readonly schemaVersion: 1;
	readonly authorizationId: string;
	readonly confirmationRevision: string;
	readonly principal: { readonly kind: "user"; readonly id: string };
	readonly reference: ConnectionInstallationExecutionV1;
	readonly preparation: ConnectionManualInstallationPreparationV1;
	readonly status:
		| ConnectionInstallationAuthorizationFactV1["status"]
		| "preparing";
	readonly expiresAt: number;
	readonly identityRevision: string;
	readonly agentAuthorizationRevision: string;
	readonly registrationState:
		| "pending"
		| "sending"
		| "registered"
		| "failed"
		| "unknown"
		| "closed";
}
/** Browser projection of a manual install; it never names a Consumer, client or key. */
export interface ConnectionManualInstallationProjectionFactV1 {
	readonly schemaVersion: 1;
	readonly manual: true;
	readonly authorizationId: string;
	readonly status: ConnectionInstallationAuthorizationFactV1["status"];
	readonly expiresAt: number;
}
function identifier(value: unknown) {
	if (!isAgentManagementText(value))
		throw new ConnectionInstallationErrorV1("invalid_input");
}

export class ConnectionInstallationErrorV1 extends Error {
	constructor(
		readonly code: "invalid_input" | "denied" | "conflict" | "unavailable",
	) {
		super("Connection installation authorization is unavailable");
	}
}

export interface ConnectionInstallationCurrentV1 {
	readonly user: CurrentTaskUserV1;
	readonly agent: AgentManagementStateV1;
	readonly boundary: TaskAuthorizationBoundaryV1;
	readonly agentAuthorizationRevision: string;
	readonly reference: ConnectionInstallationExecutionV1;
	readonly scope: ConnectionInstallationScopeV1;
}
export interface ConnectionInstallationSavedV1 {
	readonly authorization: ConnectionInstallationAuthorizationFactV1;
	readonly identityRevision: string;
	readonly agentAuthorizationRevision: string;
}
export interface ConnectionInstallationTransactionV1 {
	claimCallback?(input: {
		stateHash: string;
		now: number;
	}): Promise<ConnectionInstallationCallbackClaimV1 | null>;
	settleCallback?(input: {
		stateHash: string;
		attemptId: string;
		now: number;
		status: "delivered" | "unknown";
	}): Promise<boolean>;
	hasUnresolvedSend(
		authorizationId: string,
		exclude?: { commandId: string; attemptId: string; attemptOwner: string },
	): Promise<boolean>;
	commandAllowed(
		authorizationId: string,
		command: "begin" | "confirm",
		attempt?: { commandId: string; attemptId: string; attemptOwner: string },
	): Promise<boolean>;
	current(
		userId: string,
		executionId: string,
		/** Selects a per-installation bound configuration (manual EP-1060 route). */
		authorizationId?: string,
	): Promise<ConnectionInstallationCurrentV1 | null>;
	/** Manual EP-1060 facts; absent or null when the route is not enabled for this Agent. */
	currentManual?(
		userId: string,
		executionId: string,
	): Promise<ConnectionManualInstallationCurrentV1 | null>;
	/** Atomically saves the pre-registration authorization, its manual row and first prepare. */
	createManual?(
		record: ConnectionManualInstallationSavedV1,
		command: ConnectionInstallationCommandFactV1,
		key: string,
	): Promise<void>;
	/** This user's manual installation, before or after its receipt CAS. */
	readManual?(
		userId: string,
		authorizationId: string,
	): Promise<ConnectionManualInstallationSavedV1 | null>;
	receiptManual?(
		userId: string,
		key: string,
		command: string,
		digest: string,
	): Promise<ConnectionManualInstallationSavedV1 | null>;
	/**
	 * Original user's read-only verification: enqueue one signed status (unknown
	 * registration) or begin_status (lost first begin) under the original claim.
	 */
	requestManualStatus?(userId: string, authorizationId: string): Promise<void>;
	read(
		userId: string,
		authorizationId: string,
	): Promise<ConnectionInstallationSavedV1 | null>;
	now(): Promise<number>;
	receipt(
		userId: string,
		key: string,
		command: string,
		digest: string,
	): Promise<ConnectionInstallationAuthorizationFactV1 | null>;
	save(record: ConnectionInstallationSavedV1): Promise<void>;
	command(
		command: ConnectionInstallationCommandFactV1,
		key: string,
	): Promise<void>;
	completeReceipt(
		userId: string,
		key: string,
		command: string,
		digest: string,
		authorizationId: string,
	): Promise<void>;
	audit(
		userId: string,
		authorizationId: string,
		command: string,
		requestId: string,
		traceId: string,
	): Promise<void>;
}
export interface ConnectionInstallationCallbackClaimV1 {
	readonly authorizationId: string;
	readonly runtimeOrigin: string;
	readonly callbackPath: "/internal/runtime/oauth/v1/callback";
	readonly attemptId: string;
	readonly expiresAt: number;
	readonly issuer: string;
}
export interface ConnectionInstallationStoreV1 {
	transaction<T>(
		work: (transaction: ConnectionInstallationTransactionV1) => Promise<T>,
	): Promise<T>;
}
export interface ConnectionInstallationPendingCommandV1 {
	readonly authorization: ConnectionInstallationAuthorizationFactV1;
	readonly command: ConnectionInstallationCommandFactV1;
}
export interface ConnectionInstallationCommandDrainStoreV1 {
	listPending(
		limit: number,
		executionIds?: readonly string[],
	): Promise<readonly ConnectionInstallationPendingCommandV1[]>;
	claimPending(input: {
		commandId: string;
		attemptId: string;
		attemptOwner: string;
	}): Promise<ConnectionInstallationPendingCommandV1 | null>;
	settle(input: {
		commandId: string;
		attemptId: string;
		attemptOwner: string;
		status: "completed" | "unknown";
		authorizationUrl?: string;
		authorizationExpiresAt?: number;
		/** PAT callback correlation hash; the opaque binding id never enters Platform DB. */
		callbackStateHash?: string;
	}): Promise<boolean>;
}

function denied(): never {
	throw new ConnectionInstallationErrorV1("denied");
}
function requireCurrent(
	current: ConnectionInstallationCurrentV1 | null,
	userId: string,
) {
	if (
		!current ||
		current.user.userId !== userId ||
		current.user.accountStatus !== "active" ||
		current.boundary.principal.kind !== "user" ||
		current.boundary.principal.id !== userId ||
		current.boundary.agentId !== current.reference.agentId ||
		current.agent.agentId !== current.reference.agentId ||
		current.scope.agentId !== current.reference.agentId ||
		current.scope.sessionGeneration !== current.reference.sessionGeneration ||
		current.boundary.agentAuthorizationRevision !==
			current.agentAuthorizationRevision ||
		current.agent.status !== "available" ||
		current.agent.desiredState !== "running" ||
		!isTaskAuthorizationCurrentV1({
			boundary: current.boundary,
			user: current.user,
			agent: current.agent,
		}) ||
		!isAgentAccessAllowedV1(
			current.agent,
			{
				schemaVersion: 1,
				userId,
				accountStatus: current.user.accountStatus,
				organizationIds: current.user.organizationIds,
				isAdministrator: false,
			},
			"use",
		)
	)
		denied();
	return current;
}
function requireSaved(
	record: ConnectionInstallationSavedV1 | null,
	current: ConnectionInstallationCurrentV1,
	now: number,
) {
	if (
		!record ||
		!["awaiting_confirmation", "confirmed"].includes(
			record.authorization.status,
		) ||
		record.authorization.expiresAt <= now ||
		record.identityRevision !== current.user.authorizationRevision ||
		record.agentAuthorizationRevision !== current.agentAuthorizationRevision ||
		!isDeepStrictEqual(record.authorization.reference, current.reference) ||
		!isDeepStrictEqual(record.authorization.scope, current.scope) ||
		record.authorization.principal.id !== current.user.userId
	)
		denied();
	return record;
}

function requireManualCurrent(
	current: ConnectionManualInstallationCurrentV1 | null,
	userId: string,
) {
	if (
		!current ||
		current.user.userId !== userId ||
		current.user.accountStatus !== "active" ||
		current.boundary.principal.kind !== "user" ||
		current.boundary.principal.id !== userId ||
		current.boundary.agentId !== current.reference.agentId ||
		current.agent.agentId !== current.reference.agentId ||
		current.preparation.agentId !== current.reference.agentId ||
		current.preparation.sessionGeneration !==
			current.reference.sessionGeneration ||
		current.boundary.agentAuthorizationRevision !==
			current.agentAuthorizationRevision ||
		current.agent.status !== "available" ||
		current.agent.desiredState !== "running" ||
		!isTaskAuthorizationCurrentV1({
			boundary: current.boundary,
			user: current.user,
			agent: current.agent,
		}) ||
		!isAgentAccessAllowedV1(
			current.agent,
			{
				schemaVersion: 1,
				userId,
				accountStatus: current.user.accountStatus,
				organizationIds: current.user.organizationIds,
				isAdministrator: false,
			},
			"use",
		)
	)
		denied();
	return current;
}
function requireManualSaved(
	record: ConnectionManualInstallationSavedV1 | null,
	current: ConnectionManualInstallationCurrentV1,
	now: number,
) {
	if (record?.status !== "preparing") denied();
	return requireManualOriginal(record, current, now);
}
/**
 * The original manual installation still belongs to this user, Execution, Host
 * preparation and current authorization. Its own stage is not checked: an
 * idempotent replay reads the original back after the receipt CAS moved it on.
 */
function requireManualOriginal(
	record: ConnectionManualInstallationSavedV1 | null,
	current: ConnectionManualInstallationCurrentV1,
	now: number,
) {
	if (
		!record ||
		!["preparing", "awaiting_confirmation", "confirmed"].includes(
			record.status,
		) ||
		record.expiresAt <= now ||
		record.identityRevision !== current.user.authorizationRevision ||
		record.agentAuthorizationRevision !== current.agentAuthorizationRevision ||
		!isDeepStrictEqual(record.reference, current.reference) ||
		!isDeepStrictEqual(record.preparation, current.preparation) ||
		record.principal.id !== current.user.userId
	)
		denied();
	return record;
}
function manualProjection(
	record: ConnectionManualInstallationSavedV1,
): ConnectionManualInstallationProjectionFactV1 {
	return {
		schemaVersion: 1,
		manual: true,
		authorizationId: record.authorizationId,
		// No link exists before the receipt CAS; an unverified registration is unknown.
		status:
			record.registrationState === "unknown" ||
			record.registrationState === "sending"
				? "unknown"
				: record.registrationState === "failed" ||
						record.registrationState === "closed"
					? "revoked"
					: "awaiting_confirmation",
		expiresAt: record.expiresAt,
	};
}

/** Platform-owned confirmation facts; business authorization alone never confirms login. */
export function createConnectionInstallationAuthorizationV1(options: {
	store: ConnectionInstallationStoreV1;
}) {
	type ExecuteInput = {
		userId: string;
		identityRevision: string;
		command: "begin" | "confirm" | "status";
		executionId?: string;
		authorizationId?: string;
		idempotencyKey?: string;
		requestId: string;
		traceId: string;
	};
	/**
	 * `manualRoute` is the entry's capability. Without it no manual hook runs, so
	 * a static-only caller is refused before any manual write (Spec §13.5.7).
	 */
	const run = async (
		input: ExecuteInput,
		manualRoute: boolean,
	): Promise<
		| ConnectionInstallationAuthorizationFactV1
		| ConnectionManualInstallationProjectionFactV1
	> => {
		try {
			const request = structuredClone(input);
			for (const value of [
				request.userId,
				request.identityRevision,
				request.requestId,
				request.traceId,
			])
				identifier(value);
			if (!(["begin", "confirm", "status"] as const).includes(request.command))
				throw new ConnectionInstallationErrorV1("invalid_input");
			if (request.command === "begin") identifier(request.executionId);
			else identifier(request.authorizationId);
			if (request.command !== "status") identifier(request.idempotencyKey);
			const digest = createHash("sha256")
				.update(
					JSON.stringify([
						request.command,
						request.executionId ?? null,
						request.authorizationId ?? null,
					]),
				)
				.digest("hex");
			return await options.store.transaction(async (transaction) => {
				const existing =
					request.command === "begin"
						? null
						: await transaction.read(
								request.userId,
								request.authorizationId as string,
							);
				if (request.command !== "begin" && !existing) {
					// Spec §13.5.7 manual EP-1060 route before its receipt CAS. Confirm and
					// callback stay closed until the configuration is fixed.
					const manual =
						manualRoute &&
						request.command === "status" &&
						transaction.readManual
							? await transaction.readManual(
									request.userId,
									request.authorizationId as string,
								)
							: null;
					if (!manual || !transaction.currentManual) denied();
					const current = requireManualCurrent(
						await transaction.currentManual(
							request.userId,
							manual.reference.executionId,
						),
						request.userId,
					);
					if (current.user.authorizationRevision !== request.identityRevision)
						denied();
					requireManualSaved(manual, current, await transaction.now());
					await transaction.requestManualStatus?.(
						request.userId,
						manual.authorizationId,
					);
					return manualProjection(manual);
				}
				if (
					request.command !== "begin" &&
					(request.command === "confirm" || !manualRoute) &&
					(await transaction.readManual?.(
						request.userId,
						request.authorizationId as string,
					))
				)
					// The manual route's code exchange and publication are not enabled,
					// and a static-only entry never reads or verifies a manual install.
					denied();
				const executionId =
					request.executionId ?? existing?.authorization.reference.executionId;
				const staticCurrent = await transaction.current(
					request.userId,
					executionId as string,
					existing?.authorization.authorizationId,
				);
				if (
					manualRoute &&
					request.command === "begin" &&
					!staticCurrent &&
					transaction.currentManual &&
					transaction.createManual &&
					transaction.receiptManual
				) {
					const manual = requireManualCurrent(
						await transaction.currentManual(
							request.userId,
							executionId as string,
						),
						request.userId,
					);
					if (manual.user.authorizationRevision !== request.identityRevision)
						denied();
					const now = await transaction.now();
					const replay = await transaction.receiptManual(
						request.userId,
						request.idempotencyKey as string,
						request.command,
						digest,
					);
					if (replay) {
						// The same begin reads its original installation back at any stage.
						requireManualOriginal(replay, manual, now);
						return manualProjection(replay);
					}
					const record: ConnectionManualInstallationSavedV1 = {
						schemaVersion: 1,
						authorizationId: randomUUID(),
						confirmationRevision: randomUUID(),
						principal: { kind: "user", id: request.userId },
						reference: manual.reference,
						preparation: manual.preparation,
						status: "preparing",
						expiresAt: now + 600_000,
						identityRevision: manual.user.authorizationRevision,
						agentAuthorizationRevision: manual.agentAuthorizationRevision,
						registrationState: "pending",
					};
					requireManualSaved(
						record,
						requireManualCurrent(
							await transaction.currentManual(
								request.userId,
								executionId as string,
							),
							request.userId,
						),
						await transaction.now(),
					);
					await transaction.createManual(
						record,
						{
							schemaVersion: 1,
							commandId: randomUUID(),
							authorizationId: record.authorizationId,
							command: "prepare",
							requestDigest: digest,
							status: "pending",
							attemptId: null,
							attemptOwner: null,
							createdAt: now,
							updatedAt: now,
						},
						request.idempotencyKey as string,
					);
					await transaction.audit(
						request.userId,
						record.authorizationId,
						request.command,
						request.requestId,
						request.traceId,
					);
					await transaction.completeReceipt(
						request.userId,
						request.idempotencyKey as string,
						request.command,
						digest,
						record.authorizationId,
					);
					return manualProjection(record);
				}
				let current = requireCurrent(staticCurrent, request.userId);
				if (current.user.authorizationRevision !== request.identityRevision)
					denied();
				const now = await transaction.now();
				if (existing) requireSaved(existing, current, now);
				if (request.command === "status") {
					if (!existing) denied();
					// A bound manual install may verify a lost first begin read-only.
					if (manualRoute)
						await transaction.requestManualStatus?.(
							request.userId,
							existing.authorization.authorizationId,
						);
					return existing.authorization;
				}
				const replay = await transaction.receipt(
					request.userId,
					request.idempotencyKey as string,
					request.command,
					digest,
				);
				if (replay) {
					requireSaved(
						await transaction.read(request.userId, replay.authorizationId),
						current,
						now,
					);
					return replay;
				}
				if (existing) {
					if (
						await transaction.hasUnresolvedSend(
							existing.authorization.authorizationId,
						)
					)
						throw new ConnectionInstallationErrorV1("conflict");
					if (existing.authorization.status === "confirmed") {
						await transaction.completeReceipt(
							request.userId,
							request.idempotencyKey as string,
							request.command,
							digest,
							existing.authorization.authorizationId,
						);
						return existing.authorization;
					}
				}
				const record: ConnectionInstallationSavedV1 = existing ?? {
					authorization: {
						schemaVersion: 1,
						authorizationId: randomUUID(),
						confirmationRevision: randomUUID(),
						principal: { kind: "user", id: request.userId },
						reference: current.reference,
						scope: current.scope,
						status: "awaiting_confirmation",
						expiresAt: now + 600_000,
					},
					identityRevision: current.user.authorizationRevision,
					agentAuthorizationRevision: current.agentAuthorizationRevision,
				};
				current = requireCurrent(
					await transaction.current(
						request.userId,
						executionId as string,
						existing?.authorization.authorizationId,
					),
					request.userId,
				);
				requireSaved(record, current, await transaction.now());
				const saved = {
					...record,
					authorization: {
						...record.authorization,
						status:
							request.command === "confirm"
								? ("confirmed" as const)
								: record.authorization.status,
					},
				};
				await transaction.save(saved);
				await transaction.command(
					{
						schemaVersion: 1,
						commandId: randomUUID(),
						authorizationId: saved.authorization.authorizationId,
						command: request.command,
						requestDigest: digest,
						status: "pending",
						attemptId: null,
						attemptOwner: null,
						createdAt: now,
						updatedAt: now,
					},
					request.idempotencyKey as string,
				);
				await transaction.audit(
					request.userId,
					saved.authorization.authorizationId,
					request.command,
					request.requestId,
					request.traceId,
				);
				await transaction.completeReceipt(
					request.userId,
					request.idempotencyKey as string,
					request.command,
					digest,
					saved.authorization.authorizationId,
				);
				return saved.authorization;
			});
		} catch (error) {
			if (error instanceof ConnectionInstallationErrorV1) throw error;
			throw new ConnectionInstallationErrorV1("unavailable");
		}
	};
	/** Static-configuration callers; the manual route is refused before it writes. */
	const execute = async (
		input: ExecuteInput,
	): Promise<ConnectionInstallationAuthorizationFactV1> => {
		const result = await run(input, false);
		if ("manual" in result) throw new ConnectionInstallationErrorV1("denied");
		return result;
	};
	const executeInstallation = (input: ExecuteInput) => run(input, true);
	return {
		execute,
		/** Includes the manual EP-1060 route's pre-registration projection (§13.5.7). */
		executeInstallation,
		callback: {
			claim: async (input: { stateHash: string; now: number }) => {
				if (!/^[a-f0-9]{64}$/.test(input.stateHash)) return null;
				if (!options.store.transaction) return null;
				return options.store.transaction(
					(transaction) =>
						transaction.claimCallback?.(input) ?? Promise.resolve(null),
				);
			},
			settle: async (input: {
				stateHash: string;
				attemptId: string;
				now: number;
				status: "delivered" | "unknown";
			}) => {
				if (!/^[a-f0-9]{64}$/.test(input.stateHash)) return false;
				if (!options.store.transaction) return false;
				return options.store.transaction(
					(transaction) =>
						transaction.settleCallback?.(input) ?? Promise.resolve(false),
				);
			},
		},
		async authorize(
			input: {
				principal: { kind: "user" | "application"; id: string };
				reference: ConnectionInstallationExecutionV1;
				scope: ConnectionInstallationScopeV1;
				authorizationId: string;
				command: "begin" | "confirm" | "status";
				commandId?: string;
				attemptId?: string;
				attemptOwner?: string;
			},
			signal: AbortSignal,
			finalCheck: () => Promise<void>,
		) {
			const snapshot = structuredClone(input);
			if (snapshot.principal.kind !== "user") return null;
			const read = () =>
				options.store.transaction(async (transaction) => {
					signal.throwIfAborted();
					const current = requireCurrent(
						await transaction.current(
							snapshot.principal.id,
							snapshot.reference.executionId,
							snapshot.authorizationId,
						),
						snapshot.principal.id,
					);
					const record = requireSaved(
						await transaction.read(
							snapshot.principal.id,
							snapshot.authorizationId,
						),
						current,
						await transaction.now(),
					);
					if (
						!isDeepStrictEqual(
							record.authorization.reference,
							snapshot.reference,
						) ||
						!isDeepStrictEqual(record.authorization.scope, snapshot.scope) ||
						(snapshot.command === "confirm" &&
							record.authorization.status !== "confirmed")
					)
						denied();
					if (snapshot.command !== "status") {
						const attempt =
							snapshot.commandId && snapshot.attemptId && snapshot.attemptOwner
								? {
										commandId: snapshot.commandId,
										attemptId: snapshot.attemptId,
										attemptOwner: snapshot.attemptOwner,
									}
								: undefined;
						if (
							(await transaction.hasUnresolvedSend(
								snapshot.authorizationId,
								attempt,
							)) ||
							!(await transaction.commandAllowed(
								snapshot.authorizationId,
								snapshot.command,
								attempt,
							))
						)
							denied();
					}
					signal.throwIfAborted();
					return {
						...snapshot,
						revision: record.authorization.confirmationRevision,
					};
				});
			try {
				const approved = await read();
				await finalCheck();
				const current = await read();
				return isDeepStrictEqual(approved, current) ? current : null;
			} catch {
				return null;
			}
		},
	};
}
