import {
	type OperationsTaskQueryV2,
	type OperationsTasksV2,
	operationsTaskEvidenceLimitV2,
} from "@agent-infra/contracts/pilot";
import {
	OperationsScopeErrorV2,
	type OperationsTaskFactV2,
	projectOperationsTaskV2,
} from "@agent-infra/platform-core";
import postgres from "./observed-postgres.js";

type TaskRow = {
	executionId: string;
	status: OperationsTasksV2["tasks"][number]["status"];
	createdAt: Date;
	terminalAt: Date | null;
	unknownSince: Date | null;
	observedPodUid: string | null;
};
const taskLimit = 48;
const scanLimit = 1152;
const eventLimit = 96;
const outboxEventLimit = 12;
const queryDeadlineMs = 3000;

export class PostgresOperationsTaskStoreV2 {
	readonly #sql: ReturnType<typeof postgres>;
	constructor(
		databaseUrl: string,
		private readonly scope: { clusterId: string; namespace: string },
		pool?: ReturnType<typeof postgres>,
	) {
		this.#sql =
			pool ??
			postgres(databaseUrl, {
				max: 2,
				connect_timeout: 3,
				connection: { statement_timeout: queryDeadlineMs },
			});
	}
	async close() {
		await this.#sql.end();
	}
	async read(
		input: OperationsTaskQueryV2,
		requestSignal: AbortSignal,
		includeObservedPod = false,
	): Promise<OperationsTasksV2> {
		const deadline = performance.now() + queryDeadlineMs;
		const signal = AbortSignal.any([
			requestSignal,
			AbortSignal.timeout(queryDeadlineMs),
		]);
		signal.throwIfAborted();
		let stopWaiting = () => {};
		const aborted = new Promise<never>((_, reject) => {
			stopWaiting = () => reject(signal.reason);
			signal.addEventListener("abort", stopWaiting, { once: true });
		});
		const result = this.#sql.begin(
			"isolation level repeatable read read only",
			async (tx) => {
				// A queued BEGIN can run after the caller has timed out.
				const assertActive = () => {
					signal.throwIfAborted();
					const remaining = Math.floor(deadline - performance.now());
					if (remaining < 1) throw new Error("Operations query timed out");
					return remaining;
				};
				async function execute<T extends readonly unknown[]>(
					query: postgres.PendingQuery<T>,
				) {
					assertActive();
					const cancel = () => query.cancel();
					signal.addEventListener("abort", cancel, { once: true });
					try {
						const result = await query;
						assertActive();
						return result;
					} finally {
						signal.removeEventListener("abort", cancel);
					}
				}
				async function run<T extends readonly unknown[]>(
					query: postgres.PendingQuery<T>,
				) {
					const remaining = assertActive();
					await execute(
						tx`select set_config('statement_timeout', ${String(remaining)}, true)`,
					);
					return execute(query);
				}

				const selected = await run(tx`
				select 1 from platform.conversations c
				join platform.session_sandbox_allocations a on a.conversation_id=c.id
					and a.agent_id=c.agent_id and a.session_generation=c.session_generation
					and a.actor_id=c.actor_id and a.principal_type=c.principal_type and a.channel_id=c.channel_id
				where c.id=${input.sessionId} and c.agent_id=${input.agentId}
					and a.resource_policy->>'namespace'=${this.scope.namespace}`);
				if (!selected.length) throw new OperationsScopeErrorV2();
				const candidates = await run(tx<TaskRow[]>`
				with candidates as materialized (
                    select execution_id, status, created_at, terminal_observed_at, unknown_since,
                        sandbox_id, conversation_id, agent_id, session_generation, actor_id, channel_id, principal_type
                    from platform.conversation_executions
                    where conversation_id=${input.sessionId} and agent_id=${input.agentId}
                      and created_at < ${input.end}::timestamptz
                    order by created_at desc, execution_id limit ${taskLimit + 1}
                )
                select e.execution_id as "executionId", e.status, e.created_at as "createdAt",
                    e.terminal_observed_at as "terminalAt", e.unknown_since as "unknownSince",
                    case when ${includeObservedPod} and e.terminal_observed_at < ${input.end}::timestamptz
                        and e.created_at <= e.terminal_observed_at then (
                        select case when count(*)=1 and min(p.first_seen)<=e.created_at
                            and max(p.last_seen)>=e.terminal_observed_at then min(p.uid) end
                        from (
                            select i.uid, i.first_seen, i.last_seen
                            from platform.session_sandbox_allocations a
                            join platform.operations_resource_identities i on i.name=a.resource_name
                              and i.session_id=a.conversation_id and i.agent_id=a.agent_id
                            where a.sandbox_id=e.sandbox_id and a.conversation_id=e.conversation_id
                              and a.agent_id=e.agent_id and a.session_generation=e.session_generation
                              and a.actor_id=e.actor_id and a.channel_id=e.channel_id and a.principal_type=e.principal_type
                              and a.resource_policy->>'namespace'=${this.scope.namespace}
                              and i.namespace=${this.scope.namespace} and i.cluster_id=${this.scope.clusterId}
                              and i.kind='Pod' and i.first_seen<=i.last_seen
                              and i.first_seen<=e.terminal_observed_at and i.last_seen>=e.created_at
                            limit 2
                        ) p
                    ) end as "observedPodUid"
                from candidates e order by e.created_at desc, e.execution_id`);
				let truncated = candidates.length > taskLimit;
				let remaining = scanLimit - candidates.length;
				const tasks: OperationsTasksV2["tasks"] = [];
				for (const task of candidates.slice(0, taskLimit)) {
					if (remaining < 3) {
						truncated = true;
						break;
					}
					const readSize = Math.min(eventLimit + 1, remaining);
					// Bound the indexed sequence scan before inspecting event types or payload fields.
					const events = await run(tx<OperationsTaskFactV2[]>`
					with bounded as materialized (
						select sequence, occurred_at, event_type, event_payload
						from platform.conversation_events
						where execution_id=${task.executionId} and conversation_id=${input.sessionId}
						order by sequence desc limit ${readSize}
					)
					select coalesce(case when event_type='execution.operation' then event_payload->'fact'->>'kind'
							when event_type='conversation.error' then 'runtime-error' end,event_type) as kind,
						case when event_type='execution.operation' then event_payload->'fact'->>'phase'
							when event_type in ('task.status','execution.status') then event_payload->>'status' end as state,
						occurred_at as at,
						case when event_type='execution.operation' then event_payload->'fact'->>'failureCode'
							when event_type='task.status' then event_payload->>'reason'
							when event_type='conversation.error' then event_payload->>'code' end as code,
						case when event_type='execution.operation' then event_payload->'fact'->>'operationRef' end as "operationRef",
						case when event_type='execution.operation' then event_payload->'fact'->>'attemptRef' end as "attemptRef",
						case when event_type='execution.operation' then event_payload->'fact'->>'startedAt' end as "startedAt",
						case when event_type='execution.operation' then event_payload->'fact'->>'finishedAt' end as "finishedAt"
					from bounded order by sequence asc`);
					truncated ||= events.length === readSize;
					remaining -= events.length;
					const dispatch: OperationsTaskFactV2[] = [];
					for (const [id, operation] of [
						[
							`conversation:turn:${task.executionId}`,
							"conversation.turn.submit.v1",
						],
						[
							`conversation:regenerate:${task.executionId}`,
							"conversation.turn.regenerate.v1",
						],
					] as const) {
						// Two primary key lookups per Execution and bounded stream reads.
						if (remaining < 2) {
							truncated = true;
							break;
						}
						remaining -= 1;
						const limit = Math.min(outboxEventLimit + 1, remaining);
						const rows = await run(tx<OperationsTaskFactV2[]>`
						with bounded as materialized (
							select p.event_type,p.occurred_at,p.payload
							from platform.persisted_events p
							where p.stream_id=${`outbox:${id}`} and exists (
								select 1 from platform.outbox_items o where o.id=${id}
									and o.scope_type='conversation' and o.scope_id=${input.sessionId}
									and o.operation=${operation} and o.payload->>'executionId'=${task.executionId}
							)
							order by p.sequence desc limit ${limit}
						)
						select case when event_type='outbox.failed' then 'dispatch-failure' else event_type end as kind,
							null::text as state, occurred_at as at,
							case when event_type='outbox.failed' then payload->>'errorCode' end as code
						from bounded`);
						truncated ||= rows.length === limit;
						remaining -= rows.length;
						dispatch.push(...rows);
					}
					const projection: OperationsTasksV2["tasks"][number] =
						projectOperationsTaskV2(task, [...events, ...dispatch], input);
					if (projection.evidence.length > operationsTaskEvidenceLimitV2) {
						projection.evidence = projection.evidence.slice(
							0,
							operationsTaskEvidenceLimitV2,
						);
						truncated = true;
					}
					if (includeObservedPod)
						projection.observedPodUid = task.observedPodUid;
					if (projection.evidence.length) tasks.push(projection);
				}
				return {
					schemaVersion: 2,
					source: "platform",
					truncated,
					tasks,
					state: tasks.length || truncated ? "available" : "missing",
				} satisfies OperationsTasksV2;
			},
		);
		try {
			return await Promise.race([aborted, result]);
		} finally {
			signal.removeEventListener("abort", stopWaiting);
		}
	}
}
