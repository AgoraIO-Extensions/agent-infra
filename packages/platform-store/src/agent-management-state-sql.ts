/**
 * 与 `readAgentManagementState` 同形的 Agent 管理状态 JSON（#2775）。
 *
 * 读取 SQL 里需要在一条查询中带出管理状态时只用这里的片段，不再各自拼装：
 * API 创建的 Agent 没有审批修订号，只有带 `creationChannel: "api"` 时 Core 才接受这种状态；
 * 任何一处漏掉它，沙箱调谐、等待任务复核、最近会话等路径就会把 API 创建的 Agent 判为无效。
 *
 * `applications` 是查询中指向 `platform.agent_applications` 一行（或含其全部列的派生行）的别名。
 * `creation_channel` 与 `readAgentManagementState` 一样从整行 JSON 取值，兼容 0039 迁移之前的表结构。
 */
export function agentManagementStateJsonSql(applications: string): string {
	if (!/^[a-z_][a-z0-9_]*$/.test(applications))
		throw new TypeError("Agent management state alias is invalid");
	const row = applications;
	return `(jsonb_build_object(
		'schemaVersion', 1, 'applicationId', ${row}.id, 'agentId', ${row}.agent_id,
		'applicantId', ${row}.applicant_id, 'status', ${row}.status, 'revision', ${row}.management_revision,
		'approvalRevision', ${row}.approval_revision, 'decisionReason', ${row}.decision_reason,
		'serviceAvailability', ${row}.service_availability, 'desiredState', ${row}.desired_state,
		'workloadRevision', ${row}.workload_revision, 'fence', ${row}.fence, 'failureCode', ${row}.failure_code,
		'ownerIds', (select coalesce(jsonb_agg(management_owner.owner_id order by management_owner.owner_id), '[]'::jsonb)
			from platform.agent_owners management_owner where management_owner.agent_id = ${row}.agent_id),
		'availability', (select coalesce(jsonb_agg(case when management_target.target_type = 'user'
			then jsonb_build_object('kind', 'user', 'userId', management_target.target_id)
			else jsonb_build_object('kind', 'organization', 'organizationId', management_target.target_id) end
			order by management_target.target_type, management_target.target_id), '[]'::jsonb)
			from platform.agent_availability management_target where management_target.agent_id = ${row}.agent_id)
	) || case when to_jsonb(${row})->>'creation_channel' = 'api'
		then jsonb_build_object('creationChannel', 'api') else '{}'::jsonb end)`;
}
