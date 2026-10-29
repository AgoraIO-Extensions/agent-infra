import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type EvaluationAnalysisPolicyV1,
	EvaluationDataErrorV1,
	type EvaluationPrincipalV1,
	EvaluationQueryLimitErrorV1,
	type EvaluationRequestV1,
	foldEvaluationModelFactsV1,
	isCurrentTaskFeedbackUseV1,
	parseAgentManagementPortState,
	parseEvaluationAnalysisPolicyV1,
	parseFeedbackSummaryQueryV1,
	parseTaskAuthorizationBoundaryV1,
	parseTaskFeedbackRecordV1,
	resolveCurrentPersonalApiUserV1,
	summarizeTaskFeedbackV1,
	type TaskFeedbackPortV1,
	type TaskFeedbackTargetV1,
	type TaskFeedbackTransactionV1,
	type TaskUserDirectoryV1,
	taskFeedbackConditionDigestV1,
} from "@agent-infra/platform-core";
import type { TransactionSql } from "postgres";
import { agentManagementStateJsonSql } from "./agent-management-state-sql.js";
import { resolveApiAuditCredentialIdentityV1 } from "./api-audit-identity.js";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import postgres from "./observed-postgres.js";

type TaskRow = {
	execution_id: string;
	conversation_id: string;
	agent_id: string;
	actor_id: string;
	principal_type: string;
	channel_id: string;
	status: string;
	terminal_observed_at: Date | null;
	last_event_sequence: number;
	boundary: unknown;
	revoked_at: Date | null;
};
export interface EvaluationFeedbackStoreOptionsV1 {
	databaseUrl: string;
	directory: TaskUserDirectoryV1;
	loadPolicy: () => Promise<EvaluationAnalysisPolicyV1>;
}
export class PostgresEvaluationFeedbackV1 implements TaskFeedbackPortV1 {
	readonly #client;
	constructor(private readonly options: EvaluationFeedbackStoreOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 4 });
	}
	async close() {
		await this.#client.end();
	}
	async #policy(tx: TransactionSql) {
		return bindEvaluationAnalysisPolicyV1(tx, this.options.loadPolicy);
	}
	async #identity(
		tx: TransactionSql,
		request: EvaluationRequestV1,
		scope: "agent:use" | "agent:read",
	) {
		if (request.authentication.kind === "score_work")
			throw new EvaluationDataErrorV1("denied");
		if (request.authentication.kind === "credential") {
			const identity = await resolveApiAuditCredentialIdentityV1(
				tx,
				request.authentication.material,
				this.options.directory,
				scope,
			);
			return {
				principal: identity.identity.principal,
				revalidate: identity.revalidate,
			};
		}
		const id = request.authentication.userId;
		const check = async () => {
			await tx`lock table platform.platform_user_disables in share mode`;
			const disabled =
				await tx`select user_id from platform.platform_user_disables where user_id=${id}`;
			const user = await resolveCurrentPersonalApiUserV1(
				this.options.directory,
				id,
			);
			if (disabled.length || !user || user.accountStatus !== "active")
				throw new EvaluationDataErrorV1("denied");
			return user;
		};
		const user = await check();
		return {
			principal: { kind: "user" as const, id },
			revalidate: async () => {
				if (!isDeepStrictEqual(await check(), user))
					throw new EvaluationDataErrorV1("denied");
			},
		};
	}
	async #task(
		tx: TransactionSql,
		id: string,
		principal: EvaluationPrincipalV1,
	) {
		const [row] = await tx<
			TaskRow[]
		>`select e.execution_id,e.conversation_id,e.agent_id,e.actor_id,e.principal_type,e.channel_id,e.status,e.terminal_observed_at,e.last_event_sequence::int,a.boundary,a.revoked_at from platform.conversation_executions e join platform.task_authorization_records a on a.execution_id=e.execution_id where e.execution_id=${id}`;
		if (
			!row ||
			row.principal_type !== principal.kind ||
			row.actor_id !== principal.id ||
			row.channel_id === "eval"
		)
			throw new EvaluationDataErrorV1("denied");
		const boundary = parseTaskAuthorizationBoundaryV1(row.boundary);
		if (
			boundary.principal.kind !== row.principal_type ||
			boundary.principal.id !== row.actor_id ||
			boundary.agentId !== row.agent_id ||
			boundary.channelId !== row.channel_id
		)
			throw new EvaluationDataErrorV1("unavailable");
		const [state] = await tx<
			{ state: unknown; authorization_revision: string }[]
		>`select ${tx.unsafe(agentManagementStateJsonSql("a"))} as state,g.authorization_revision from platform.agent_applications a join platform.agents g on g.id=a.agent_id where a.agent_id=${row.agent_id}`;
		if (!state) throw new EvaluationDataErrorV1("denied");
		const agent = parseAgentManagementPortState(state.state);
		const useGrant = await readCurrentTaskApiUseGrantV1(tx, {
			principal,
			agentId: row.agent_id,
		});
		const user =
			principal.kind === "user"
				? await resolveCurrentPersonalApiUserV1(
						this.options.directory,
						principal.id,
					)
				: null;
		const application =
			principal.kind === "application"
				? await readCurrentTaskApplicationV1(tx, {
						applicationId: principal.id,
						agentId: row.agent_id,
					})
				: null;
		const allowed = isCurrentTaskFeedbackUseV1({
			principal,
			channelId: row.channel_id,
			agent,
			agentAuthorizationRevision: state.authorization_revision,
			user,
			application,
			useGrant,
		});
		if (!allowed) throw new EvaluationDataErrorV1("denied");
		return row;
	}
	async #target(
		tx: TransactionSql,
		row: TaskRow,
		maximumFacts: number,
	): Promise<TaskFeedbackTargetV1> {
		const events = await tx<
			{ sequence: number; fact: unknown }[]
		>`select sequence::int,event_payload->'fact' as fact from platform.conversation_events where execution_id=${row.execution_id} and sequence<=${row.last_event_sequence} and source='runtime' and event_type='execution.operation' and event_payload->'fact'->>'kind'='model' order by sequence limit ${maximumFacts + 1}`;
		const actual = foldEvaluationModelFactsV1(Array.from(events), maximumFacts);
		return {
			executionId: row.execution_id,
			principal: {
				kind: row.principal_type as "user" | "application",
				id: row.actor_id,
			},
			agentId: row.agent_id,
			channelId: row.channel_id,
			status: row.status,
			terminalObservedAt: row.terminal_observed_at?.toISOString() ?? null,
			conditions: actual.conditions,
		};
	}
	async transaction<T>(
		request: EvaluationRequestV1,
		executionId: string,
		operation: "read" | "write",
		work: (tx: TaskFeedbackTransactionV1) => Promise<T>,
	): Promise<T> {
		const result = await this.#client.begin(async (tx) => {
			const { policy } = await this.#policy(tx);
			const identity = await this.#identity(
				tx,
				request,
				operation === "write" ? "agent:use" : "agent:read",
			);
			await tx`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["task-feedback", executionId])},0))`;
			const row = await this.#task(tx, executionId, identity.principal);
			const target = await this.#target(tx, row, policy.maximumModelFacts);
			const receiptId = (key: string) =>
				`task-feedback:${createHash("sha256")
					.update(JSON.stringify([executionId, identity.principal, key]))
					.digest("hex")}`;
			const current = async () => {
				const [r] = await tx<
					{
						data: unknown;
						revision: string;
						principal_type: string;
						principal_id: string;
						agent_id: string;
						metadata_expires_at: Date;
					}[]
				>`select data,revision,principal_type,principal_id,agent_id,metadata_expires_at from platform.task_feedback where execution_id=${executionId} for update`;
				if (!r) return null;
				const value = parseTaskFeedbackRecordV1(r.data);
				if (
					value.executionId !== executionId ||
					value.revision !== +r.revision ||
					value.principal.kind !== r.principal_type ||
					value.principal.id !== r.principal_id ||
					value.agentId !== r.agent_id ||
					value.metadataExpiresAt !== r.metadata_expires_at.toISOString() ||
					!isDeepStrictEqual(value.principal, identity.principal)
				)
					throw new EvaluationDataErrorV1("unavailable");
				return value;
			};
			const [beginClock] = await tx<
				{ now: Date }[]
			>`select clock_timestamp() as now`;
			if (!beginClock) throw new EvaluationDataErrorV1("unavailable");
			const port: TaskFeedbackTransactionV1 = {
				now: beginClock.now,
				principal: identity.principal,
				target,
				policy,
				current,
				receipt: async (key) => {
					const [r] = await tx<
						{ request_digest: string; result: unknown }[]
					>`select request_digest,result from platform.idempotency_records where id=${receiptId(key)} for update`;
					if (!r) return null;
					const value = parseTaskFeedbackRecordV1(r.result);
					if (
						value.executionId !== executionId ||
						!isDeepStrictEqual(value.principal, identity.principal)
					)
						throw new EvaluationDataErrorV1("unavailable");
					return {
						digest: r.request_digest,
						result: value,
						expiresAt: value.metadataExpiresAt,
					};
				},
				save: async (value, key, digest) => {
					await tx`insert into platform.task_feedback(execution_id,principal_type,principal_id,agent_id,revision,metadata_expires_at,data)values(${executionId},${identity.principal.kind},${identity.principal.id},${value.agentId},${value.revision},${value.metadataExpiresAt},${tx.json(value as unknown as postgres.JSONValue)}) on conflict(execution_id)do update set revision=excluded.revision,metadata_expires_at=excluded.metadata_expires_at,data=excluded.data`;
					await tx`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)values(${receiptId(key)},'task_feedback',${executionId},${identity.principal.id},'task.feedback.updated',${key},${digest},'completed',${tx.json(value as unknown as postgres.JSONValue)}) on conflict(id)do update set request_digest=excluded.request_digest,result=excluded.result`;
				},
				audit: async (value) => {
					await tx`insert into platform.audit_events(id,request_id,trace_id,actor_type,actor_id,agent_id,action,target_type,target_id,outcome,details)values(${randomUUID()},${request.requestId},${request.traceId},${identity.principal.kind},${identity.principal.id},${value.agentId},'task.feedback.updated','execution',${executionId},'succeeded',${tx.json({ revision: value.revision, returnedMaterial: false })})`;
				},
			};
			const value = await work(port);
			const final = await this.#task(tx, executionId, identity.principal);
			const finalTarget = await this.#target(
				tx,
				final,
				policy.maximumModelFacts,
			);
			if (
				taskFeedbackConditionDigestV1(finalTarget) !==
					taskFeedbackConditionDigestV1(target) ||
				!isDeepStrictEqual(
					policy,
					parseEvaluationAnalysisPolicyV1(await this.options.loadPolicy()),
				)
			)
				throw new EvaluationDataErrorV1("denied");
			const [clock] = await tx<
				{ now: Date }[]
			>`select clock_timestamp() as now`;
			if (!clock || Date.parse(policy.validUntil) <= +clock.now)
				throw new EvaluationDataErrorV1("denied");
			await identity.revalidate();
			// Configuration access updates hold this same Agent row while replacing owners/availability.
			await tx`select id from platform.agents where id=${row.agent_id} for share`;
			// Event persistence takes FOR UPDATE on this Execution. KEY SHARE also
			// matches the write's existing FK lock without upgrading past a queued writer.
			await tx`select execution_id from platform.conversation_executions where execution_id=${executionId} for key share`;
			const committedTarget = await this.#target(
				tx,
				await this.#task(tx, executionId, identity.principal),
				policy.maximumModelFacts,
			);
			if (
				taskFeedbackConditionDigestV1(committedTarget) !==
				taskFeedbackConditionDigestV1(target)
			)
				throw new EvaluationDataErrorV1("denied");
			const [endClock] = await tx<
				{ now: Date }[]
			>`select clock_timestamp() as now`;
			if (!endClock || Date.parse(policy.validUntil) <= +endClock.now)
				throw new EvaluationDataErrorV1("denied");
			if (
				port.resultExpiresAt &&
				Date.parse(port.resultExpiresAt) <= +endClock.now
			)
				throw new EvaluationDataErrorV1("denied");
			if (operation === "read") {
				port.now = endClock.now;
				return { value: await work(port) };
			}
			const stored = await current();
			if (
				stored &&
				Math.min(
					Date.parse(stored.metadataExpiresAt),
					Date.parse(stored.createdAt) + policy.feedbackMetadataMs,
				) <= +endClock.now
			)
				throw new EvaluationDataErrorV1("denied");
			return { value };
		});
		return result.value;
	}
	async #summaryAuthority(
		tx: TransactionSql,
		request: EvaluationRequestV1,
		agentId: string,
		view: "self" | "owner",
	) {
		const identity = await this.#identity(tx, request, "agent:read");
		if (view === "owner") {
			if (identity.principal.kind !== "user")
				throw new EvaluationDataErrorV1("denied");
			const rows =
				await tx`select owner_id from platform.agent_owners where agent_id=${agentId} and owner_id=${identity.principal.id}`;
			if (rows.length !== 1) throw new EvaluationDataErrorV1("denied");
		} else {
			const grant = await readCurrentTaskApiUseGrantV1(tx, {
				principal: identity.principal,
				agentId,
			});
			const [record] = await tx<
				{ state: unknown; authorization_revision: string }[]
			>`select ${tx.unsafe(agentManagementStateJsonSql("a"))} as state,g.authorization_revision from platform.agent_applications a join platform.agents g on g.id=a.agent_id where a.agent_id=${agentId}`;
			if (!record) throw new EvaluationDataErrorV1("denied");
			const agent = parseAgentManagementPortState(record.state);
			const user =
				identity.principal.kind === "user"
					? await resolveCurrentPersonalApiUserV1(
							this.options.directory,
							identity.principal.id,
						)
					: null;
			const application =
				identity.principal.kind === "application"
					? await readCurrentTaskApplicationV1(tx, {
							applicationId: identity.principal.id,
							agentId,
						})
					: null;
			const current = {
				principal: identity.principal,
				agent,
				agentAuthorizationRevision: record.authorization_revision,
				user,
				application,
				useGrant: grant,
			};
			if (
				!(
					isCurrentTaskFeedbackUseV1({ ...current, channelId: "api" }) ||
					(request.authentication.kind === "browser" &&
						isCurrentTaskFeedbackUseV1({ ...current, channelId: "web" }))
				)
			)
				throw new EvaluationDataErrorV1("denied");
		}

		return identity;
	}
	async summary(
		request: EvaluationRequestV1,
		agentId: string,
		view: "self" | "owner",
		input: unknown,
	) {
		if (!agentId || agentId.length > 256 || !["self", "owner"].includes(view))
			throw new EvaluationDataErrorV1("invalid");
		const before = await this.#client.begin(async (tx) => {
			const { policy, now } = await this.#policy(tx);
			const identity = await this.#summaryAuthority(tx, request, agentId, view);
			const query = parseFeedbackSummaryQueryV1(input, policy);
			await identity.revalidate();
			return { policy, now, query, principal: identity.principal };
		});
		const snapshot = await this.#client.begin(
			"isolation level repeatable read read only",
			async (tx) => {
				const { query, policy, principal } = before;
				const tasks = await tx<
					TaskRow[]
				>`select e.execution_id,e.conversation_id,e.agent_id,e.actor_id,e.principal_type,e.channel_id,e.status,e.terminal_observed_at,e.last_event_sequence::int,a.boundary,a.revoked_at from platform.conversation_executions e join platform.task_authorization_records a on a.execution_id=e.execution_id where e.agent_id=${agentId} and e.channel_id<>'eval' and e.status in ('completed','failed','cancelled') and (e.terminal_observed_at is null or (e.terminal_observed_at>=${query.from}::timestamptz and e.terminal_observed_at<${query.to}::timestamptz)) ${view === "self" ? tx`and e.principal_type=${principal.kind} and e.actor_id=${principal.id}` : tx``} order by e.terminal_observed_at nulls last,e.execution_id limit ${policy.maximumTasks + 1}`;
				if (tasks.length > policy.maximumTasks)
					throw new EvaluationQueryLimitErrorV1();
				const ids = tasks.map((row) => row.execution_id);
				const sequences = tasks.map((row) => row.last_event_sequence);
				const events = ids.length
					? await tx<
							{ execution_id: string; sequence: number; fact: unknown }[]
						>`select e.execution_id,e.sequence::int,e.event_payload->'fact' as fact from platform.conversation_events e join unnest(${ids}::text[],${sequences}::bigint[]) as c(id,last_sequence) on e.execution_id=c.id and e.sequence<=c.last_sequence where e.source='runtime' and e.event_type='execution.operation' and e.event_payload->'fact'->>'kind'='model' order by e.execution_id,e.sequence limit ${policy.maximumModelFacts + 1}`
					: [];
				if (events.length > policy.maximumModelFacts)
					throw new EvaluationQueryLimitErrorV1();
				const feedbackRows = ids.length
					? await tx<
							{ execution_id: string; data: unknown }[]
						>`select execution_id,data from platform.task_feedback where execution_id=any(${ids}::text[])`
					: [];
				const feedbackMap = new Map(
					feedbackRows.map((row) => [
						row.execution_id,
						parseTaskFeedbackRecordV1(row.data),
					]),
				);
				const facts = new Map<string, { sequence: number; fact: unknown }[]>();
				for (const event of events) {
					const items = facts.get(event.execution_id) ?? [];
					items.push({ sequence: event.sequence, fact: event.fact });
					facts.set(event.execution_id, items);
				}
				const rows = tasks.map((task) => {
					const boundary = parseTaskAuthorizationBoundaryV1(task.boundary);
					if (
						boundary.principal.kind !== task.principal_type ||
						boundary.principal.id !== task.actor_id ||
						boundary.agentId !== agentId ||
						boundary.channelId !== task.channel_id
					)
						throw new EvaluationDataErrorV1("unavailable");
					const actual = foldEvaluationModelFactsV1(
						facts.get(task.execution_id) ?? [],
						policy.maximumModelFacts,
					);
					const target: TaskFeedbackTargetV1 = {
						executionId: task.execution_id,
						principal: boundary.principal,
						agentId,
						channelId: task.channel_id,
						status: task.status,
						terminalObservedAt:
							task.terminal_observed_at?.toISOString() ?? null,
						conditions: actual.conditions,
					};
					const feedback = feedbackMap.get(task.execution_id) ?? null;
					if (
						feedback &&
						(feedback.executionId !== target.executionId ||
							feedback.agentId !== agentId ||
							!isDeepStrictEqual(feedback.principal, target.principal))
					)
						throw new EvaluationDataErrorV1("unavailable");
					return { target, feedback };
				});
				return { rows, ids };
			},
		);
		if (view === "self") {
			const allowed = new Set<string>();
			await this.#client.begin(async (tx) => {
				for (const row of snapshot.rows) {
					try {
						await this.#task(tx, row.target.executionId, before.principal);
						allowed.add(row.target.executionId);
					} catch (error) {
						if (
							error instanceof EvaluationDataErrorV1 &&
							error.code === "denied"
						)
							continue;
						throw error;
					}
				}
			});
			snapshot.rows = snapshot.rows.filter((row) =>
				allowed.has(row.target.executionId),
			);
			snapshot.ids = snapshot.ids.filter((id) => allowed.has(id));
		}
		const finalNow = await this.#client.begin(async (tx) => {
			const finalPolicy = await this.#policy(tx);
			const current = await this.#summaryAuthority(tx, request, agentId, view);
			if (
				!isDeepStrictEqual(current.principal, before.principal) ||
				!isDeepStrictEqual(finalPolicy.policy, before.policy)
			)
				throw new EvaluationDataErrorV1("denied");
			if (view === "self")
				for (const id of snapshot.ids)
					await this.#task(tx, id, current.principal);
			await current.revalidate();
			await tx`select id from platform.agents where id=${agentId} for share`;
			await this.#summaryAuthority(tx, request, agentId, view);
			if (view === "owner") {
				const owners =
					await tx`select owner_id from platform.agent_owners where agent_id=${agentId} and owner_id=${current.principal.id}`;
				if (owners.length !== 1) throw new EvaluationDataErrorV1("denied");
			} else
				for (const id of snapshot.ids)
					await this.#task(tx, id, current.principal);
			const [clock] = await tx<
				{ now: Date }[]
			>`select clock_timestamp() as now`;
			if (!clock || Date.parse(before.policy.validUntil) <= +clock.now)
				throw new EvaluationDataErrorV1("denied");
			return clock.now;
		});
		const result = summarizeTaskFeedbackV1(
			snapshot.rows,
			before.query,
			before.policy,
			finalNow,
		);
		return { ...result, agentId, view, observedAt: finalNow.toISOString() };
	}
	async purgeExpired(limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
			throw new EvaluationQueryLimitErrorV1();
		await this.#client.begin(async (tx) => {
			await tx`delete from platform.idempotency_records where id in(select id from platform.idempotency_records where scope_type='task_feedback' and (result->>'metadataExpiresAt')::timestamptz<=clock_timestamp() order by id limit ${limit} for update skip locked)`;
			await tx`delete from platform.task_feedback where execution_id in(select execution_id from platform.task_feedback where metadata_expires_at<=clock_timestamp() order by metadata_expires_at,execution_id limit ${limit} for update skip locked)`;
		});
	}
}

export async function bindEvaluationAnalysisPolicyV1(
	tx: TransactionSql,
	loadPolicy: () => Promise<EvaluationAnalysisPolicyV1>,
) {
	const policy = parseEvaluationAnalysisPolicyV1(await loadPolicy());
	await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-analysis-policy-v1',0))`;
	const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
	if (!clock || Date.parse(policy.validUntil) <= +clock.now)
		throw new EvaluationDataErrorV1("denied");
	const digest = createHash("sha256")
		.update(JSON.stringify(policy))
		.digest("hex");
	const [existing] = await tx<
		{ revision: string; digest: string }[]
	>`select revision,digest from platform.evaluation_policies where id='analysis' for update`;
	if (
		existing &&
		(+existing.revision > policy.revision ||
			(+existing.revision === policy.revision && existing.digest !== digest))
	)
		throw new EvaluationDataErrorV1("unavailable");
	await tx`insert into platform.evaluation_policies(id,revision,digest)values('analysis',${policy.revision},${digest}) on conflict(id)do update set revision=excluded.revision,digest=excluded.digest`;
	return { policy, now: clock.now };
}
