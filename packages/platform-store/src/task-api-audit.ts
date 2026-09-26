import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	parseTaskApiAuditInputV1,
	TaskApiAuditError,
	type TaskApiAuditInputV1,
	type TaskApiAuditPlanV1,
	type TaskApiAuditStoreV1,
	taskApiSubscriptionEndAuditIdV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";

export interface PostgresTaskApiAuditOptionsV1 {
	readonly databaseUrl: string;
}
interface SubscriptionIntent {
	readonly schemaVersion: 1;
	readonly ownerId: string;
	readonly startedAuditId: string;
	readonly endInput: TaskApiAuditInputV1;
}
interface SubscriptionRow {
	readonly id: string;
	readonly scope_id: string;
	readonly payload: unknown;
	readonly status: string;
	readonly delivery_fence: string;
	readonly lease_owner: string | null;
	readonly lease_active: boolean | null;
	readonly trace_id: string;
	readonly request_id: string | null;
}
function endIntent(input: TaskApiAuditInputV1): TaskApiAuditInputV1 {
	return {
		schemaVersion: 1,
		auditId: taskApiSubscriptionEndAuditIdV1(input.subscriptionId as string),
		operation: "subscribe",
		phase: "subscription.ended",
		result: "failed",
		reason: "subscription_unconfirmed",
		principal: input.principal,
		target: input.target,
		requestId: input.requestId,
		traceId: input.traceId,
		subscriptionId: input.subscriptionId,
	};
}
function auditRow(plan: TaskApiAuditPlanV1) {
	const target = plan.target;
	return {
		id: plan.auditId,
		traceId: plan.traceId,
		requestId: plan.requestId,
		actorType: plan.principal.kind,
		actorId: plan.principal.kind === "unknown" ? "unknown" : plan.principal.id,
		action: plan.action,
		targetType: target.kind,
		targetId:
			target.kind === "unknown"
				? "unknown"
				: target.kind === "agent"
					? target.agentId
					: target.kind === "conversation"
						? target.conversationId
						: target.executionId,
		agentId: target.kind === "unknown" ? null : target.agentId,
		outcome: plan.result,
		occurredAt: plan.occurredAt,
		details: {
			schemaVersion: 1,
			operation: plan.operation,
			phase: plan.phase,
			reason: plan.reason,
			target: plan.target,
			...(plan.subscriptionId === undefined
				? {}
				: { subscriptionId: plan.subscriptionId }),
		},
	};
}
async function requireAudit(
	transaction: postgres.TransactionSql,
	plan: TaskApiAuditPlanV1,
): Promise<void> {
	const row = auditRow(plan);
	const [existing] = await transaction<ReturnType<typeof auditRow>[]>`
		select id, trace_id as "traceId", request_id as "requestId", actor_type as "actorType", actor_id as "actorId",
			action, target_type as "targetType", target_id as "targetId", agent_id as "agentId", outcome,
			occurred_at as "occurredAt", details from platform.audit_events where id=${row.id}
	`;
	if (!existing) throw new TaskApiAuditError("unavailable");
	const { occurredAt: _existingTime, ...existingPayload } = existing;
	const { occurredAt: _newTime, ...newPayload } = row;
	if (!isDeepStrictEqual(existingPayload, newPayload))
		throw new TaskApiAuditError("unavailable");
}
export async function writeTaskApiAudit(
	transaction: postgres.TransactionSql,
	plan: TaskApiAuditPlanV1,
): Promise<void> {
	const row = auditRow(plan);
	const inserted = await transaction`
		insert into platform.audit_events (id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,agent_id,outcome,occurred_at,details)
		values (${row.id},${row.traceId},${row.requestId},${row.actorType},${row.actorId},${row.action},${row.targetType},${row.targetId},${row.agentId},${row.outcome},${row.occurredAt},${transaction.json(row.details as never)})
		on conflict (id) do nothing returning id
	`;
	if (inserted.length === 0) await requireAudit(transaction, plan);
}
function readIntent(row: SubscriptionRow): SubscriptionIntent {
	const payload = row.payload as SubscriptionIntent;
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(payload).length !== 4 ||
		!["schemaVersion", "ownerId", "startedAuditId", "endInput"].every((key) =>
			Object.hasOwn(payload, key),
		) ||
		payload.schemaVersion !== 1 ||
		typeof payload.ownerId !== "string" ||
		!/^[0-9a-f-]{36}$/.test(payload.ownerId) ||
		!payload.endInput ||
		Object.hasOwn(payload.endInput, "occurredAt")
	)
		throw new TaskApiAuditError("unavailable");
	const parsed = parseTaskApiAuditInputV1(payload.endInput);
	if (
		parsed.phase !== "subscription.ended" ||
		parsed.reason !== "subscription_unconfirmed" ||
		parsed.result !== "failed" ||
		parsed.subscriptionId !== row.scope_id ||
		row.id !== taskApiSubscriptionEndAuditIdV1(row.scope_id) ||
		parsed.auditId !== taskApiSubscriptionEndAuditIdV1(row.scope_id) ||
		parsed.traceId !== row.trace_id ||
		parsed.requestId !== row.request_id
	)
		throw new TaskApiAuditError("unavailable");
	const { occurredAt: _time, ...endInput } = parsed;
	return {
		schemaVersion: 1,
		ownerId: payload.ownerId,
		startedAuditId: payload.startedAuditId,
		endInput,
	};
}
async function requireStart(
	transaction: postgres.TransactionSql,
	intent: SubscriptionIntent,
): Promise<void> {
	const started = parseTaskApiAuditInputV1({
		...intent.endInput,
		auditId: intent.startedAuditId,
		phase: "subscription.started",
		result: "succeeded",
		reason: "request_accepted",
	});
	await requireAudit(transaction, {
		...started,
		action: "task.api.subscription.started",
	});
}

export class PostgresTaskApiAuditStoreV1 implements TaskApiAuditStoreV1 {
	readonly #client;
	readonly #ownerId = randomUUID();
	constructor(options: PostgresTaskApiAuditOptionsV1) {
		this.#client = postgres(options.databaseUrl, {
			max: 1,
			connect_timeout: 1,
		});
	}
	async #subscription(
		transaction: postgres.TransactionSql,
		subscriptionId: string,
	): Promise<SubscriptionRow> {
		const [row] = await transaction<SubscriptionRow[]>`
			select id, scope_id, payload, status, delivery_fence::text, lease_owner,
				lease_expires_at > clock_timestamp() as lease_active, trace_id, request_id
			from platform.outbox_items where id=${taskApiSubscriptionEndAuditIdV1(subscriptionId)}
				and scope_type='task_api_subscription' and operation='task.api.subscription.end'
			for update
		`;
		if (!row) throw new TaskApiAuditError("unavailable");
		return row;
	}
	async #complete(
		transaction: postgres.TransactionSql,
		row: SubscriptionRow,
	): Promise<void> {
		const completed = await transaction`
			update platform.outbox_items set status='succeeded', lease_owner=null, lease_expires_at=null, updated_at=clock_timestamp()
			where id=${row.id} and scope_type='task_api_subscription' and operation='task.api.subscription.end'
				and status='processing' and lease_owner=${this.#ownerId} and delivery_fence=${row.delivery_fence}::bigint
				and lease_expires_at > clock_timestamp() returning id
		`;
		if (completed.length !== 1) throw new TaskApiAuditError("unavailable");
	}
	async write(plan: TaskApiAuditPlanV1): Promise<void> {
		try {
			const { action, ...input } = plan;
			const parsed = parseTaskApiAuditInputV1(input);
			const expectedAction = `task.api.${parsed.phase}`;
			if (action !== expectedAction)
				throw new TaskApiAuditError("invalid_input");
			const value = { ...parsed, action };
			await this.#client.begin(async (transaction) => {
				if (value.phase === "access" || value.phase === "submit.result") {
					await writeTaskApiAudit(transaction, value);
					return;
				}
				const subscriptionId = value.subscriptionId as string;
				if (value.phase === "subscription.started") {
					const payload: SubscriptionIntent = {
						schemaVersion: 1,
						ownerId: this.#ownerId,
						startedAuditId: value.auditId,
						endInput: endIntent(value),
					};
					await transaction`
						insert into platform.outbox_items (id,scope_type,scope_id,operation,payload,status,attempt_count,lease_owner,lease_expires_at,delivery_fence,trace_id,request_id)
						values (${taskApiSubscriptionEndAuditIdV1(subscriptionId)},'task_api_subscription',${subscriptionId},'task.api.subscription.end',${transaction.json(payload as never)},'processing',1,${this.#ownerId},clock_timestamp()+interval '30 seconds',1,${value.traceId},${value.requestId})
						on conflict (id) do nothing
					`;
					const row = await this.#subscription(transaction, subscriptionId);
					if (
						!isDeepStrictEqual(readIntent(row), payload) ||
						row.status !== "processing" ||
						row.delivery_fence !== "1" ||
						row.lease_owner !== this.#ownerId ||
						!row.lease_active
					)
						throw new TaskApiAuditError("unavailable");
					await writeTaskApiAudit(transaction, value);
					return;
				}
				const row = await this.#subscription(transaction, subscriptionId);
				const intent = readIntent(row);
				if (
					value.auditId !== taskApiSubscriptionEndAuditIdV1(subscriptionId) ||
					intent.ownerId !== this.#ownerId ||
					row.delivery_fence !== "1" ||
					!isDeepStrictEqual(intent.endInput, endIntent(value))
				)
					throw new TaskApiAuditError("unavailable");
				await requireStart(transaction, intent);
				if (row.status === "succeeded") {
					await requireAudit(transaction, value);
					return;
				}
				if (
					row.status !== "processing" ||
					row.lease_owner !== this.#ownerId ||
					!row.lease_active
				)
					throw new TaskApiAuditError("unavailable");
				await writeTaskApiAudit(transaction, value);
				await this.#complete(transaction, row);
			});
		} catch {
			throw new TaskApiAuditError("unavailable");
		}
	}
	async renewSubscription(subscriptionId: string): Promise<void> {
		try {
			await this.#client.begin(async (transaction) => {
				const row = await this.#subscription(transaction, subscriptionId);
				if (
					readIntent(row).ownerId !== this.#ownerId ||
					row.delivery_fence !== "1"
				)
					throw new TaskApiAuditError("unavailable");
				const renewed = await transaction`
					with decision_time as materialized (select clock_timestamp() as decision_at)
					update platform.outbox_items set lease_expires_at=greatest(lease_expires_at,decision_time.decision_at+interval '30 seconds'),updated_at=decision_time.decision_at
					from decision_time where id=${row.id} and status='processing' and lease_owner=${this.#ownerId} and delivery_fence=1
						and lease_expires_at>decision_time.decision_at returning id
				`;
				if (renewed.length !== 1) throw new TaskApiAuditError("unavailable");
			});
		} catch {
			throw new TaskApiAuditError("unavailable");
		}
	}
	async recoverSubscriptions(): Promise<number> {
		try {
			let recovered = 0;
			for (let index = 0; index < 256; index++) {
				const changed = await this.#client.begin(async (transaction) => {
					const [row] = await transaction<SubscriptionRow[]>`
						select id,scope_id,payload,status,delivery_fence::text,lease_owner,false as lease_active,trace_id,request_id
						from platform.outbox_items where scope_type='task_api_subscription' and operation='task.api.subscription.end'
							and status='processing' and lease_expires_at<=clock_timestamp()
						order by lease_expires_at,id limit 1 for update skip locked
					`;
					if (!row) return false;
					const intent = readIntent(row);
					await requireStart(transaction, intent);
					const [claimed] = await transaction<
						{ delivery_fence: string; observed_at: Date }[]
					>`
						with decision_time as materialized (select clock_timestamp() as decision_at)
						update platform.outbox_items set lease_owner=${this.#ownerId}, lease_expires_at=decision_time.decision_at+interval '30 seconds',
							delivery_fence=delivery_fence+1,attempt_count=attempt_count+1,updated_at=decision_time.decision_at
						from decision_time where id=${row.id} and status='processing' and delivery_fence=${row.delivery_fence}::bigint
							and lease_expires_at<=decision_time.decision_at returning delivery_fence::text,updated_at as observed_at
					`;
					if (!claimed) return false;
					const parsed = parseTaskApiAuditInputV1({
						...intent.endInput,
						occurredAt: claimed.observed_at,
					});
					await writeTaskApiAudit(transaction, {
						...parsed,
						action: "task.api.subscription.ended",
					});
					await this.#complete(transaction, {
						...row,
						delivery_fence: claimed.delivery_fence,
					});
					return true;
				});
				if (!changed) break;
				recovered++;
			}
			return recovered;
		} catch {
			throw new TaskApiAuditError("unavailable");
		}
	}
	async close(): Promise<void> {
		await this.#client.end();
	}
}
