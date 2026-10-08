import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AgentWorkloadDesiredV1Schema } from "@agent-infra/contracts/workload";
import {
	isSessionSandboxObservationValidV1,
	isSessionSandboxReadyV1,
	parseSessionSandboxBindingV1,
	type SessionSandboxBindingV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxPolicyV1,
	type SessionSandboxRuntimeStateV1,
} from "@agent-infra/platform-core";
import type { Transaction } from "./conversation-execution-common.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

/** Read-only history: missing allocation is not Runtime readiness or command authority.
 * Fixed aliases: c is Conversation; s is the allocation joined only by conversation_id.
 * A present but mismatched allocation must never fall through as legacy history.
 */
export const conversationSandboxReadBindingSql = `
 ((s.sandbox_id is null and not exists (
   select 1 from platform.conversation_audit_events allocation
   where allocation.conversation_id = c.id
     and allocation.action = 'conversation.sandbox.allocated'
 )) or (
   s.agent_id = c.agent_id and s.actor_id = c.actor_id
   and s.principal_type = c.principal_type and s.channel_id = c.channel_id
   and s.session_generation = c.session_generation
 ))
 and not exists (
   select 1 from platform.conversation_executions binding
   where binding.conversation_id = c.id
     and binding.sandbox_id is distinct from s.sandbox_id
 )
`;

/**
 * Whether a prepared Sandbox policy still matches the Agent's current
 * configuration, management fence and verified ready deployment. A Sandbox
 * prepared before a configuration or Workload change is stale until upgraded.
 */
export function isSessionSandboxPolicyCurrentV1(input: {
	readonly agentId: string;
	readonly policy: SessionSandboxRuntimeStateV1["policy"] | null;
	readonly configurationRevision: number;
	readonly managementFence: number;
	readonly lifecycleRevision: number;
	readonly workloadState: unknown;
}): boolean {
	const { policy } = input;
	if (!policy) return false;
	const decoded = decodePersistedWorkloadStateV1(
		input.workloadState,
		input.agentId,
	);
	if (!decoded || decoded.legacy || !decoded.state.verified) return false;
	const verified = decoded.state.verified;
	const parsed = AgentWorkloadDesiredV1Schema.safeParse(verified.deployment);
	if (!parsed.success) return false;
	const deployment = parsed.data;
	return !(
		policy.configurationRevision !== input.configurationRevision ||
		policy.managementFence !== input.managementFence ||
		// The policy binds the verified deployment's Workload revision (checked
		// below); the management lifecycle has its own source (#1480).
		decoded.state.sourceLifecycleRevision !== input.lifecycleRevision ||
		decoded.state.phase !== "ready" ||
		decoded.state.verifiedRevision === null ||
		decoded.state.sourceConfigurationRevision !==
			policy.configurationRevision ||
		verified.configuration.revision !== policy.configurationRevision ||
		deployment.agentId !== input.agentId ||
		deployment.configRevision !== policy.configurationRevision ||
		deployment.workloadRevision !== policy.workloadRevision ||
		deployment.imageDigest !== policy.imageDigest ||
		verified.executionCapacity?.resourceConfigurationHash !==
			policy.resourceConfigurationHash
	);
}

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
			application_id: string;
			management_revision: number;
			management_desired_state: string;
			desired_state: SessionSandboxRuntimeStateV1["desiredState"];
			status: SessionSandboxRuntimeStateV1["status"];
			resource_policy: SessionSandboxRuntimeStateV1["policy"];
			resource_observation: SessionSandboxRuntimeStateV1["observation"];
		}[]
	>`
		select s.resource_fence::text, s.desired_state, s.status, s.resource_policy, s.resource_observation,
			a.current_configuration_revision as configuration_revision,
			m.fence::text as management_fence, m.workload_revision, w.state as workload_state,
			m.id as application_id, m.management_revision, m.desired_state as management_desired_state
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
	// A management transition closes business readiness while the original
	// Execution may still require its signed stop/status route. Only persisted
	// preparation facts survive here; current configuration cannot recreate them.
	if (row.desired_state === "stopped") {
		const intents = await transaction<
			{ payload: { lifecycle?: SessionSandboxLifecycleV1 } }[]
		>`
			select payload from platform.outbox_items where scope_type = 'conversation'
				and scope_id = ${sandbox.sessionId} and operation = 'conversation.sandbox.reconcile.v1'`;
		const lifecycle =
			intents.length === 1 ? intents[0]?.payload.lifecycle : null;
		const source = lifecycle?.source;
		const authority = lifecycle?.authority;
		const parsedSource = AgentWorkloadDesiredV1Schema.safeParse(
			source?.deployment,
		);
		if (
			lifecycle?.schemaVersion !== 1 ||
			!source?.policy ||
			!source.observation ||
			!authority ||
			lifecycle.stopReceipt ||
			lifecycle.preparation ||
			authority.kind !== "management" ||
			authority.applicationId !== row.application_id ||
			authority.managementRevision > Number(row.management_revision) ||
			authority.managementFence !== Number(row.management_fence) ||
			authority.workloadRevision !== Number(row.workload_revision) ||
			authority.targetDesiredState !== row.management_desired_state ||
			!isDeepStrictEqual(source.sandbox, sandbox) ||
			!Number.isSafeInteger(source.resourceFence) ||
			source.resourceFence < 1 ||
			!Number.isSafeInteger(resourceFence) ||
			source.resourceFence >= resourceFence ||
			source.policy.namespace !== workerPolicy.namespace ||
			!isDeepStrictEqual(source.policy, policy) ||
			!isDeepStrictEqual(source.observation, row.resource_observation) ||
			!isSessionSandboxObservationValidV1(
				{ sandbox, policy: source.policy, desiredState: "running" },
				{ ...source.observation, status: "ready" },
			) ||
			!parsedSource.success
		)
			return null;
		const deployment = parsedSource.data;
		if (
			deployment.agentId !== sandbox.agentId ||
			deployment.desiredState !== "running" ||
			deployment.runtimeManifest.interactionMode !== "platform-adapter" ||
			deployment.configRevision !== source.policy.configurationRevision ||
			deployment.workloadRevision !== source.policy.workloadRevision ||
			deployment.imageDigest !== source.policy.imageDigest
		)
			return null;
		return {
			sandbox,
			resourceFence,
			desiredState: row.desired_state,
			status: row.status === "unknown" ? "unknown" : "unavailable",
			policy,
			observation: row.resource_observation,
			controlSource: { ...source, deployment },
		};
	}
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
	if (
		!isSessionSandboxPolicyCurrentV1({
			agentId: sandbox.agentId,
			policy,
			configurationRevision: Number(row.configuration_revision),
			managementFence: Number(row.management_fence),
			lifecycleRevision: Number(row.workload_revision),
			workloadState: row.workload_state,
		})
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
	const [row] = await transaction<
		{
			status: string;
			desired_state: string;
			resource_fence: string | number;
			observation_status: string | null;
		}[]
	>`
   select status, desired_state, resource_fence, resource_observation->>'status' as observation_status
   from platform.session_sandbox_allocations
   where sandbox_id = ${binding.sandboxId} and conversation_id = ${binding.sessionId}
     and session_generation = ${binding.generation}
 `;
	return (
		!!row &&
		isSessionSandboxReadyV1({
			status: row.status,
			desiredState: row.desired_state,
			resourceFence: Number(row.resource_fence),
			observationStatus: row.observation_status,
		})
	);
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
