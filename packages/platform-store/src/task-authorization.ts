import { randomUUID } from "node:crypto";
import {
	type ConversationDispatchExecutionStatusV1,
	type CurrentTaskUserV1,
	captureTaskAuthorizationBoundaryV1,
	parseCurrentTaskUserV1,
	parseTaskAuthorizationBoundaryV1,
	planTaskSystemControlV1,
	type TaskAuthorizationBoundaryV1,
} from "@agent-infra/platform-core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readAgentManagementState } from "./agent-management.js";
import {
	agents,
	conversationExecutions,
	taskAuthorizationRecords,
	workloadReconciliations,
} from "./schema.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

export class TaskAuthorizationStoreError extends Error {
	constructor() {
		super("Task authorization persistence is unavailable");
	}
}

type JsonValue = Parameters<ReturnType<typeof postgres>["json"]>[0];

/** Part of the existing task acceptance transaction, before its result is returned. */
export async function insertTaskAuthorization(
	transaction: postgres.TransactionSql,
	input: {
		executionId: string;
		boundary: TaskAuthorizationBoundaryV1 | undefined;
		traceId: string;
		requestId: string;
	},
): Promise<void> {
	// Old callers keep their original records. Trusted dispatch rejects missing provenance.
	if (input.boundary === undefined) return;
	const boundary = parseTaskAuthorizationBoundaryV1(input.boundary);
	const [binding] = await transaction<
		{
			agent_id: string;
			actor_id: string;
			channel_id: string;
			authorization_revision: string;
		}[]
	>`
		select execution.agent_id, execution.actor_id, execution.channel_id, agent.authorization_revision
		from platform.conversation_executions execution
		join platform.agents agent on agent.id = execution.agent_id
		where execution.execution_id = ${input.executionId}
		for share of agent
	`;
	if (
		!binding ||
		boundary.principal.kind !== "user" ||
		boundary.principal.id !== binding.actor_id ||
		boundary.agentId !== binding.agent_id ||
		boundary.channelId !== binding.channel_id ||
		boundary.agentAuthorizationRevision !== binding.authorization_revision
	)
		throw new TaskAuthorizationStoreError();
	const recordId = randomUUID();
	await transaction`
		insert into platform.task_authorization_records (id, execution_id, boundary)
		values (${recordId}, ${input.executionId}, ${transaction.json(boundary as unknown as JsonValue)})
	`;
	await transaction`
		insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
		values (${randomUUID()}, ${input.traceId}, ${boundary.principal.kind}, ${boundary.principal.id}, 'task.authorization.accepted', 'execution', ${input.executionId}, 'succeeded', ${input.requestId}, ${boundary.agentId}, ${transaction.json({ authorizationRecordId: recordId, identityRevision: boundary.identityRevision, agentAuthorizationRevision: boundary.agentAuthorizationRevision })})
	`;
}

export class PostgresTaskAuthorizationStoreV1 {
	readonly #client;
	readonly #queryClient;
	readonly #database;
	constructor(options: { databaseUrl: string }) {
		this.#client = postgres(options.databaseUrl, { max: 5 });
		// Drizzle configures JSON codecs for its own values; raw postgres transactions
		// keep a separate pool so json() retains the postgres serialization contract.
		this.#queryClient = postgres(options.databaseUrl, { max: 5 });
		this.#database = drizzle(this.#queryClient);
	}

	/** Capture current access and its Agent revision from one consistent database snapshot. */
	async captureUserBoundary(input: {
		user: CurrentTaskUserV1;
		agentId: string;
		channelId: string;
	}): Promise<TaskAuthorizationBoundaryV1 | null> {
		const user = parseCurrentTaskUserV1(input.user);
		try {
			return await this.#database.transaction(
				async (transaction) => {
					const management = await readAgentManagementState(
						transaction,
						input.agentId,
					);
					const [agent] = await transaction
						.select({ authorizationRevision: agents.authorizationRevision })
						.from(agents)
						.where(eq(agents.id, input.agentId));
					if (!management || !agent?.authorizationRevision) return null;
					return captureTaskAuthorizationBoundaryV1({
						principal: { kind: "user", id: user.userId },
						user,
						agent: management,
						channelId: input.channelId,
						agentAuthorizationRevision: agent.authorizationRevision,
					});
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch {
			throw new TaskAuthorizationStoreError();
		}
	}

	/** Background callers receive metadata only; no task inputs or browser credentials. */
	async readExecution(executionId: string) {
		try {
			return await this.#database.transaction(
				async (transaction) => {
					const [record] = await transaction
						.select()
						.from(taskAuthorizationRecords)
						.where(eq(taskAuthorizationRecords.executionId, executionId));
					if (!record) return null;
					const boundary = parseTaskAuthorizationBoundaryV1(record.boundary);
					const agent = await readAgentManagementState(
						transaction,
						boundary.agentId,
					);
					const [execution] = await transaction
						.select()
						.from(conversationExecutions)
						.where(eq(conversationExecutions.executionId, record.executionId));
					if (
						!execution ||
						boundary.principal.kind !== "user" ||
						boundary.principal.id !== execution.actorId ||
						boundary.agentId !== execution.agentId ||
						boundary.channelId !== execution.channelId ||
						boundary.agentAuthorizationRevision !==
							execution.authorizationRevision
					)
						throw new TaskAuthorizationStoreError();
					if (!agent) return null;
					const [deployment] = await transaction
						.select({
							configurationRevision: agents.currentConfigurationRevision,
							workload: workloadReconciliations.state,
						})
						.from(agents)
						.leftJoin(
							workloadReconciliations,
							eq(workloadReconciliations.agentId, agents.id),
						)
						.where(eq(agents.id, boundary.agentId));
					if (!deployment) return null;
					const decoded = decodePersistedWorkloadStateV1(
						deployment.workload,
						boundary.agentId,
					);
					return {
						authorizationRecordId: record.id,
						executionId: record.executionId,
						boundary,
						revokedAt: record.revokedAt,
						agent,
						configurationRevision: deployment.configurationRevision,
						workload: decoded && !decoded.legacy ? decoded.state : null,
					};
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch {
			throw new TaskAuthorizationStoreError();
		}
	}

	/** Persist a system control authority and its required audit atomically. Revocation is permanent. */
	async recordControl(input: {
		executionId: string;
		authorizationRecordId: string;
		reason:
			| "stop"
			| "authorization_revoked"
			| "recovery"
			| "generation_isolation";
		workerId: string;
		traceId: string;
		requestId: string;
	}): Promise<{ controlRecordId: string }> {
		try {
			return await this.#client.begin(async (transaction) => {
				await transaction`select conversation.id from platform.conversations conversation join platform.conversation_executions execution on execution.conversation_id = conversation.id where execution.execution_id = ${input.executionId} for update of conversation`;
				const [execution] = await transaction<
					{
						conversation_id: string;
						session_generation: number | string;
						status: ConversationDispatchExecutionStatusV1;
						agent_id: string;
						actor_id: string;
						channel_id: string;
						authorization_revision: string;
					}[]
				>`select conversation_id, session_generation, status, agent_id, actor_id, channel_id, authorization_revision from platform.conversation_executions where execution_id = ${input.executionId} for update`;
				if (!execution) throw new TaskAuthorizationStoreError();
				const [record] = await transaction<{ id: string; boundary: unknown }[]>`
					select id, boundary from platform.task_authorization_records
					where execution_id = ${input.executionId} and id = ${input.authorizationRecordId} for update
				`;
				if (!record) throw new TaskAuthorizationStoreError();
				const boundary = parseTaskAuthorizationBoundaryV1(record.boundary);
				const plan = planTaskSystemControlV1({
					reason: input.reason,
					workerId: input.workerId,
					boundary,
					execution: {
						actorId: execution.actor_id,
						agentId: execution.agent_id,
						channelId: execution.channel_id,
						authorizationRevision: execution.authorization_revision,
						status: execution.status,
					},
				});
				if (plan.workerId !== input.workerId)
					throw new TaskAuthorizationStoreError();
				if (plan.ensureStop) {
					const [stop] = await transaction<
						{ stop_request_id: string }[]
					>`select stop_request_id from platform.conversation_stops where execution_id = ${input.executionId}`;
					if (!stop) {
						const stopRequestId = randomUUID();
						await transaction`insert into platform.conversation_stops (execution_id, stop_request_id, status, created_at, updated_at) values (${input.executionId}, ${stopRequestId}, 'submitted', now(), now())`;
						await transaction`
							insert into platform.outbox_items (id, scope_type, scope_id, operation, payload, trace_id, request_id)
							values (${`conversation:stop:${stopRequestId}`}, 'conversation', ${execution.conversation_id}, 'conversation.turn.stop.v1', ${transaction.json({ schemaVersion: 1, conversationId: execution.conversation_id, executionId: input.executionId, sessionGeneration: Number(execution.session_generation), stopRequestId })}, ${input.traceId}, ${input.requestId})
						`;
					}
				}
				const [existing] = await transaction<{ id: string }[]>`
					select id from platform.task_control_records where execution_id = ${input.executionId} and reason = ${input.reason}
				`;
				if (existing) return { controlRecordId: existing.id };
				const controlRecordId = randomUUID();
				if (plan.revokeAuthorization)
					await transaction`
					update platform.task_authorization_records set revoked_at = coalesce(revoked_at, now()) where id = ${record.id}
				`;
				await transaction`
					insert into platform.task_control_records (id, execution_id, authorization_record_id, reason)
					values (${controlRecordId}, ${input.executionId}, ${record.id}, ${input.reason})
				`;
				await transaction`
					insert into platform.audit_events (id, trace_id, actor_type, actor_id, action, target_type, target_id, outcome, request_id, agent_id, details)
					values (${randomUUID()}, ${input.traceId}, 'system', ${plan.workerId}, ${plan.audit.action}, 'execution', ${input.executionId}, 'succeeded', ${input.requestId}, ${boundary.agentId}, ${transaction.json({ workerId: plan.workerId, originalPrincipal: plan.audit.originalPrincipal, controlRecordId, authorizationRecordId: record.id, reason: plan.audit.reason } as unknown as JsonValue)})
				`;
				return { controlRecordId };
			});
		} catch {
			throw new TaskAuthorizationStoreError();
		}
	}

	async close(): Promise<void> {
		await Promise.all([this.#client.end(), this.#queryClient.end()]);
	}
}
