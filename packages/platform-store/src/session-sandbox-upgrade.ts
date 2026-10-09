import { randomUUID } from "node:crypto";
import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	type AgentManagementStateV1,
	parseSessionSandboxBindingV1,
	planSessionSandboxUpgradeTransitionV1,
	type SessionSandboxBindingV1,
	type SessionSandboxSourceV1,
} from "@agent-infra/platform-core";
import type postgres from "postgres";
import { isSessionSandboxPolicyCurrentV1 } from "./session-sandbox.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

type Transaction = postgres.TransactionSql;
type Json = Parameters<Transaction["json"]>[0];

/**
 * Writes one upgrade intent per idle Session Sandbox whose policy predates the
 * Agent's ready verified Workload state (ADR 0023). Runs inside the Workload
 * write-back after its Agent row lock, then locks Conversation -> allocation
 * -> reconcile outbox like the management fanout. A Sandbox that is busy now
 * is reconsidered by the next periodic write-back.
 */
export async function persistSessionSandboxUpgradeIntents(
	transaction: Transaction,
	input: {
		readonly agentId: string;
		readonly workerId: string;
		readonly traceId: string;
		readonly requestId: string;
	},
): Promise<number> {
	const [agent] = await transaction<
		{
			configuration_revision: string;
			authorization_revision: string;
			application_id: string;
			status: AgentManagementStateV1["status"];
			management_revision: string;
			desired_state: AgentManagementStateV1["desiredState"];
			workload_revision: string;
			fence: string;
			workload_state: unknown;
		}[]
	>`
		select a.current_configuration_revision::text as configuration_revision, a.authorization_revision,
			m.id as application_id, m.status, m.management_revision::text, m.desired_state,
			m.workload_revision::text, m.fence::text, w.state as workload_state
		from platform.agents a
		join platform.agent_applications m on m.agent_id = a.id
		join platform.workload_reconciliations w on w.agent_id = a.id
		where a.id = ${input.agentId}
	`;
	if (!agent) return 0;
	const management = {
		applicationId: agent.application_id,
		agentId: input.agentId,
		status: agent.status,
		revision: Number(agent.management_revision),
		fence: Number(agent.fence),
		workloadRevision: Number(agent.workload_revision),
		desiredState: agent.desired_state,
	};
	const decoded = decodePersistedWorkloadStateV1(
		agent.workload_state,
		input.agentId,
	);
	if (!decoded || decoded.legacy || decoded.state.phase !== "ready") return 0;
	try {
		// Only a deployment a replacement can be prepared from (same gate as
		// the Sandbox prepare claim); otherwise a drain would strand the Session.
		const deployment = validateAgentWorkloadDesiredV1(
			decoded.state.verified?.deployment,
		);
		if (
			deployment.desiredState !== "running" ||
			deployment.runtimeManifest.interactionMode !== "platform-adapter"
		)
			return 0;
	} catch {
		return 0;
	}
	const isCurrent = (policy: SessionSandboxSourceV1["policy"]) =>
		isSessionSandboxPolicyCurrentV1({
			agentId: input.agentId,
			policy,
			configurationRevision: Number(agent.configuration_revision),
			managementFence: management.fence,
			lifecycleRevision: management.workloadRevision,
			workloadState: agent.workload_state,
		});
	// Unlocked candidate scan; each candidate is re-read under its own locks.
	const candidates = await transaction<
		{
			conversation_id: string;
			resource_policy: SessionSandboxSourceV1["policy"];
		}[]
	>`
		select s.conversation_id, s.resource_policy
		from platform.session_sandbox_allocations s
		join platform.conversations c on c.id = s.conversation_id
		where s.agent_id = ${input.agentId} and s.desired_state = 'running' and s.status = 'ready'
			and c.authorization_revision = ${agent.authorization_revision}
		order by s.conversation_id
	`;
	let written = 0;
	for (const candidate of candidates) {
		if (isCurrent(candidate.resource_policy)) continue;
		const conversationId = candidate.conversation_id;
		const [conversation] = await transaction<
			{ authorization_revision: string }[]
		>`select authorization_revision from platform.conversations where id = ${conversationId} for update`;
		// The replacement prepare requires the Agent's current authorization.
		if (conversation?.authorization_revision !== agent.authorization_revision)
			continue;
		const [row] = await transaction<
			{
				sandbox_id: string;
				agent_id: string;
				actor_id: string;
				principal_type: string;
				channel_id: string;
				session_generation: string;
				resource_name: string;
				workspace_scope: string;
				resource_fence: string;
				desired_state: string;
				status: string;
				resource_policy: SessionSandboxSourceV1["policy"];
				resource_observation: SessionSandboxSourceV1["observation"];
			}[]
		>`select * from platform.session_sandbox_allocations where conversation_id = ${conversationId} for update`;
		if (!row) continue;
		let sandbox: SessionSandboxBindingV1;
		try {
			sandbox = parseSessionSandboxBindingV1({
				schemaVersion: 1,
				sandboxId: row.sandbox_id,
				sessionId: conversationId,
				agentId: row.agent_id,
				principal: { kind: row.principal_type, id: row.actor_id },
				channelId: row.channel_id,
				generation: Number(row.session_generation),
				resourceName: row.resource_name,
				workspaceScope: row.workspace_scope,
			});
		} catch {
			continue;
		}
		const intents = await transaction<
			{
				id: string;
				status: string;
				payload: Record<string, unknown>;
			}[]
		>`select id, status, payload from platform.outbox_items
			where scope_type = 'conversation' and scope_id = ${conversationId}
				and operation = 'conversation.sandbox.reconcile.v1' for update`;
		const intent = intents.length === 1 ? intents[0] : undefined;
		const payload = intent?.payload;
		if (
			!intent ||
			!payload ||
			payload.schemaVersion !== 1 ||
			payload.conversationId !== conversationId ||
			payload.sessionGeneration !== sandbox.generation ||
			// A generation isolation snapshot belongs to that flow, not an upgrade.
			Object.hasOwn(payload, "sourceSnapshot")
		)
			continue;
		const executions = await transaction<
			{ status: string }[]
		>`select status from platform.conversation_executions where conversation_id = ${conversationId}`;
		const pending =
			await transaction`select 1 from platform.conversation_generation_tombstones where conversation_id = ${conversationId} and status = 'pending' limit 1`;
		const next = planSessionSandboxUpgradeTransitionV1({
			management,
			current: {
				sandbox,
				resourceFence: Number(row.resource_fence),
				policy: row.resource_policy,
				observation: row.resource_observation,
				deployment: payload.deployment ?? null,
				modelProjection: payload.modelProjection ?? null,
			},
			allocation: { status: row.status, desiredState: row.desired_state },
			intent: { status: intent.status },
			policyCurrent: isCurrent(row.resource_policy),
			executionStatuses: executions.map(({ status }) => status),
			generationBarrierPending: pending.length > 0,
		});
		if (!next) continue;
		await transaction`update platform.session_sandbox_allocations
			set desired_state = ${next.desiredState}, status = ${next.status},
				resource_fence = ${next.resourceFence}, updated_at = clock_timestamp()
			where sandbox_id = ${sandbox.sandboxId}`;
		const reopened = await transaction`update platform.outbox_items
			set payload = ${transaction.json({
				schemaVersion: 1,
				conversationId,
				sessionGeneration: sandbox.generation,
				lifecycle: next.lifecycle,
				deployment: payload.deployment,
				modelProjection: payload.modelProjection ?? null,
			} as unknown as Json)},
				status = 'pending', lease_owner = null, lease_expires_at = null,
				trace_id = ${input.traceId}, request_id = ${input.requestId},
				available_at = clock_timestamp(), updated_at = clock_timestamp()
			where id = ${intent.id} and status = 'succeeded'
			returning id`;
		if (reopened.length !== 1)
			throw new Error("Sandbox upgrade intent changed");
		await transaction`insert into platform.audit_events
			(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, occurred_at, details)
			values (${randomUUID()}, ${input.traceId}, 'system', ${input.workerId},
				'conversation.sandbox.upgrade_requested', 'sandbox', ${sandbox.sandboxId}, 'succeeded',
				${input.requestId}, ${input.agentId}, clock_timestamp(),
				${transaction.json({
					conversationId,
					reason: "upgrade",
					sourceResourceFence: Number(row.resource_fence),
					resourceFence: next.resourceFence,
				})})`;
		written += 1;
	}
	return written;
}
