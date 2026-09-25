import { createHash } from "node:crypto";

import {
	type ActionCallRecord,
	type ActionCallRequest,
	type ActionCallStatus,
	consumerActorSentinel,
	type ResolvedActionCallRequest,
	requireNonEmpty,
} from "./types.js";

export function actorNamespaceId(actorId: string | null): string {
	if (actorId === consumerActorSentinel) {
		throw new Error(`actorId must not be ${consumerActorSentinel}`);
	}
	return actorId ?? consumerActorSentinel;
}

export function actionCallNamespaceKey(
	input: Pick<
		ActionCallRequest,
		"principalId" | "consumerId" | "consumerInstanceId" | "actorId"
	>,
): string {
	return canonicalJson(
		[
			input.principalId,
			input.consumerId,
			input.consumerInstanceId,
			actorNamespaceId(input.actorId),
		].map((value, index) => requireNonEmpty(value, `namespace field ${index}`)),
	);
}

export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Action arguments must contain finite numbers");
		return JSON.stringify(value);
	}
	if (typeof value !== "object")
		throw new Error("Action arguments must contain JSON values");
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error("Action arguments must contain JSON values");
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
	);
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function actionRequestDigest(
	input: Pick<
		ResolvedActionCallRequest,
		"connectionId" | "actionVersionId" | "arguments"
	>,
): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				connectionId: input.connectionId,
				actionVersionId: input.actionVersionId,
				arguments: input.arguments,
			}),
		)
		.digest("hex");
}

export function mcpRequestDigest(argumentsValue: unknown): string {
	return createHash("sha256")
		.update(
			canonicalJson({
				version: "connection-request-v1",
				method: "tools/call",
				toolName: "execute_action",
				arguments: argumentsValue,
			}),
		)
		.digest("hex");
}

export type ActionCallReplay =
	| { kind: "new" }
	| { kind: "reuse"; record: ActionCallRecord }
	| { kind: "conflict"; reason: "request" | "namespace" };

export function decideActionCallReplay(
	existing: ActionCallRecord | undefined,
	request: ResolvedActionCallRequest,
): ActionCallReplay {
	if (!existing) return { kind: "new" };
	const namespaceKey = actionCallNamespaceKey(request);
	const digest = actionRequestDigest(request);
	if (existing.namespaceKey !== namespaceKey)
		return { kind: "conflict", reason: "namespace" };
	if (
		existing.requestDigest !== digest ||
		existing.actionVersionId !== request.actionVersionId ||
		existing.connectionId !== request.connectionId ||
		existing.grantId !== request.grantId
	) {
		return { kind: "conflict", reason: "request" };
	}
	return { kind: "reuse", record: existing };
}

const allowedTransitions: Record<
	ActionCallStatus,
	readonly ActionCallStatus[]
> = {
	created: ["submission_started", "provider_failed", "result_pending"],
	submission_started: [
		"provider_succeeded",
		"provider_failed",
		"result_pending",
	],
	provider_succeeded: [],
	provider_failed: [],
	result_pending: [
		"provider_succeeded",
		"provider_failed",
		"needs_manual_review",
		"unresolved",
	],
	needs_manual_review: ["provider_succeeded", "provider_failed", "unresolved"],
	unresolved: [],
};

export function assertActionCallTransition(
	from: ActionCallStatus,
	to: ActionCallStatus,
): void {
	if (!allowedTransitions[from].includes(to)) {
		throw new Error(`invalid ActionCall transition: ${from} -> ${to}`);
	}
}
