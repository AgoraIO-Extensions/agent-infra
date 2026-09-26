import { createHash } from "node:crypto";
import {
	requireAgentManagementExactKeys as exact,
	snapshotAgentManagementDataObject as object,
	isAgentManagementText as text,
} from "./agent-management-input.js";
import type { TaskPrincipalV1 } from "./task-authorization.js";

export type TaskApiAuditReasonV1 =
	| "request_accepted"
	| "task_accepted"
	| "task_replayed"
	| "idempotency_conflict"
	| "agent_unavailable"
	| "conversation_unavailable"
	| "model_unavailable"
	| "invalid_request"
	| "authentication_required"
	| "authorization_revoked"
	| "missing_scope"
	| "resource_unavailable"
	| "capacity_full"
	| "conflict"
	| "dependency_unavailable"
	| "client_disconnected"
	| "stream_ended"
	| "subscription_unconfirmed";
export type TaskApiAuditActionV1 =
	| "task.api.access"
	| "task.api.submit.result"
	| "task.api.subscription.started"
	| "task.api.subscription.ended";
export type TaskApiAuditTargetV1 =
	| { readonly kind: "unknown" }
	| { readonly kind: "agent"; readonly agentId: string }
	| {
			readonly kind: "conversation";
			readonly agentId: string;
			readonly conversationId: string;
	  }
	| {
			readonly kind: "execution";
			readonly agentId: string;
			readonly conversationId: string;
			readonly executionId: string;
	  };

/** IDs and identity/resource facts must be resolved by the server, never copied from an unverified request. */
export interface TaskApiAuditInputV1 {
	readonly schemaVersion: 1;
	readonly auditId: string;
	readonly operation: "submit" | "read" | "cancel" | "subscribe";
	readonly phase:
		| "access"
		| "submit.result"
		| "subscription.started"
		| "subscription.ended";
	readonly result: "succeeded" | "rejected" | "failed";
	readonly reason: TaskApiAuditReasonV1;
	readonly principal: TaskPrincipalV1 | { readonly kind: "unknown" };
	readonly target: TaskApiAuditTargetV1;
	readonly requestId: string;
	readonly traceId: string;
	readonly subscriptionId?: string;
	readonly occurredAt?: Date;
}
export interface TaskApiAuditPlanV1 extends TaskApiAuditInputV1 {
	readonly action: TaskApiAuditActionV1;
	readonly occurredAt: Date;
}
export interface TaskApiAuditStoreV1 {
	write(plan: TaskApiAuditPlanV1): Promise<void>;
	renewSubscription(subscriptionId: string): Promise<void>;
	recoverSubscriptions(): Promise<number>;
}
export class TaskApiAuditError extends Error {
	constructor(readonly code: "invalid_input" | "unavailable") {
		super(
			code === "invalid_input"
				? "Invalid Task API audit input"
				: "Task API audit persistence is unavailable",
		);
		this.name = "TaskApiAuditError";
	}
}
const reasons = new Set<string>([
	"request_accepted",
	"task_accepted",
	"task_replayed",
	"idempotency_conflict",
	"agent_unavailable",
	"conversation_unavailable",
	"model_unavailable",
	"invalid_request",
	"authentication_required",
	"authorization_revoked",
	"missing_scope",
	"resource_unavailable",
	"capacity_full",
	"conflict",
	"dependency_unavailable",
	"client_disconnected",
	"stream_ended",
	"subscription_unconfirmed",
]);

export function taskApiSubscriptionEndAuditIdV1(
	subscriptionId: string,
): string {
	if (!text(subscriptionId)) throw new TaskApiAuditError("invalid_input");
	return `task.api.subscription.ended:${createHash("sha256").update(subscriptionId).digest("hex")}`;
}

/** Also used by the persistence reader to reject malformed or private metadata. */
export function parseTaskApiAuditInputV1(
	input: unknown,
): TaskApiAuditInputV1 & { readonly occurredAt: Date } {
	try {
		const value = object(input);
		exact(value, [
			"schemaVersion",
			"auditId",
			"operation",
			"phase",
			"result",
			"reason",
			"principal",
			"target",
			"requestId",
			"traceId",
			...(Object.hasOwn(value, "subscriptionId") ? ["subscriptionId"] : []),
			...(Object.hasOwn(value, "occurredAt") ? ["occurredAt"] : []),
		]);
		if (
			value.schemaVersion !== 1 ||
			!text(value.auditId) ||
			!text(value.requestId) ||
			!text(value.traceId) ||
			!["submit", "read", "cancel", "subscribe"].includes(
				value.operation as string,
			) ||
			![
				"access",
				"submit.result",
				"subscription.started",
				"subscription.ended",
			].includes(value.phase as string) ||
			!["succeeded", "rejected", "failed"].includes(value.result as string) ||
			typeof value.reason !== "string" ||
			!reasons.has(value.reason) ||
			(value.phase !== "access" &&
				value.phase !== "submit.result" &&
				value.operation !== "subscribe") ||
			(value.subscriptionId !== undefined &&
				(value.operation !== "subscribe" || !text(value.subscriptionId))) ||
			(value.phase !== "access" &&
				value.phase !== "submit.result" &&
				!text(value.subscriptionId))
		)
			throw new TaskApiAuditError("invalid_input");
		const principal = object(value.principal);
		exact(principal, principal.kind === "unknown" ? ["kind"] : ["kind", "id"]);
		if (
			principal.kind !== "unknown" &&
			((principal.kind !== "user" && principal.kind !== "application") ||
				!text(principal.id))
		)
			throw new TaskApiAuditError("invalid_input");
		const target = object(value.target);
		const targetKeys =
			target.kind === "unknown"
				? ["kind"]
				: target.kind === "agent"
					? ["kind", "agentId"]
					: target.kind === "conversation"
						? ["kind", "agentId", "conversationId"]
						: target.kind === "execution"
							? ["kind", "agentId", "conversationId", "executionId"]
							: [];
		if (targetKeys.length === 0) throw new TaskApiAuditError("invalid_input");
		exact(target, targetKeys);
		if (targetKeys.slice(1).some((key) => !text(target[key])))
			throw new TaskApiAuditError("invalid_input");
		if (
			(principal.kind === "unknown" && target.kind !== "unknown") ||
			(value.result === "succeeded" &&
				(principal.kind === "unknown" || target.kind === "unknown")) ||
			(value.phase !== "access" &&
				value.phase !== "submit.result" &&
				(principal.kind === "unknown" || target.kind !== "execution")) ||
			(value.phase === "subscription.started" &&
				(value.result !== "succeeded" ||
					value.reason !== "request_accepted")) ||
			(value.reason === "subscription_unconfirmed" &&
				(value.phase !== "subscription.ended" || value.result !== "failed"))
		)
			throw new TaskApiAuditError("invalid_input");
		if (value.phase === "submit.result") {
			if (
				value.operation !== "submit" ||
				principal.kind === "unknown" ||
				value.subscriptionId !== undefined ||
				!(
					(value.result === "succeeded" &&
						target.kind === "execution" &&
						["task_accepted", "task_replayed"].includes(value.reason)) ||
					(value.result === "rejected" &&
						target.kind === "agent" &&
						[
							"idempotency_conflict",
							"capacity_full",
							"agent_unavailable",
							"conversation_unavailable",
							"model_unavailable",
						].includes(value.reason))
				)
			)
				throw new TaskApiAuditError("invalid_input");
		} else if (
			[
				"task_accepted",
				"task_replayed",
				"idempotency_conflict",
				"agent_unavailable",
				"conversation_unavailable",
				"model_unavailable",
			].includes(value.reason)
		) {
			throw new TaskApiAuditError("invalid_input");
		}
		const occurredAt =
			value.occurredAt === undefined
				? new Date()
				: new Date(Date.prototype.getTime.call(value.occurredAt));
		if (!Number.isFinite(occurredAt.getTime()))
			throw new TaskApiAuditError("invalid_input");
		return {
			schemaVersion: 1,
			auditId: value.auditId,
			operation: value.operation as TaskApiAuditInputV1["operation"],
			phase: value.phase as TaskApiAuditInputV1["phase"],
			result: value.result as TaskApiAuditInputV1["result"],
			reason: value.reason as TaskApiAuditReasonV1,
			principal: principal as unknown as TaskApiAuditInputV1["principal"],
			target: target as unknown as TaskApiAuditTargetV1,
			requestId: value.requestId,
			traceId: value.traceId,
			...(value.subscriptionId === undefined
				? {}
				: { subscriptionId: value.subscriptionId as string }),
			occurredAt,
		};
	} catch {
		throw new TaskApiAuditError("invalid_input");
	}
}

export function createTaskApiAuditV1(store: TaskApiAuditStoreV1): {
	record(input: TaskApiAuditInputV1): Promise<void>;
	renewSubscription(subscriptionId: string): Promise<void>;
	recoverSubscriptions(): Promise<number>;
} {
	if (
		!store ||
		typeof store.write !== "function" ||
		typeof store.renewSubscription !== "function" ||
		typeof store.recoverSubscriptions !== "function"
	)
		throw new TaskApiAuditError("unavailable");
	return {
		async record(input) {
			const parsed = parseTaskApiAuditInputV1(input);
			const plan: TaskApiAuditPlanV1 = {
				...parsed,
				auditId:
					parsed.phase === "subscription.ended"
						? taskApiSubscriptionEndAuditIdV1(parsed.subscriptionId as string)
						: parsed.auditId,
				action: `task.api.${parsed.phase}`,
			};
			try {
				await store.write(plan);
			} catch {
				throw new TaskApiAuditError("unavailable");
			}
		},
		async renewSubscription(subscriptionId) {
			if (!text(subscriptionId)) throw new TaskApiAuditError("invalid_input");
			try {
				await store.renewSubscription(subscriptionId);
			} catch {
				throw new TaskApiAuditError("unavailable");
			}
		},
		async recoverSubscriptions() {
			try {
				const count = await store.recoverSubscriptions();
				if (!Number.isSafeInteger(count) || count < 0)
					throw new TaskApiAuditError("unavailable");
				return count;
			} catch {
				throw new TaskApiAuditError("unavailable");
			}
		},
	};
}
