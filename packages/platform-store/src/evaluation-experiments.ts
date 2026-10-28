import { createHash, randomUUID } from "node:crypto";
import {
	type ConversationTaskAdmissionPolicyV1,
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
