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
}
export interface ConnectionInstallationCommandFactV1 {
	readonly schemaVersion: 1;
	readonly commandId: string;
	readonly authorizationId: string;
	readonly command: "begin" | "confirm" | "status";
	readonly requestDigest: string;
	readonly status: "pending" | "sending" | "completed" | "unknown" | "rejected";
	readonly attemptId: string | null;
	readonly attemptOwner: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
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
	): Promise<ConnectionInstallationCurrentV1 | null>;
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

/** Platform-owned confirmation facts; business authorization alone never confirms login. */
export function createConnectionInstallationAuthorizationV1(options: {
	store: ConnectionInstallationStoreV1;
}) {
	const execute = async (input: {
		userId: string;
		identityRevision: string;
		command: "begin" | "confirm" | "status";
		executionId?: string;
		authorizationId?: string;
		idempotencyKey?: string;
		requestId: string;
		traceId: string;
	}) => {
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
				if (request.command !== "begin" && !existing) denied();
				const executionId =
					request.executionId ?? existing?.authorization.reference.executionId;
				let current = requireCurrent(
					await transaction.current(request.userId, executionId as string),
					request.userId,
				);
				if (current.user.authorizationRevision !== request.identityRevision)
					denied();
				const now = await transaction.now();
				if (existing) requireSaved(existing, current, now);
				if (request.command === "status") {
					if (!existing) denied();
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
					await transaction.current(request.userId, executionId as string),
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
	return {
		execute,
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
