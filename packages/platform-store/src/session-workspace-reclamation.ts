import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	decideSessionSandboxDrainObservationV1,
	isWorkspaceRetainedV1,
	type SessionSandboxLifecycleV1,
	type SessionSandboxObservationV1,
	type SessionWorkspaceReclamationStoreV1,
	type SessionWorkspaceReclamationTargetV1,
	type SessionWorkspaceRetentionPolicyV1,
	validateWorkspaceRetentionPolicyV1,
} from "@agent-infra/platform-core";
import type { Transaction } from "./conversation-execution-common.js";
import postgres from "./observed-postgres.js";

const started = "conversation.workspace.reclamation.started";
const completed = "conversation.workspace.reclamation.completed";
/** Journal uses existing immutable audit rows; no new authority table or manual SQL entry point. */
export class PostgresSessionWorkspaceReclamationStoreV1
	implements SessionWorkspaceReclamationStoreV1
{
	private readonly sql: ReturnType<typeof postgres>;
	constructor(
		databaseUrl: string,
		private readonly policy: SessionWorkspaceRetentionPolicyV1,
		private readonly owner: string,
	) {
		validateWorkspaceRetentionPolicyV1(policy);
		if (!owner.trim()) throw new Error("WORKSPACE_DEPLOYMENT_OWNER_REQUIRED");
		this.sql = postgres(databaseUrl, {
			max: 2,
			connect_timeout: 5,
			connection: { statement_timeout: 15000, lock_timeout: 5000 },
		});
	}
	async close() {
		await this.sql.end();
	}
	private operation(t: SessionWorkspaceReclamationTargetV1) {
		return createHash("sha256")
			.update(
				JSON.stringify([
					t.sessionGeneration,
					t.resourceFence,
					t.agentId,
					t.sessionId,
					t.sandboxId,
					t.namespace,
					t.name,
					t.uid,
					t.resourceVersion,
				]),
			)
			.digest("hex");
	}
	private async eligible(tx: Transaction, sandboxId?: string) {
		const allocations =
			sandboxId !== undefined
				? tx`platform.session_sandbox_allocations`
				: tx`platform_reclamation_read.allocations`;
		const outbox =
			sandboxId !== undefined
				? tx`platform.outbox_items`
				: tx`platform_reclamation_read.outbox_items`;
		const stoppedAudit =
			sandboxId !== undefined
				? tx`platform.conversation_audit_events`
				: tx`platform_reclamation_read.stopped_audit`;
		const rows = await tx<
			{
				sessionGeneration: number;
				resourceFence: number;
				lifecycle: SessionSandboxLifecycleV1;
				observation: SessionSandboxObservationV1;
				agentId: string;
				sessionId: string;
				sandboxId: string;
				namespace: string;
				name: string;
			}[]
		>`
   select a.session_generation::float8 as "sessionGeneration", a.resource_fence::float8 as "resourceFence", a.agent_id as "agentId", a.conversation_id as "sessionId", a.sandbox_id as "sandboxId", ch.namespace, a.resource_name as name, o.payload->'lifecycle' as lifecycle, a.resource_observation as observation
   from ${allocations} a join platform.conversations c on c.id=a.conversation_id
   join platform.session_sandbox_resource_charges ch on ch.sandbox_id=a.sandbox_id
   join lateral (
     select oi.payload
     from ${outbox} oi
     where oi.scope_type='conversation' and oi.scope_id=c.id and oi.operation='conversation.sandbox.reconcile.v1'
       and oi.status='succeeded' and oi.lease_owner is null
     order by oi.updated_at desc, oi.id desc
     limit 1
   ) o on true
   where (${sandboxId ?? null}::text is null or a.sandbox_id=${sandboxId ?? null})
   and ch.namespace=${this.policy.namespace} and not ch.released and ch.compute_released
   and a.resource_observation->>'status'='stopped'
   and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(a.resource_observation->'resources') = 'array' then a.resource_observation->'resources' end) r where r->>'kind'='PersistentVolumeClaim' and r->>'namespace'=ch.namespace and r->>'name'=a.resource_name)
   and a.status='stopped' and a.desired_state='stopped' and c.status <> 'active'
   and not exists(select 1 from platform.conversation_generation_tombstones t where t.conversation_id=c.id and t.status='pending')
   and c.agent_id=a.agent_id and c.session_generation=a.session_generation
   and o.payload->'lifecycle'->'stopReceipt'->>'sandboxId'=a.sandbox_id
   and o.payload->'lifecycle'->'stopReceipt'->>'sessionId'=c.id
   and o.payload->'lifecycle'->'stopReceipt'->>'targetGeneration'=a.session_generation::text
   and o.payload->'lifecycle'->'stopReceipt'->>'targetResourceFence'=a.resource_fence::text
   and exists(
     select 1
     from ${stoppedAudit} stopped_at
     where stopped_at.conversation_id=c.id
       and stopped_at.action='conversation.sandbox.observed'
       and stopped_at.details->>'sandboxId'=a.sandbox_id
       and stopped_at.details->>'sessionGeneration'=a.session_generation::text
       and stopped_at.details->>'resourceFence'=a.resource_fence::text
       and stopped_at.details->>'status'='stopped'
       and stopped_at.occurred_at <= clock_timestamp()-(${this.policy.minimumStoppedMs}::bigint*interval '1 millisecond')
   )
   and not exists(select 1 from platform.conversation_executions e where e.conversation_id=c.id and e.status not in ('completed','failed','cancelled'))
   and not exists(select 1 from platform.outbox_items pending where pending.scope_type='conversation' and pending.scope_id=c.id and pending.status not in ('succeeded','failed'))
   and not exists(select 1 from platform.audit_events j where j.target_id=c.id and j.action=${started})
   order by a.sandbox_id limit 1000`;
		return rows.flatMap(({ lifecycle, observation, ...row }) => {
			try {
				const source = lifecycle.source.sandbox;
				if (
					source.agentId !== row.agentId ||
					source.sessionId !== row.sessionId ||
					source.sandboxId !== row.sandboxId ||
					source.resourceName !== row.name ||
					lifecycle.preparation ||
					lifecycle.resumeRequested ||
					!isDeepStrictEqual(observation.sourceStop, lifecycle.stopReceipt)
				)
					return [];
				const decision = decideSessionSandboxDrainObservationV1({
					sandbox: { ...source, generation: row.sessionGeneration },
					resourceFence: row.resourceFence,
					lifecycle,
					observation,
				});
				const pvc = decision.stopReceipt?.retainedPVC;
				if (
					decision.status !== "stopped" ||
					pvc?.namespace !== row.namespace ||
					pvc.name !== row.name ||
					!pvc.uid?.trim()
				)
					return [];
				return [{ ...row, uid: pvc.uid }];
			} catch {
				return [];
			}
		});
	}
	async inspect(t: SessionWorkspaceReclamationTargetV1) {
		if (t.namespace !== this.policy.namespace)
			throw new Error("WORKSPACE_SCOPE_CONFLICT");
		const journal = await this.journal(this.sql as unknown as Transaction, t);
		const rows = await this
			.sql`select c.status as conversation_status,a.status as sandbox_status,ch.released,ch.compute_released from platform.conversations c join platform.session_sandbox_allocations a on a.conversation_id=c.id join platform.session_sandbox_resource_charges ch on ch.sandbox_id=a.sandbox_id where c.id=${t.sessionId} and a.sandbox_id=${t.sandboxId} and a.agent_id=${t.agentId} and ch.namespace=${t.namespace}`;
		return { journal, state: rows[0] ?? null };
	}

	async candidates() {
		const rows = await this.sql.begin("read only", (tx) =>
			this.eligible(tx as unknown as Transaction),
		);
		return rows.filter((t) => !isWorkspaceRetainedV1(this.policy, t));
	}
	private async locked<T>(
		t: SessionWorkspaceReclamationTargetV1,
		body: (tx: Transaction) => Promise<T>,
	): Promise<T> {
		if (
			t.namespace !== this.policy.namespace ||
			t.name !== `sandbox-${t.sandboxId}` ||
			!Number.isSafeInteger(t.sessionGeneration) ||
			t.sessionGeneration < 1 ||
			!Number.isSafeInteger(t.resourceFence) ||
			t.resourceFence < 1 ||
			!t.uid ||
			!t.resourceVersion ||
			isWorkspaceRetainedV1(this.policy, t)
		)
			throw new Error("WORKSPACE_RECLAMATION_DENIED");
		return this.sql.begin(async (raw) => {
			const tx = raw as unknown as Transaction;
			// Same ordering as lifecycle/admission; never hold these locks across Kubernetes I/O.
			await tx`select id from platform.agents where id=${t.agentId} for update`;
			const c =
				await tx`select id from platform.conversations where id=${t.sessionId} and agent_id=${t.agentId} for update`;
			const a =
				await tx`select sandbox_id from platform.session_sandbox_allocations where sandbox_id=${t.sandboxId} and conversation_id=${t.sessionId} and agent_id=${t.agentId} for update`;
			await tx`select id from platform.outbox_items where scope_type='conversation' and scope_id=${t.sessionId} order by id for update`;
			if (c.length !== 1 || a.length !== 1)
				throw new Error("WORKSPACE_BINDING_CONFLICT");
			return body(tx);
		}) as Promise<T>;
	}
	private async audit(
		tx: Transaction,
		t: SessionWorkspaceReclamationTargetV1,
		action: string,
	) {
		await tx`insert into platform.audit_events(id,target_id,target_type,agent_id,actor_id,actor_type,outcome,action,trace_id,request_id,occurred_at,details)
  values(${randomUUID()},${t.sessionId},'conversation',${t.agentId},${this.owner},'system','succeeded',${action},${this.operation(t)},${this.operation(t)},clock_timestamp(),${tx.json({ ...t, deploymentOwner: this.owner })})`;
	}
	private async journal(
		tx: Transaction,
		t: SessionWorkspaceReclamationTargetV1,
	) {
		const rows = await tx<
			{ action: string; details: unknown }[]
		>`select action,details from platform.audit_events where target_type='conversation' and target_id=${t.sessionId} and action in (${started},${completed})`;
		if (
			rows.some(
				(r) =>
					!isDeepStrictEqual(r.details, { ...t, deploymentOwner: this.owner }),
			)
		)
			throw new Error("WORKSPACE_OPERATION_CONFLICT");
		return rows;
	}
	async prepare(t: SessionWorkspaceReclamationTargetV1) {
		return this.locked(t, async (tx) => {
			const journal = await this.journal(tx, t);
			if (journal.some((r) => r.action === completed))
				return "completed" as const;
			if (journal.some((r) => r.action === started)) {
				const still =
					await tx`select a.sandbox_id from platform.session_sandbox_allocations a join platform.conversations c on c.id=a.conversation_id where a.sandbox_id=${t.sandboxId} and a.status='unavailable' and c.status='unavailable' and a.desired_state='stopped' and a.session_generation=${t.sessionGeneration} and a.resource_fence=${t.resourceFence} and c.session_generation=a.session_generation`;
				if (still.length !== 1) throw new Error("WORKSPACE_TOMBSTONE_CONFLICT");
				return "prepared" as const;
			}
			const rows = await this.eligible(tx, t.sandboxId);
			const pvc =
				await tx`select a.sandbox_id from platform.session_sandbox_allocations a, jsonb_array_elements(a.resource_observation->'resources') r where a.sandbox_id=${t.sandboxId} and r->>'kind'='PersistentVolumeClaim' and r->>'namespace'=${t.namespace} and r->>'name'=${t.name} and r->>'uid'=${t.uid}`;
			if (pvc.length !== 1) throw new Error("WORKSPACE_PVC_OWNERSHIP_CONFLICT");
			if (
				rows.length !== 1 ||
				!isDeepStrictEqual(rows[0], {
					sessionGeneration: t.sessionGeneration,
					resourceFence: t.resourceFence,
					agentId: t.agentId,
					sessionId: t.sessionId,
					sandboxId: t.sandboxId,
					namespace: t.namespace,
					name: t.name,
					uid: t.uid,
				})
			)
				throw new Error("WORKSPACE_NOT_ELIGIBLE");
			await tx`update platform.conversations set status='unavailable',updated_at=clock_timestamp() where id=${t.sessionId}`;
			await tx`update platform.session_sandbox_allocations set status='unavailable',updated_at=clock_timestamp() where sandbox_id=${t.sandboxId}`;
			await this.audit(tx, t, started);
			return "prepared" as const;
		});
	}
	async complete(t: SessionWorkspaceReclamationTargetV1) {
		await this.locked(t, async (tx) => {
			const journal = await this.journal(tx, t);
			if (journal.some((r) => r.action === completed)) return;
			if (!journal.some((r) => r.action === started))
				throw new Error("WORKSPACE_INTENT_MISSING");
			const binding =
				await tx`select sandbox_id from platform.session_sandbox_allocations a join platform.conversations c on c.id=a.conversation_id where a.sandbox_id=${t.sandboxId} and a.status='unavailable' and c.status='unavailable' and a.desired_state='stopped' and a.session_generation=${t.sessionGeneration} and a.resource_fence=${t.resourceFence} and c.session_generation=a.session_generation`;
			if (binding.length !== 1) throw new Error("WORKSPACE_TOMBSTONE_CONFLICT");
			await tx`select pg_advisory_xact_lock(hashtextextended('session-sandbox:deployment-budget', 0))`;
			const released =
				await tx`update platform.session_sandbox_resource_charges set released=true where sandbox_id=${t.sandboxId} and namespace=${t.namespace} and compute_released and not released returning sandbox_id`;
			if (released.length !== 1) throw new Error("WORKSPACE_CHARGE_CONFLICT");
			await this.audit(tx, t, completed);
		});
	}
}
