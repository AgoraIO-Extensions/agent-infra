import { randomUUID } from "node:crypto";
import {
	type AgentManagementWritePlanV1,
	parseSessionSandboxBindingV1,
	planSessionSandboxManagementTransitionV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxSourceV1,
} from "@agent-infra/platform-core";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];

/** Caller already owns Agent management/configuration authority in this transaction. */
export async function persistSessionSandboxManagementIntents(
	transaction: Transaction,
	plan: AgentManagementWritePlanV1,
) {
	if (!plan.outboxIntent) return;
	// Lock Conversation before either allocation or its outbox; creation also
	// holds Agent authority, so an admitted Session cannot escape this fanout.
	const sessions = await transaction.execute<{ id: string }>(sql`
		select id from platform.conversations where agent_id = ${plan.state.agentId} order by id for update`);
	for (const { id } of sessions) {
		const [row] = await transaction.execute<{
			sandbox_id: string;
			agent_id: string;
			actor_id: string;
			principal_type: string;
			channel_id: string;
			session_generation: string;
			resource_name: string;
			workspace_scope: string;
			resource_fence: string;
			status: string;
			resource_policy: SessionSandboxSourceV1["policy"];
			resource_observation: SessionSandboxSourceV1["observation"];
		}>(
			sql`select * from platform.session_sandbox_allocations where conversation_id = ${id} for update`,
		);
		if (!row) continue; // Never backfill historical Sessions during management.
		const sandbox = parseSessionSandboxBindingV1({
			schemaVersion: 1,
			sandboxId: row.sandbox_id,
			sessionId: id,
			agentId: row.agent_id,
			principal: { kind: row.principal_type, id: row.actor_id },
			channelId: row.channel_id,
			generation: Number(row.session_generation),
			resourceName: row.resource_name,
			workspaceScope: row.workspace_scope,
		});
		const intents = await transaction.execute<{
			id: string;
			status: string;
			attempt_count: number;
			delivery_fence: string;
			payload: {
				schemaVersion?: unknown;
				conversationId?: unknown;
				sessionGeneration?: unknown;
				lifecycle?: SessionSandboxLifecycleV1;
				sourceSnapshot?: SessionSandboxSourceV1;
				deployment?: unknown;
				modelProjection?: unknown;
			};
		}>(sql`select id, status, attempt_count, delivery_fence::text, payload from platform.outbox_items
			where scope_type = 'conversation' and scope_id = ${id} and operation = 'conversation.sandbox.reconcile.v1' for update`);
		if (intents.length > 1)
			throw new Error("Ambiguous original Sandbox intent");
		const intent = intents[0];
		const next = planSessionSandboxManagementTransitionV1({
			plan,
			status: row.status,
			current: {
				sandbox,
				resourceFence: Number(row.resource_fence),
				policy: row.resource_policy,
				observation: row.resource_observation,
				deployment: intent?.payload.deployment ?? null,
				modelProjection: intent?.payload.modelProjection ?? null,
			},
			previous: intent?.payload.lifecycle ?? null,
			sourceSnapshot: intent?.payload.sourceSnapshot,
			originalIntent:
				intent &&
				intent.id === `conversation:sandbox:${id}:${sandbox.generation}` &&
				intent.payload.schemaVersion === 1 &&
				intent.payload.conversationId === id &&
				intent.payload.sessionGeneration === sandbox.generation &&
				Object.keys(intent.payload).length === 3
					? {
							status: intent.status,
							attemptCount: intent.attempt_count,
							deliveryFence: Number(intent.delivery_fence),
						}
					: undefined,
		});
		const payload = {
			schemaVersion: 1,
			conversationId: id,
			sessionGeneration: sandbox.generation,
			lifecycle: next.lifecycle,
			deployment: intent?.payload.deployment ?? null,
			modelProjection: intent?.payload.modelProjection ?? null,
		};
		await transaction.execute(sql`update platform.session_sandbox_allocations
			set desired_state = ${next.desiredState}, status = ${next.status}, resource_fence = ${next.resourceFence}, updated_at = ${plan.outboxIntent.occurredAt.toISOString()}
			where sandbox_id = ${sandbox.sandboxId}`);
		await transaction.execute(sql`insert into platform.outbox_items
			(id, scope_type, scope_id, operation, payload, trace_id, request_id, available_at, created_at, updated_at, status)
			values (${intent?.id ?? `conversation:sandbox:${id}:${sandbox.generation}`}, 'conversation', ${id}, 'conversation.sandbox.reconcile.v1',
				${JSON.stringify(payload)}::jsonb, ${plan.outboxIntent.traceId}, ${plan.outboxIntent.requestId}, ${plan.outboxIntent.occurredAt.toISOString()}, ${plan.outboxIntent.occurredAt.toISOString()}, ${plan.outboxIntent.occurredAt.toISOString()}, ${next.settled ? "succeeded" : "pending"})
			on conflict (id) do update set payload = excluded.payload, status = excluded.status, lease_owner = null, lease_expires_at = null,
				trace_id = excluded.trace_id, request_id = excluded.request_id, available_at = excluded.available_at, updated_at = excluded.updated_at`);
		if (next.settled) {
			await transaction.execute(sql`insert into platform.audit_events
				(id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, occurred_at, details)
				values (${randomUUID()}, ${plan.auditEvent.traceId}, ${plan.operation.startsWith("observe_") ? "system" : "user"}, ${plan.auditEvent.actorId},
					'conversation.sandbox.never_prepared_stopped', 'sandbox', ${sandbox.sandboxId}, 'succeeded', ${plan.auditEvent.requestId}, ${sandbox.agentId}, ${plan.auditEvent.occurredAt.toISOString()},
					${JSON.stringify({ conversationId: id, sourceResourceFence: 0, resourceFence: next.resourceFence, reason: "never-prepared" })}::jsonb)`);
		}
	}
}
