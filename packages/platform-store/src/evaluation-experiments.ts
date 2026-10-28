import { createHash, randomUUID } from "node:crypto";
import {
	type ConversationTaskAdmissionPolicyV1,
	createConversationExecutionUseCaseV1,
	createConversationTaskAdmissionUseCaseV1,
	createEvaluationDataV1,
	EvaluationDataErrorV1,
	type EvaluationExperimentCreateV1,
	type EvaluationExperimentTransactionPortV1,
	type EvaluationExperimentTransactionV1,
	type EvaluationExperimentV1,
	type EvaluationPolicyV1,
	type EvaluationRequestV1,
	type EvaluationStorageV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationExperimentV1,
	parseEvaluationSampleTaskV1,
	parseEvaluationScoreIntentV1,
	parseTaskAuthorizationBoundaryV1,
	planEvaluationCancelledScoreV1,
	projectEvaluationExecutionFactsV1,
	requireEvaluationExperimentOwnerV1,
	resolveCurrentPersonalApiUserV1,
	type TaskUserDirectoryV1,
} from "@agent-infra/platform-core";
import {
	readCurrentTaskApiUseGrantV1,
	readCurrentTaskApplicationV1,
} from "./application-task-authorization.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import postgres from "./observed-postgres.js";

export interface EvaluationExperimentStoreOptionsV1 {
	databaseUrl: string;
	directory: TaskUserDirectoryV1;
	loadDataPolicy: () => Promise<EvaluationPolicyV1>;
	loadExperimentPolicy: () => Promise<unknown>;
	storage: EvaluationStorageV1;
	taskPolicy: ConversationTaskAdmissionPolicyV1;
}
export class PostgresEvaluationExperimentsV1
	implements EvaluationExperimentTransactionPortV1
{
	readonly #client;
	constructor(private readonly options: EvaluationExperimentStoreOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 4 });
	}
	async close() {
		await this.#client.end();
	}
	async policyCheckpoint() {
		const [row] = await this.#client<
			{ revision: string; digest: string; now: Date }[]
		>`select revision,digest,clock_timestamp() as now from platform.evaluation_policies where id='experiment'`;
		return row
			? { revision: +row.revision, digest: row.digest, now: row.now }
			: null;
	}
	async #requireAgentUse(
		tx: postgres.TransactionSql,
		principal: import("@agent-infra/platform-core").EvaluationPrincipalV1,
		ids: Iterable<string>,
	) {
		for (const agentId of [...new Set(ids)].sort()) {
			const grant = await readCurrentTaskApiUseGrantV1(tx, {
				principal,
				agentId,
			});
			if (!grant || grant.revoked) throw new EvaluationDataErrorV1("denied");
		}
	}

	async authorizeAgents(
		request: EvaluationRequestV1,
		experiment: EvaluationExperimentV1,
	) {
		return this.#client.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const dataStore = new PostgresEvaluationDataStoreV1({
				...this.options,
				transaction: tx,
			});
			const actor = await dataStore.authenticate({
				...request,
				credentialScope: "eval:run",
			});
			requireEvaluationExperimentOwnerV1(experiment, actor);
			const rows = await tx<
				{
					boundary: unknown;
					sample_data: unknown;
					execution_id: string;
					conversation_id: string;
					actor_id: string;
					principal_type: string;
					agent_id: string;
					channel_id: string;
					execution_source: string;
				}[]
			>`select a.boundary,s.data as sample_data,e.execution_id,e.conversation_id,e.actor_id,e.principal_type,e.agent_id,e.channel_id,e.execution_source from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id join platform.task_authorization_records a on a.execution_id=e.execution_id where s.experiment_id=${experiment.experimentId} and a.revoked_at is null order by s.id limit 1001`;
			if (
				!rows.length ||
				rows.length > 1000 ||
				rows.length !==
					experiment.sampleIds.length * experiment.variantIds.length
			)
				throw new EvaluationDataErrorV1("denied");
			const agents = new Set<string>();
			for (const row of rows) {
				const boundary = parseTaskAuthorizationBoundaryV1(row.boundary);
				const sample = parseEvaluationSampleTaskV1(row.sample_data);
				if (
					boundary.principal.kind !== actor.kind ||
					boundary.principal.id !== actor.id ||
					boundary.evaluation?.experimentId !== experiment.experimentId ||
					boundary.evaluation.datasetId !== experiment.datasetId ||
					boundary.evaluation.versionId !== experiment.versionId ||
					sample.experimentId !== experiment.experimentId ||
					sample.executionId !== row.execution_id ||
					sample.conversationId !== row.conversation_id ||
					sample.requested.agentId !== row.agent_id ||
					row.agent_id !== boundary.agentId ||
					row.principal_type !== actor.kind ||
					row.actor_id !== actor.id ||
					row.channel_id !== "eval" ||
					row.execution_source !== "eval"
				)
					throw new EvaluationDataErrorV1("denied");
				agents.add(boundary.agentId);
			}
			await this.#requireAgentUse(tx, actor, agents);
			await dataStore.authenticate({ ...request, credentialScope: "eval:run" });
		});
	}

	async target(id: string) {
		const [row] = await this.#client<
			{ data: unknown }[]
		>`select data from platform.evaluation_experiments where id=${id}`;
		return row ? parseEvaluationExperimentV1(row.data) : null;
	}
	async samples(id: string, limit: number, cursor?: string) {
		const rows = await this.#client<
			{
				id: string;
				experiment_id: string;
				execution_id: string;
				conversation_id: string;
				data: unknown;
				score_ids: string[];
				status: string;
				last_sequence: number;
				runtime_cursor: string | null;
				relay_key_purpose: string | null;
				relay_key_subject_id: string | null;
				relay_key_version: number | null;
			}[]
		>`select s.id,s.experiment_id,s.execution_id,s.conversation_id,s.data,e.status,e.last_event_sequence::int as last_sequence,e.last_runtime_cursor as runtime_cursor,e.relay_key_purpose,e.relay_key_subject_id,e.relay_key_version::int,array(select i.id::text from platform.evaluation_score_intents i where i.sample_task_id=s.id order by i.id) as score_ids from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id where s.experiment_id=${id} ${cursor ? this.#client`and s.id>${cursor}::uuid` : this.#client``} order by s.id limit ${limit}`;
		const result = [];
		for (const row of rows) {
			const task = parseEvaluationSampleTaskV1(row.data);
			if (
				task.sampleTaskId !== row.id ||
				task.experimentId !== row.experiment_id ||
				task.executionId !== row.execution_id ||
				task.conversationId !== row.conversation_id
			)
				throw new EvaluationDataErrorV1("unavailable");
			const events = await this.#client<
				{ sequence: number; event_type: string; event_payload: unknown }[]
			>`select sequence::int,event_type,event_payload from platform.conversation_events where execution_id=${task.executionId} and sequence<=${row.last_sequence} and event_type='execution.operation' order by sequence limit 101`;
			result.push({
				...task,
				scoreIds: row.score_ids,
				actual: {
					status: row.status,
					billing:
						row.relay_key_purpose === "agent-default" &&
						row.relay_key_subject_id &&
						row.relay_key_version
							? {
									purpose: "agent-default" as const,
									subjectId: row.relay_key_subject_id,
									keyVersion: row.relay_key_version,
								}
							: null,
					lastSequence: row.last_sequence,
					runtimeObserved: row.runtime_cursor !== null,
					preparedRuntime: task.preparedRuntime ?? null,
					facts: projectEvaluationExecutionFactsV1(
						events.slice(0, 100).map((e) => ({
							sequence: e.sequence,
							eventType: e.event_type,
							payload: e.event_payload,
						})),
					),
					factsTruncated: events.length > 100,
				},
			});
		}
		return result;
	}

	async cancel(request: EvaluationRequestV1, id: string, key: string) {
		return this.#client
			.begin(async (tx) => {
				await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
				const store = new PostgresEvaluationDataStoreV1({
					...this.options,
					transaction: tx,
				});
				const actor = await store.authenticate({
					...request,
					credentialScope: "eval:run",
				});
				const [row] = await tx<
					{ data: unknown }[]
				>`select data from platform.evaluation_experiments where id=${id} for update`;
				if (!row) throw new EvaluationDataErrorV1("denied");
				const experiment = parseEvaluationExperimentV1(row.data);
				requireEvaluationExperimentOwnerV1(experiment, actor);

				const tasks = await tx<
					{
						execution_id: string;
						conversation_id: string;
						agent_id: string;
						boundary: unknown;
					}[]
				>`select e.execution_id,e.conversation_id,e.agent_id,a.boundary from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id join platform.task_authorization_records a on a.execution_id=e.execution_id where s.experiment_id=${id} order by e.agent_id,e.execution_id for update of e,a`;
				await this.#requireAgentUse(
					tx,
					actor,
					tasks.map((task) => task.agent_id),
				);
				if (experiment.status === "cancelled") return experiment;
				for (const task of tasks) {
					const boundary = parseTaskAuthorizationBoundaryV1(task.boundary);
					if (
						boundary.principal.kind !== actor.kind ||
						boundary.principal.id !== actor.id ||
						boundary.agentId !== task.agent_id ||
						boundary.evaluation?.experimentId !== id
					)
						throw new EvaluationDataErrorV1("denied");
					const authority = {
						schemaVersion: 1 as const,
						actorId: actor.id,
						agentId: task.agent_id,
						channelId: "eval",
						authorizationRevision: boundary.agentAuthorizationRevision,
						supportsSupplementaryInstruction: false,
						taskBoundary: boundary,
					};
					const transaction = new PostgresConversationExecutionTransactionV1({
						transaction: tx,
						userDirectory: this.options.directory,
					});
					const useCase = createConversationExecutionUseCaseV1({
						authorization: {
							authorize: async () => ({ outcome: "allowed", authority }),
						},
						transaction,
					});
					await useCase.stop({
						schemaVersion: 1,
						command: "stop",
						conversationId: task.conversation_id,
						targetExecutionId: task.execution_id,
						idempotencyKey: createHash("sha256")
							.update(JSON.stringify([key, task.execution_id]))
							.digest("hex"),
						requestId: request.requestId,
						traceId: request.traceId,
					});
				}
				const cancelled = {
					...experiment,
					status: "cancelled" as const,
					revision: experiment.revision + 1,
				};
				await tx`update platform.evaluation_experiments set status='cancelled',revision=${cancelled.revision},data=${tx.json(cancelled as unknown as postgres.JSONValue)} where id=${id}`;
				const humanScores = await tx<
					{
						id: string;
						sample_task_id: string;
						execution_id: string;
						task_status: string;
						data: unknown;
					}[]
				>`select i.id,i.sample_task_id,s.execution_id,t.status as task_status,i.data from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id join platform.conversation_executions t on t.execution_id=s.execution_id where s.experiment_id=${id} and i.status='awaiting_human' for update of i`;
				for (const row of humanScores) {
					const intent = parseEvaluationScoreIntentV1(row.data);
					if (
						intent.id !== row.id ||
						intent.sampleTaskId !== row.sample_task_id ||
						intent.executionId !== row.execution_id ||
						intent.experimentId !== id ||
						intent.principal.kind !== experiment.principal.kind ||
						intent.principal.id !== experiment.principal.id ||
						intent.status !== "awaiting_human"
					)
						throw new EvaluationDataErrorV1("unavailable");
					const plan = planEvaluationCancelledScoreV1(
						intent,
						"cancelled",
						row.task_status,
					);
					if (plan.outcome !== "settle")
						throw new EvaluationDataErrorV1("unavailable");
					const settled = {
						...intent,
						status: plan.status,
						revision: plan.revision,
						failureCode: plan.failureCode,
						value: null,
						passed: null,
					};
					await tx`update platform.evaluation_score_intents set status=${settled.status},revision=${settled.revision},data=${tx.json(settled as unknown as postgres.JSONValue)} where id=${intent.id}`;
				}
				await tx`insert into platform.audit_events(id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,outcome,details)values(${randomUUID()},${request.traceId},${request.requestId},${actor.kind},${actor.id},'evaluation.experiment.cancel','evaluation_experiment',${id},'succeeded',${tx.json({ purpose: "eval", returnedMaterial: false })})`;
				await store.authenticate({ ...request, credentialScope: "eval:run" });
				await this.#requireAgentUse(
					tx,
					actor,
					tasks.map((task) => task.agent_id),
				);
				return cancelled;
			})
			.catch((error) => {
				if (error instanceof EvaluationDataErrorV1) throw error;
				throw new EvaluationDataErrorV1("unavailable");
			});
	}

	async transaction<T>(
		request: EvaluationRequestV1,
		command: EvaluationExperimentCreateV1,
		work: (tx: EvaluationExperimentTransactionV1) => Promise<T>,
	): Promise<T> {
		const result = await this.#client.begin(async (tx) => {
			await tx`set local statement_timeout='10s'`;
			await tx`set local lock_timeout='5s'`;
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const transactionDataStore = new PostgresEvaluationDataStoreV1({
				databaseUrl: this.options.databaseUrl,
				directory: this.options.directory,
				transaction: tx,
			});
			const data = createEvaluationDataV1({
				store: transactionDataStore,
				storage: this.options.storage,
				loadPolicy: this.options.loadDataPolicy,
			});
			const authenticated = await data.authorizeRun(
				request,
				command.datasetId,
				command.versionId,
			);
			const [clock] = await tx<
				{ now: Date }[]
			>`select clock_timestamp() as now`;
			if (!clock) throw new EvaluationDataErrorV1("unavailable");
			const receiptId = (scope: string) =>
				`eval-experiment:${createHash("sha256").update(scope).digest("hex")}`;
			const operations: EvaluationExperimentTransactionV1 = {
				now: clock.now,
				currentTime: async () => {
					const [row] = await tx<
						{ now: Date }[]
					>`select clock_timestamp() as now`;
					if (!row) throw new EvaluationDataErrorV1("unavailable");
					return row.now;
				},
				authorizeRun: () =>
					data.authorizeRun(request, command.datasetId, command.versionId),
				currentPolicy: async () =>
					parseEvaluationExperimentPolicyV1(
						await this.options.loadExperimentPolicy(),
					),
				bindPolicy: async (policy) => {
					const digest = createHash("sha256")
						.update(JSON.stringify(policy))
						.digest("hex");
					const [checkpoint] = await tx<
						{ revision: string; digest: string }[]
					>`select revision,digest from platform.evaluation_policies where id='experiment' for update`;
					if (
						checkpoint &&
						(+checkpoint.revision > policy.revision ||
							(+checkpoint.revision === policy.revision &&
								checkpoint.digest !== digest))
					)
						throw new EvaluationDataErrorV1("unavailable");
					await tx`insert into platform.evaluation_policies(id,revision,digest) values('experiment',${policy.revision},${digest}) on conflict(id)do update set revision=excluded.revision,digest=excluded.digest`;
				},
				receipt: async (scope) => {
					const [r] = await tx<
						{
							request_digest: string;
							result: { experimentId: string; expiresAt: string };
						}[]
					>`select request_digest,result from platform.idempotency_records where id=${receiptId(scope)} for update`;
					return r ? { digest: r.request_digest, ...r.result } : null;
				},
				experiment: async (id) => {
					const [r] = await tx<
						{ data: EvaluationExperimentV1 }[]
					>`select data from platform.evaluation_experiments where id=${id}`;
					return r ? parseEvaluationExperimentV1(r.data) : null;
				},
				saveExperiment: async (e) => {
					await tx`insert into platform.evaluation_experiments(id,dataset_id,version_id,principal,status,revision,created_at,metadata_expires_at,data)values(${e.experimentId},${e.datasetId},${e.versionId},${tx.json(e.principal)},${e.status},${e.revision},${e.createdAt},${e.metadataExpiresAt},${tx.json(e as unknown as postgres.JSONValue)})`;
				},
				lockAgents: async (ids) => {
					for (const agentId of ids)
						await tx`select id from platform.agents where id=${agentId} for share`;
				},
				agentAuthority: async (agentId) => {
					const grant = await readCurrentTaskApiUseGrantV1(tx, {
						principal: authenticated.principal,
						agentId,
					});
					if (!grant || grant.revoked) return null;
					const identity =
						authenticated.principal.kind === "application"
							? await readCurrentTaskApplicationV1(tx, {
									applicationId: authenticated.principal.id,
									agentId,
								})
							: await resolveCurrentPersonalApiUserV1(
									this.options.directory,
									authenticated.principal.id,
								);
					if (
						!identity ||
						("status" in identity
							? identity.status !== "active"
							: identity.accountStatus !== "active")
					)
						return null;
					const [agent] = await tx<
						{
							authorization_revision: string;
							current_configuration_revision: string;
						}[]
					>`select authorization_revision,current_configuration_revision from platform.agents where id=${agentId} for share`;
					return agent
						? {
								identityRevision: identity.authorizationRevision,
								agentRevision: agent.authorization_revision,
								configurationRevision: +agent.current_configuration_revision,
								useGrantRevision: grant.authorizationRevision,
								...("directorySnapshotBinding" in identity &&
								identity.directorySnapshotBinding
									? {
											directorySnapshotBinding:
												identity.directorySnapshotBinding,
										}
									: {}),
							}
						: null;
				},
				reserveSample: async (id, binding) => {
					await tx`insert into platform.evaluation_sample_tasks(id,experiment_id,sample_id,variant_id,binding,data)values(${id},${binding.experimentId},${binding.sampleId},${binding.variantId},${tx.json(binding as unknown as postgres.JSONValue)},'{}')`;
				},
				submitTask: async (authority, command) => {
					const transaction = new PostgresConversationExecutionTransactionV1({
						transaction: tx,
						userDirectory: this.options.directory,
						evaluationPolicy: {
							data: this.options.loadDataPolicy,
							experiment: this.options.loadExperimentPolicy,
						},
					});
					const admission = createConversationTaskAdmissionUseCaseV1(
						{
							authorization: {
								authorize: async () => ({ outcome: "allowed", authority }),
							},
							transaction,
						},
						this.options.taskPolicy,
					);
					return admission.submitTask(command);
				},
				saveSample: async (task) => {
					await tx`update platform.evaluation_sample_tasks set conversation_id=${task.conversationId},execution_id=${task.executionId},data=${tx.json(task as unknown as postgres.JSONValue)} where id=${task.sampleTaskId}`;
				},
				reserveScores: async (intents) => {
					for (const intent of intents) {
						await tx`insert into platform.evaluation_score_intents(id,sample_task_id,result_version,rubric_id,scorer_id,scorer_version,status,revision,data)values(${intent.id},${intent.sampleTaskId},'unobserved',${intent.scorer.rubricId},${intent.scorer.scorerId},${intent.scorer.version},${intent.status},${intent.revision},${tx.json(intent as unknown as postgres.JSONValue)})`;
						await tx`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,trace_id,request_id)values(${`evaluation-score:${intent.id}`},'evaluation',${intent.id},'evaluation.score.v1',${tx.json({ intentId: intent.id })},${request.traceId},${request.requestId})`;
					}
				},
				saveReceipt: async (scope, result) => {
					await tx`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)values(${receiptId(scope)},'evaluation',${JSON.stringify(authenticated.principal)},${authenticated.principal.id},'evaluation.experiment.create',${createHash("sha256").update(scope).digest("hex")},${result.digest},'completed',${tx.json({ experimentId: result.experimentId, expiresAt: result.expiresAt })})`;
				},
				audit: async (action, targetId) => {
					await tx`insert into platform.audit_events(id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,outcome,details)values(${randomUUID()},${request.traceId},${request.requestId},${authenticated.principal.kind},${authenticated.principal.id},${action},'evaluation_experiment',${targetId},'succeeded',${tx.json({ purpose: "eval", returnedMaterial: false })})`;
				},
			};
			const result = await work(operations);
			await operations.authorizeRun();
			return { value: result };
		});
		return result.value;
	}
}
