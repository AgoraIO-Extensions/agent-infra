import { randomUUID } from "node:crypto";
import type { ConversationExecutionAuthorityV1 } from "./conversation-execution-types.js";
import {
	isPositiveSafeInteger,
	isText,
	snapshotObject,
	unavailable,
} from "./conversation-execution-values.js";
import {
	parseTaskPrincipalV1,
	type TaskPrincipalV1,
} from "./task-authorization.js";

/** Platform identity only. Runtime and deployment configuration cannot allocate it. */
export interface SessionSandboxBindingV1 {
	readonly schemaVersion: 1;
	readonly sandboxId: string;
	readonly sessionId: string;
	readonly agentId: string;
	readonly principal: TaskPrincipalV1;
	readonly channelId: string;
	readonly generation: number;
	readonly resourceName: string;
	readonly workspaceScope: string;
}

export function createSessionSandboxBindingV1(
	authority: ConversationExecutionAuthorityV1,
	sessionId: string,
): SessionSandboxBindingV1 {
	const sandboxId = randomUUID();
	return parseSessionSandboxBindingV1({
		schemaVersion: 1,
		sandboxId,
		sessionId,
		agentId: authority.agentId,
		principal: authority.taskBoundary?.principal ?? {
			kind: "user",
			id: authority.actorId,
		},
		channelId: authority.channelId,
		generation: 1,
		resourceName: `sandbox-${sandboxId}`,
		workspaceScope: sandboxId,
	});
}

export function parseSessionSandboxBindingV1(
	input: unknown,
): SessionSandboxBindingV1 {
	const value = snapshotObject(input, [
		"schemaVersion",
		"sandboxId",
		"sessionId",
		"agentId",
		"principal",
		"channelId",
		"generation",
		"resourceName",
		"workspaceScope",
	]);
	if (
		value.schemaVersion !== 1 ||
		typeof value.sandboxId !== "string" ||
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
			value.sandboxId,
		) ||
		!isText(value.sessionId) ||
		!isText(value.agentId) ||
		!isText(value.channelId) ||
		!isPositiveSafeInteger(value.generation) ||
		value.resourceName !== `sandbox-${value.sandboxId}` ||
		value.workspaceScope !== value.sandboxId
	)
		unavailable();
	return {
		schemaVersion: 1,
		sandboxId: value.sandboxId,
		sessionId: value.sessionId,
		agentId: value.agentId,
		principal: parseTaskPrincipalV1(value.principal),
		channelId: value.channelId,
		generation: value.generation,
		resourceName: value.resourceName,
		workspaceScope: value.workspaceScope,
	};
}
