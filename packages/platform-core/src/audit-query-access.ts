import {
	type PlatformAuditQueryScopeV1,
	PlatformAuditScopeErrorV1,
	type PlatformExecutionAuditBindingV1,
	requirePlatformExecutionAuditBindingV1,
} from "./audit-query.js";

/** Selected database columns; the full attempt metadata is checked on projection. */
export interface PlatformAuditCandidateV1 {
	readonly source: "platform" | "conversation";
	readonly action: string;
	readonly actorType: string;
	readonly actorId: string;
	readonly targetType: string;
	readonly targetId: string;
	readonly agentId: string | null;
	readonly conversationId: string | null;
	readonly executionId: string | null;
	readonly executionConversationId: string | null;
	readonly binding: PlatformExecutionAuditBindingV1 | null;
	readonly attempt: {
		readonly schemaVersion: unknown;
		readonly operation: unknown;
		readonly phase: unknown;
		readonly targetKind: unknown;
		readonly targetAgentId: unknown;
	} | null;
}

/** Current Agent use rights are checked by Store in the same transaction. */
export function requirePlatformAuditCandidateAccessV1(
	candidate: PlatformAuditCandidateV1,
	scope: PlatformAuditQueryScopeV1,
): void {
	if (scope.kind === "administrator") return;
	if (!candidate.agentId) throw new PlatformAuditScopeErrorV1("access_denied");
	if (candidate.binding) {
		const binding = candidate.binding;
		requirePlatformExecutionAuditBindingV1(binding, scope);
		if (
			candidate.executionId !== binding.executionId ||
			candidate.agentId !== binding.agentId ||
			(binding.channelId.startsWith("api:") &&
				binding.channelId !== `api:${scope.principal.kind}`) ||
			(scope.principal.kind === "application" &&
				binding.channelId !== "api:application") ||
			(candidate.source === "conversation" &&
				(candidate.conversationId !== candidate.executionConversationId ||
					candidate.actorId !== binding.actorId)) ||
			(candidate.source === "platform" &&
				!(
					(candidate.actorType === scope.principal.kind &&
						candidate.actorId === scope.principal.id) ||
					(candidate.actorType === "system" &&
						["task.status.changed", "task.control.created"].includes(
							candidate.action,
						))
				))
		)
			throw new PlatformAuditScopeErrorV1("access_denied");
		return;
	}
	const attempt = candidate.attempt;
	if (
		candidate.source !== "platform" ||
		candidate.executionId !== null ||
		candidate.targetType !== "agent" ||
		candidate.targetId !== candidate.agentId ||
		candidate.actorType !== scope.principal.kind ||
		candidate.actorId !== scope.principal.id ||
		attempt?.schemaVersion !== 1 ||
		attempt.operation !== "submit" ||
		attempt.targetKind !== "agent" ||
		attempt.targetAgentId !== candidate.agentId ||
		!(
			(candidate.action === "task.api.access" && attempt.phase === "access") ||
			(candidate.action === "task.api.submit.result" &&
				attempt.phase === "submit.result")
		)
	)
		throw new PlatformAuditScopeErrorV1("access_denied");
}
