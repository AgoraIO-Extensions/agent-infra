import type postgres from "postgres";

// Explicit fixture admission; production reads must never backfill legacy rows.
export async function seedSessionSandboxFixture(
	client: postgres.Sql,
	conversationId: string,
) {
	await client`
		insert into platform.session_sandbox_allocations
			(sandbox_id, conversation_id, agent_id, actor_id, principal_type, channel_id,
			 session_generation, resource_name, workspace_scope, status, created_at, updated_at)
		select sandbox_id, id, agent_id, actor_id, principal_type, channel_id,
			session_generation, 'sandbox-' || sandbox_id, sandbox_id, 'allocated', now(), now()
		from (select c.*, gen_random_uuid()::text as sandbox_id
			from platform.conversations c where id = ${conversationId}) admitted
	`;
	await client`update platform.conversation_executions e
		set sandbox_id = s.sandbox_id from platform.session_sandbox_allocations s
		where e.conversation_id = ${conversationId} and s.conversation_id = e.conversation_id`;
	await markSessionSandboxReadyFixture(client, conversationId);
}

/** Controlled Store fixture only; these identities are not Kubernetes acceptance evidence. */
export async function markSessionSandboxReadyFixture(
	client: postgres.Sql,
	conversationId: string,
) {
	await client`update platform.session_sandbox_allocations a
		set status = 'ready', desired_state = 'running', resource_fence = greatest(1, resource_fence),
			resource_observation = jsonb_build_object('status', 'ready', 'resources',
				(select jsonb_agg(jsonb_build_object('kind', kind, 'namespace', 'fixture-sandboxes',
					'name', a.resource_name, 'uid', a.sandbox_id || '-' || kind, 'resourceVersion', '1'))
				from unnest(array['Pod','Service','ServiceAccount','PersistentVolumeClaim','NetworkPolicy','Secret']) as kind))
		where a.conversation_id = ${conversationId}`;
	// A ready Sandbox carries the policy it was prepared with. Bind it to the
	// Agent's current verified deployment unless the test already chose one.
	await client`update platform.session_sandbox_allocations a
		set resource_policy = jsonb_build_object(
			'namespace', 'fixture-sandboxes',
			'resourceConfigurationHash', w.state->'verified'->'executionCapacity'->>'resourceConfigurationHash',
			'configurationRevision', ag.current_configuration_revision,
			'workloadRevision', (w.state->'verified'->'deployment'->>'workloadRevision')::bigint,
			'managementFence', m.fence,
			'imageDigest', w.state->'verified'->'deployment'->>'imageDigest')
		from platform.agents ag
		join platform.agent_applications m on m.agent_id = ag.id
		join platform.workload_reconciliations w on w.agent_id = ag.id
		where a.conversation_id = ${conversationId} and a.resource_policy is null
			and ag.id = a.agent_id
			and jsonb_typeof(w.state->'verified'->'executionCapacity') = 'object'
			and jsonb_typeof(w.state->'verified'->'deployment') = 'object'`;
	await client`update platform.outbox_items set status = 'succeeded', lease_owner = null, lease_expires_at = null
		where scope_type = 'conversation' and scope_id = ${conversationId} and operation = 'conversation.sandbox.reconcile.v1'`;
}
