import { randomUUID } from "node:crypto";
import { AgentWorkloadDesiredV1Schema } from "@agent-infra/contracts/workload";
import {
	isSessionSandboxObservationValidV1,
	parseSessionSandboxBindingV1,
	type SessionSandboxBindingV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxRuntimeStateV1,
} from "@agent-infra/platform-core";
import type { Transaction } from "./conversation-execution-common.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

/** Caller owns the original outbox lease and Conversation lock; this is not an independent reader. */
export async function readSessionSandboxRuntimeState(
	transaction: Transaction,
	sandbox: SessionSandboxBindingV1,
	workerPolicy: SessionSandboxPolicyV1,
): Promise<SessionSandboxRuntimeStateV1 | null> {
	const [row] = await transaction<
		{
			resource_fence: string;
			configuration_revision: number;
			management_fence: string;
			workload_revision: number;
			workload_state: unknown;
			desired_state: SessionSandboxRuntimeStateV1["desiredState"];
			status: SessionSandboxRuntimeStateV1["status"];
			resource_policy: SessionSandboxRuntimeStateV1["policy"];
			resource_observation: SessionSandboxRuntimeStateV1["observation"];
		}[]
	>`
		select s.resource_fence::text, s.desired_state, s.status, s.resource_policy, s.resource_observation,
			a.current_configuration_revision as configuration_revision,
			m.fence::text as management_fence, m.workload_revision, w.state as workload_state
		from platform.session_sandbox_allocations s
		join platform.agents a on a.id = s.agent_id
		join platform.agent_applications m on m.agent_id = s.agent_id
		join platform.workload_reconciliations w on w.agent_id = s.agent_id
		where s.sandbox_id = ${sandbox.sandboxId} and s.conversation_id = ${sandbox.sessionId}
			and s.session_generation = ${sandbox.generation}
	`;
	if (!row) return null;
	const resourceFence = Number(row.resource_fence);
	const policy = row.resource_policy;
	if (
		!Number.isSafeInteger(resourceFence) ||
		resourceFence < 1 ||
		!policy ||
		policy.namespace !== workerPolicy.namespace ||
		policy.resourceConfigurationHash !== workerPolicy.resourceConfigurationHash
	)
		return null;
	// Read current facts without acquiring Agent locks after the Conversation mutex.
	// This receipt never replaces the original prepareRuntimeDispatch authority recheck.
	const decoded = decodePersistedWorkloadStateV1(
		row.workload_state,
		sandbox.agentId,
	);
	if (!decoded || decoded.legacy || !decoded.state.verified) return null;
	const verified = decoded.state.verified;
	const parsed = AgentWorkloadDesiredV1Schema.safeParse(verified.deployment);
	if (!parsed.success) return null;
	const deployment = parsed.data;
	if (
		policy.configurationRevision !== Number(row.configuration_revision) ||
		policy.managementFence !== Number(row.management_fence) ||
		policy.workloadRevision !== Number(row.workload_revision) ||
		decoded.state.phase !== "ready" ||
		decoded.state.verifiedRevision === null ||
		decoded.state.sourceConfigurationRevision !==
			policy.configurationRevision ||
		verified.configuration.revision !== policy.configurationRevision ||
		deployment.agentId !== sandbox.agentId ||
		deployment.configRevision !== policy.configurationRevision ||
		deployment.workloadRevision !== policy.workloadRevision ||
		deployment.imageDigest !== policy.imageDigest ||
		verified.executionCapacity?.resourceConfigurationHash !==
			policy.resourceConfigurationHash
	)
		return null;
	const observation = row.resource_observation;
	if (
		row.status === "ready" &&
		(observation?.status !== "ready" ||
			!isSessionSandboxObservationValidV1(
				{ sandbox, policy, desiredState: row.desired_state },
				observation,
			))
	)
		return null;
	return {
		sandbox,
		resourceFence,
		desiredState: row.desired_state,
		status: row.status,
		policy,
		observation,
	};
}

/** Read after locking Conversation so a resource observation cannot race this snapshot. */
export async function readSessionSandboxReadiness(
	transaction: Transaction,
	binding: SessionSandboxBindingV1,
): Promise<boolean> {
	const [row] = await transaction<{ ready: boolean }[]>`
		select status = 'ready' and desired_state = 'running' and resource_fence > 0
			and resource_observation->>'status' = 'ready' as ready
		from platform.session_sandbox_allocations
		where sandbox_id = ${binding.sandboxId} and conversation_id = ${binding.sessionId}
			and session_generation = ${binding.generation}
	`;
	return row?.ready === true;
}

/** Missing/legacy/mismatched bindings are unavailable, never allocated during a read. */
export async function readSessionSandboxBinding(
	transaction: Transaction,
	conversationId: string,
): Promise<SessionSandboxBindingV1 | undefined> {
	const [row] = await transaction<
		{
			sandbox_id: string;
			conversation_id: string;
			agent_id: string;
			actor_id: string;
			principal_type: string;
			channel_id: string;
			session_generation: number | string;
			resource_name: string;
			workspace_scope: string;
		}[]
	>`
		select a.sandbox_id, a.conversation_id, a.agent_id, a.actor_id, a.principal_type,
			a.channel_id, a.session_generation, a.resource_name, a.workspace_scope
		from platform.session_sandbox_allocations a
		join platform.conversations c on c.id = a.conversation_id
			and c.agent_id = a.agent_id and c.actor_id = a.actor_id
			and c.principal_type = a.principal_type and c.channel_id = a.channel_id
			and c.session_generation = a.session_generation
		where a.conversation_id = ${conversationId}
	`;
	if (!row) return undefined;
	return parseSessionSandboxBindingV1({
		schemaVersion: 1,
		sandboxId: row.sandbox_id,
		sessionId: row.conversation_id,
		agentId: row.agent_id,
		principal: { kind: row.principal_type, id: row.actor_id },
		channelId: row.channel_id,
		generation: Number(row.session_generation),
		resourceName: row.resource_name,
		workspaceScope: row.workspace_scope,
	});
}

/** Called only inside the existing Conversation/Task admission transaction. */
export async function insertSessionSandboxBinding(
	transaction: Transaction,
	input: SessionSandboxBindingV1,
	audit: {
		readonly requestId: string;
		readonly traceId: string;
		readonly occurredAt: Date;
	},
): Promise<void> {
	const binding = parseSessionSandboxBindingV1(input);
	await transaction`
		insert into platform.session_sandbox_allocations
			(sandbox_id, conversation_id, agent_id, actor_id, principal_type, channel_id,
			 session_generation, resource_name, workspace_scope, status, created_at, updated_at)
		values (${binding.sandboxId}, ${binding.sessionId}, ${binding.agentId}, ${binding.principal.id},
			${binding.principal.kind}, ${binding.channelId}, ${binding.generation},
			${binding.resourceName}, ${binding.workspaceScope}, 'allocated', ${audit.occurredAt}, ${audit.occurredAt})
	`;
	await transaction`
		insert into platform.conversation_audit_events
			(id, conversation_id, execution_id, agent_id, actor_id, action, trace_id, request_id, occurred_at, details)
		values (${randomUUID()}, ${binding.sessionId}, null, ${binding.agentId}, ${binding.principal.id},
			'conversation.sandbox.allocated', ${audit.traceId}, ${audit.requestId}, ${audit.occurredAt},
			${transaction.json({ sandboxId: binding.sandboxId, sessionGeneration: binding.generation })})
	`;
	await transaction`
		insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id,
			 available_at, created_at, updated_at)
		values (${`conversation:sandbox:${binding.sessionId}:${binding.generation}`},
			'conversation', ${binding.sessionId}, 'conversation.sandbox.reconcile.v1',
			${transaction.json({ schemaVersion: 1, conversationId: binding.sessionId, sessionGeneration: binding.generation })},
			${audit.traceId}, ${audit.requestId}, ${audit.occurredAt}, ${audit.occurredAt}, ${audit.occurredAt})
	`;
}
