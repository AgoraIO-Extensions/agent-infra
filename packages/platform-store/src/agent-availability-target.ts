import type { AgentConfigurationAccessTargetV1 } from "@agent-infra/platform-core";

/**
 * One typed `agent_availability` row (Spec §9.2.2). The target type is part of
 * the identity: a user and an application with the same bare ID never alias.
 */
export function agentAvailabilityTargetId(
	target: AgentConfigurationAccessTargetV1,
): string {
	return target.kind === "user"
		? target.userId
		: target.kind === "organization"
			? target.organizationId
			: target.applicationId;
}

/** Returns undefined for an unknown target type so callers can fail closed. */
export function decodeAgentAvailabilityTarget(row: {
	readonly targetType: unknown;
	readonly targetId: string;
}): AgentConfigurationAccessTargetV1 | undefined {
	if (row.targetType === "user") return { kind: "user", userId: row.targetId };
	if (row.targetType === "organization")
		return { kind: "organization", organizationId: row.targetId };
	if (row.targetType === "application")
		return { kind: "application", applicationId: row.targetId };
	return undefined;
}

export function agentAvailabilityTargetKey(
	target: AgentConfigurationAccessTargetV1,
): string {
	return `${target.kind}\0${agentAvailabilityTargetId(target)}`;
}

/**
 * SQL jsonb for one availability row; an unknown type yields SQL null. The
 * type is compared as text so the query also runs before the enum gained
 * `application`.
 */
export function agentAvailabilityTargetJsonSql(alias: string): string {
	return `case ${alias}.target_type::text
		when 'user' then jsonb_build_object('kind', 'user', 'userId', ${alias}.target_id)
		when 'organization' then jsonb_build_object('kind', 'organization', 'organizationId', ${alias}.target_id)
		when 'application' then jsonb_build_object('kind', 'application', 'applicationId', ${alias}.target_id)
		end`;
}
