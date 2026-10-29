import { isDeepStrictEqual } from "node:util";
import {
	createEvaluationDataV1,
	createEvaluationDerivedContentV1,
	type EvaluationAnalysisPolicyV1,
	type EvaluationAnalysisTaskV1,
	EvaluationDataErrorV1,
	type EvaluationDerivedObjectV1,
	type EvaluationExperimentV1,
	EvaluationQueryLimitErrorV1,
	type EvaluationRequestV1,
	foldEvaluationModelFactsV1,
	parseEvaluationAnalysisPolicyV1,
	parseEvaluationDerivedObjectV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationExperimentV1,
	parseEvaluationPolicyV1,
	parseEvaluationReviewRecordV1,
	parseEvaluationSampleTaskV1,
	parseEvaluationScoreIntentV1,
	projectEvaluationBusinessFailureV1,
	requireEvaluationResponseBudgetV1,
	summarizeEvaluationExperimentV1,
} from "@agent-infra/platform-core";
import type { TransactionSql } from "postgres";
import { readCurrentTaskApiUseGrantV1 } from "./application-task-authorization.js";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import { PostgresEvaluationDerivedContentV1 } from "./evaluation-derived-content.js";
import type { EvaluationExperimentStoreOptionsV1 } from "./evaluation-experiments.js";
import { bindEvaluationAnalysisPolicyV1 } from "./evaluation-feedback.js";
import {
	type ExecutionFailureFactRowV1,
	executionFailureFactsSql,
	executionFailureFactsV1,
} from "./execution-failure-facts.js";
import postgres from "./observed-postgres.js";

export interface EvaluationAnalysisStoreOptionsV1
	extends EvaluationExperimentStoreOptionsV1 {
	loadAnalysisPolicy: () => Promise<EvaluationAnalysisPolicyV1>;
}
export class PostgresEvaluationAnalysisV1 {
	readonly #client;
	readonly #dataStore;
	readonly #data;
	readonly #derivedStore;
	readonly #derived;
	constructor(private readonly options: EvaluationAnalysisStoreOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 4 });
		this.#dataStore = new PostgresEvaluationDataStoreV1(options);
		this.#data = createEvaluationDataV1({
			store: this.#dataStore,
			loadPolicy: options.loadDataPolicy,
			storage: options.storage,
		});
		this.#derivedStore = new PostgresEvaluationDerivedContentV1({
			...options,
			loadPolicy: options.loadDataPolicy,
		});
		this.#derived = createEvaluationDerivedContentV1({
			store: this.#derivedStore,
			storage: options.storage,
		});
	}
	async close() {
		await Promise.all([
			this.#client.end(),
			this.#dataStore.close(),
			this.#derivedStore.close(),
		]);
	}
	async #current(
		request: EvaluationRequestV1,
		id: string,
		content?: {
			source?: boolean;
			objects: readonly {
				object: EvaluationDerivedObjectV1;
				available: boolean;
			}[];
			metadataExpiresAt: readonly string[];
		},
		transaction?: TransactionSql,
	) {
		const read = async (tx: TransactionSql) => {
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const { policy: analysisPolicy } = await bindEvaluationAnalysisPolicyV1(
				tx,
				this.options.loadAnalysisPolicy,
			);
			const service = createEvaluationDataV1({
				store: new PostgresEvaluationDataStoreV1({
					...this.options,
					transaction: tx,
				}),
				loadPolicy: this.options.loadDataPolicy,
				storage: this.options.storage,
			});
			const [row] = await tx<
				{ id: string; dataset_id: string; version_id: string; data: unknown }[]
			>`select id,dataset_id,version_id,data from platform.evaluation_experiments where id=${id}`;
			if (!row) throw new EvaluationDataErrorV1("denied");
			const experiment = parseEvaluationExperimentV1(row.data);
			if (
				experiment.experimentId !== row.id ||
				experiment.datasetId !== row.dataset_id ||
				experiment.versionId !== row.version_id
			)
				throw new EvaluationDataErrorV1("unavailable");
			const data = await service.authorizeAnalysisMetadata(
				request,
				experiment.datasetId,
				experiment.versionId,
			);

			const [clock] = await tx<
				{ now: Date }[]
			>`select clock_timestamp() as now`;
			if (
				!clock ||
				Date.parse(analysisPolicy.validUntil) <= +clock.now ||
				Date.parse(experiment.metadataExpiresAt) <= +clock.now
			)
				throw new EvaluationDataErrorV1("denied");
			const samples = await tx<
				{ id: string; experiment_id: string; data: unknown }[]
			>`select id,experiment_id,data from platform.evaluation_sample_tasks where experiment_id=${id} order by id limit ${analysisPolicy.maximumTasks + 1}`;
			if (samples.length > analysisPolicy.maximumTasks)
				throw new EvaluationQueryLimitErrorV1();
			const agents = new Set<string>();
			for (const row of samples) {
				const sample = parseEvaluationSampleTaskV1(row.data);
				if (
					sample.sampleTaskId !== row.id ||
					sample.experimentId !== id ||
					row.experiment_id !== id
				)
					throw new EvaluationDataErrorV1("unavailable");
				agents.add(sample.requested.agentId);
			}
			if (!agents.size) throw new EvaluationDataErrorV1("unavailable");

			for (const agentId of [...agents].sort()) {
				await tx`select id from platform.agents where id=${agentId} for share`;
				const grant = await readCurrentTaskApiUseGrantV1(tx, {
					principal: data.principal,
					agentId,
				});
				if (!grant || grant.revoked) throw new EvaluationDataErrorV1("denied");
			}
			const final = await (content && content.source !== false
				? service.authorizeAnalyze
				: service.authorizeAnalysisMetadata)(
				request,
				experiment.datasetId,
				experiment.versionId,
			);
			if (
				!isDeepStrictEqual(data, final) ||
				!isDeepStrictEqual(
					analysisPolicy,
					parseEvaluationAnalysisPolicyV1(
						await this.options.loadAnalysisPolicy(),
					),
				)
			)
				throw new EvaluationDataErrorV1("denied");
			const [now] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
			if (
				!now ||
				Date.parse(analysisPolicy.validUntil) <= +now.now ||
				Date.parse(experiment.metadataExpiresAt) <= +now.now
			)
				throw new EvaluationDataErrorV1("denied");
			if (content) {
				for (const { object: original, available } of content.objects) {
					const [record] = await tx<
						{
							id: string;
							dataset_id: string;
							version_id: string;
							kind: string;
							status: string;
							expires_at: Date;
							metadata_expires_at: Date;
							data: unknown;
						}[]
					>`select id,dataset_id,version_id,kind,status,expires_at,metadata_expires_at,data from platform.evaluation_derived_objects where id=${original.id} for share`;
					if (!record) throw new EvaluationDataErrorV1("denied");
					const object = parseEvaluationDerivedObjectV1(record.data);
					if (
						object.id !== record.id ||
						object.datasetId !== record.dataset_id ||
						object.versionId !== record.version_id ||
						object.kind !== record.kind ||
						object.status !== record.status ||
						object.expiresAt !== record.expires_at.toISOString() ||
						object.metadataExpiresAt !==
							record.metadata_expires_at.toISOString()
					)
						throw new EvaluationDataErrorV1("unavailable");
					if (
						!isDeepStrictEqual(object, original) ||
						(available && object.status !== "available")
					)
						throw new EvaluationDataErrorV1("denied");
				}
				const [fresh] = await tx<
					{ now: Date }[]
				>`select clock_timestamp() as now`;
				if (!fresh) throw new EvaluationDataErrorV1("unavailable");
				if (
					Date.parse(final.policy.validUntil) <= +fresh.now ||
					Date.parse(final.grant.expiresAt) <= +fresh.now ||
					(content.source !== false &&
						Math.min(
							Date.parse(final.version.expiresAt),
							Date.parse(final.version.createdAt) +
								final.policy.retention.samples.contentMs,
							Date.parse(final.version.createdAt) +
								final.policy.retention.rubric.contentMs,
						) <= +fresh.now)
				)
					throw new EvaluationDataErrorV1("denied");
				if (
					content.metadataExpiresAt.some(
						(deadline) => Date.parse(deadline) <= +fresh.now,
					)
				)
					throw new EvaluationDataErrorV1("denied");
				for (const { object, available } of content.objects) {
					const retention = final.policy.retention[object.kind];
					if (
						Math.min(
							...(available
								? [
										Date.parse(object.expiresAt),
										Date.parse(object.createdAt) + retention.contentMs,
									]
								: []),
							Date.parse(object.metadataExpiresAt),
							Date.parse(object.createdAt) + retention.metadataMs,
						) <= +fresh.now
					)
						throw new EvaluationDataErrorV1("denied");
				}
			}
			return { experiment, data, analysisPolicy, now: now.now };
		};
		return transaction ? read(transaction) : this.#client.begin(read);
	}
	async #snapshot(
		experiment: EvaluationExperimentV1,
		policy: EvaluationAnalysisPolicyV1,
	) {
		return this.#client.begin(
			"isolation level repeatable read read only",
			async (tx) => {
				const records = await tx<
					({
						id: string;
						data: unknown;
						execution_id: string;
						conversation_id: string;
						status: string;
						created_at: Date;
						terminal_observed_at: Date | null;
						last_sequence: number;
					} & ExecutionFailureFactRowV1)[]
				>`select s.id,s.data,s.execution_id,s.conversation_id,e.status,e.created_at,e.terminal_observed_at,e.last_event_sequence::int as last_sequence,${executionFailureFactsSql(tx, true)} from platform.evaluation_sample_tasks s join platform.conversation_executions e on e.execution_id=s.execution_id where s.experiment_id=${experiment.experimentId} order by s.id limit ${policy.maximumTasks + 1}`;
				if (records.length > policy.maximumTasks)
					throw new EvaluationQueryLimitErrorV1();
				const ids = records.map((r) => r.execution_id);
				const seqs = records.map((r) => r.last_sequence);
				const facts = ids.length
					? await tx<
							{ execution_id: string; sequence: number; fact: unknown }[]
						>`select e.execution_id,e.sequence::int,e.event_payload->'fact' as fact from platform.conversation_events e join unnest(${ids}::text[],${seqs}::bigint[]) c(id,seq) on e.execution_id=c.id and e.sequence<=c.seq where e.source='runtime' and e.event_type='execution.operation' and e.event_payload->'fact'->>'kind'='model' order by e.execution_id,e.sequence limit ${policy.maximumModelFacts + 1}`
					: [];
				if (facts.length > policy.maximumModelFacts)
					throw new EvaluationQueryLimitErrorV1();
				const scoreRows = await tx<
					{
						id: string;
						sample_task_id: string;
						status: string;
						revision: string;
						data: unknown;
					}[]
				>`select i.id,i.sample_task_id,i.status,i.revision,i.data from platform.evaluation_score_intents i join platform.evaluation_sample_tasks s on s.id=i.sample_task_id where s.experiment_id=${experiment.experimentId} and (i.data->>'metadataExpiresAt')::timestamptz>clock_timestamp()`;
				const scores = scoreRows.map((row) => {
					const value = parseEvaluationScoreIntentV1(row.data);
					if (
						value.id !== row.id ||
						value.sampleTaskId !== row.sample_task_id ||
						value.status !== row.status ||
						value.revision !== +row.revision
					)
						throw new EvaluationDataErrorV1("unavailable");
					return value;
				});
				const rows: EvaluationAnalysisTaskV1[] = records.map((row) => {
					const task = parseEvaluationSampleTaskV1(row.data);
					if (
						task.sampleTaskId !== row.id ||
						task.executionId !== row.execution_id ||
						task.conversationId !== row.conversation_id ||
						task.experimentId !== experiment.experimentId
					)
						throw new EvaluationDataErrorV1("unavailable");
					return {
						task,
						status: row.status,
						failure: projectEvaluationBusinessFailureV1(
							row.status,
							executionFailureFactsV1(row),
						),
						actual: foldEvaluationModelFactsV1(
							facts
								.filter((f) => f.execution_id === row.execution_id)
								.map((f) => ({ sequence: f.sequence, fact: f.fact })),
							policy.maximumModelFacts,
						),
						taskDurationMs: row.terminal_observed_at
							? +row.terminal_observed_at >= +row.created_at
								? +row.terminal_observed_at - +row.created_at
								: null
							: null,
						scores: scores.filter((s) => s.sampleTaskId === row.id),
					};
				});
				return rows;
			},
		);
	}
	async summary(request: EvaluationRequestV1, id: string) {
		const before = await this.#current(request, id);
		const tasks = await this.#snapshot(
			before.experiment,
			before.analysisPolicy,
		);
		const v = before.data.version;
		const retention = before.data.policy.retention;
		const contentAvailable =
			v.status === "available" &&
			Math.min(
				Date.parse(v.expiresAt),
				Date.parse(v.createdAt) + retention.samples.contentMs,
				Date.parse(v.createdAt) + retention.rubric.contentMs,
			) > +before.now;
		const source = contentAvailable
			? await this.#data.readForAnalyze(request, v.datasetId, v.versionId)
			: null;
		const result = summarizeEvaluationExperimentV1({
			experiment: before.experiment,
			tasks,
			taskTypes: source
				? new Map(source.content.samples.map((s) => [s.id, s.taskType]))
				: null,
		});
		const final = await this.#current(request, id, {
			source: source !== null,
			objects: [],
			metadataExpiresAt: tasks.flatMap((row) =>
				row.scores.map((score) => score.metadataExpiresAt),
			),
		});
		if (
			!isDeepStrictEqual(before.experiment, final.experiment) ||
			!isDeepStrictEqual(before.data.policy, final.data.policy) ||
			!isDeepStrictEqual(before.analysisPolicy, final.analysisPolicy) ||
			before.data.grant.grantId !== final.data.grant.grantId ||
			before.data.grant.revision !== final.data.grant.revision
		)
			throw new EvaluationDataErrorV1("denied");
		if (
			tasks.some((row) =>
				row.scores.some(
					(score) => Date.parse(score.metadataExpiresAt) <= +final.now,
				),
			)
		)
			throw new EvaluationDataErrorV1("denied");

		return {
			...result,
			observedAt: before.now.toISOString(),
			contentAvailable,
			items: tasks.map((row) => ({
				sampleTaskId: row.task.sampleTaskId,
				sampleId: row.task.sampleId,
				variantId: row.task.variantId,
				executionId: row.task.executionId,
				status: row.status,
				failure: row.failure ?? null,
				requested: row.task.requested,
				requestedEvidence: row.task.requestedEvidence ?? null,
				preparedRuntime: row.task.preparedRuntime ?? null,
				actual: row.actual,
				taskElapsedMs: row.taskDurationMs,
				scores: row.scores.map((score) => ({
					scoreId: score.id,
					scorerId: score.scorer.scorerId,
					scorerVersion: score.scorer.version,
					source: score.scorer.implementation.kind,
					scoringModel:
						score.scorer.implementation.kind === "model"
							? score.scorer.implementation.modelId
							: null,
					status: score.status,
					value: score.value,
					passed: score.passed,
					failureCode: score.failureCode,
				})),
			})),
		};
	}
	async detail(
		request: EvaluationRequestV1,
		id: string,
		sampleTaskId: string,
		page: {
			limit?: number;
			cursor?: string;
			scoreId?: string;
			reviewCursor?: string;
		} = {},
	) {
		const limit = page.limit ?? 10;
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			(page.reviewCursor && !page.scoreId) ||
			(page.cursor && page.scoreId)
		)
			throw new EvaluationDataErrorV1("invalid");
		const before = await this.#current(request, id);
		const rows = await this.#snapshot(before.experiment, before.analysisPolicy);
		const row = rows.find((r) => r.task.sampleTaskId === sampleTaskId);
		if (!row) throw new EvaluationDataErrorV1("denied");
		const source = await this.#data.readForAnalyze(
			request,
			before.experiment.datasetId,
			before.experiment.versionId,
		);
		const sample = source.content.samples.find(
			(s) => s.id === row.task.sampleId,
		);
		if (!sample) throw new EvaluationDataErrorV1("unavailable");
		const scoped = { ...request, credentialScope: "eval:analyze" as const };
		const objects = new Map<
			string,
			{ object: EvaluationDerivedObjectV1; available: boolean }
		>();
		const returnedIds = new Set<string>();
		const metadataExpiresAt: string[] = [];
		const readRetained = async (expected: {
			id: string;
			datasetId: string;
			versionId: string;
			kind: "output" | "score" | "review";
		}) => {
			const object = await this.#derivedStore.get(expected.id);
			if (!object) throw new EvaluationDataErrorV1("unavailable");
			const result = await this.#derived.readRetained(scoped, expected);
			objects.set(object.id, {
				object,
				available: result.contentStatus === "available",
			});
			return result;
		};
		const candidates = row.scores
			.filter(
				(s) =>
					(!page.cursor || s.id > page.cursor) &&
					(!page.scoreId || s.id === page.scoreId),
			)
			.sort((a, b) => a.id.localeCompare(b.id));
		if (page.scoreId && !candidates.length)
			throw new EvaluationDataErrorV1("denied");
		const scores = [];
		let nextCursor: string | null = null;
		let used = Buffer.byteLength(JSON.stringify(sample)) + 4096;
		const maximum = 4 * 1024 * 1024;
		for (const score of candidates) {
			if (scores.length === limit) {
				nextCursor = scores.at(-1)?.scoreId ?? null;
				break;
			}
			const output = score.outputObjectId
				? await readRetained({
						id: score.outputObjectId,
						datasetId: score.datasetId,
						versionId: score.versionId,
						kind: "output",
					})
				: null;
			const reason = score.reasonObjectId
				? await readRetained({
						id: score.reasonObjectId,
						datasetId: score.datasetId,
						versionId: score.versionId,
						kind: "score",
					})
				: null;
			const item = {
				scoreId: score.id,
				scorerId: score.scorer.scorerId,
				scorerVersion: score.scorer.version,
				source: score.scorer.implementation.kind,
				scoringModel:
					score.scorer.implementation.kind === "model"
						? score.scorer.implementation.modelId
						: null,
				status: score.status,
				value: score.value,
				passed: score.passed,
				output,
				reason,
			};
			const cost = Buffer.byteLength(JSON.stringify(item)) + 128;
			if (used + cost > maximum) {
				if (!scores.length) throw new EvaluationQueryLimitErrorV1();
				nextCursor = scores.at(-1)?.scoreId ?? null;
				break;
			}
			used += cost;
			const reviewRows = await this.#client<
				{ id: string; score_id: string; data: unknown }[]
			>`select id,score_id,data from platform.evaluation_score_reviews where score_id=${score.id} and (data->>'metadataExpiresAt')::timestamptz>clock_timestamp() ${page.reviewCursor ? this.#client`and id>${page.reviewCursor}::uuid` : this.#client``} order by id limit 101`;
			const reviews = [];
			const reviewBindings: { objectId: string; expiresAt: string }[] = [];
			let nextReviewCursor: string | null = null;
			for (const record of reviewRows) {
				if (reviews.length === 100) {
					nextReviewCursor = reviews.at(-1)?.reviewId ?? null;
					break;
				}
				const review = parseEvaluationReviewRecordV1(record.data);
				if (
					review.reviewId !== record.id ||
					review.scoreId !== score.id ||
					record.score_id !== score.id
				)
					throw new EvaluationDataErrorV1("unavailable");
				const result = await readRetained({
					id: review.objectId,
					datasetId: score.datasetId,
					versionId: score.versionId,
					kind: "review",
				});
				const entry = {
					reviewId: review.reviewId,
					scoreId: review.scoreId,
					scoreRevision: review.scoreRevision,
					reviewer: review.reviewer,
					result,
				};
				const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
				if (used + bytes > maximum) {
					if (!reviews.length) {
						if (scores.length) {
							nextCursor = scores.at(-1)?.scoreId ?? null;
							break;
						}
						throw new EvaluationQueryLimitErrorV1();
					}
					nextReviewCursor = reviews.at(-1)?.reviewId ?? null;
					break;
				}
				used += bytes;
				reviews.push(entry);
				reviewBindings.push({
					objectId: review.objectId,
					expiresAt: review.metadataExpiresAt,
				});
			}
			if (nextCursor) break;
			scores.push({ ...item, reviews, nextReviewCursor });
			metadataExpiresAt.push(
				score.metadataExpiresAt,
				...reviewBindings.map((binding) => binding.expiresAt),
			);
			for (const objectId of [
				score.outputObjectId,
				score.reasonObjectId,
				...reviewBindings.map((binding) => binding.objectId),
			])
				if (objectId) returnedIds.add(objectId);
		}
		const after = await this.#current(request, id, {
			objects: [...returnedIds].map((id) => {
				const value = objects.get(id);
				if (!value) throw new EvaluationDataErrorV1("unavailable");
				return value;
			}),
			metadataExpiresAt,
		});
		if (
			!isDeepStrictEqual(before.data.policy, after.data.policy) ||
			before.data.grant.revision !== after.data.grant.revision
		)
			throw new EvaluationDataErrorV1("denied");
		return requireEvaluationResponseBudgetV1(
			{
				experimentId: id,
				sampleTaskId,
				sample,
				scores,
				nextCursor,
				failure: row.failure ?? null,
			},
			maximum,
		);
	}
	async choices(
		request: EvaluationRequestV1,
		datasetId: string,
		versionId: string,
	) {
		const source = await this.#data.authorizeRun(request, datasetId, versionId);
		const policy = parseEvaluationExperimentPolicyV1(
			await this.options.loadExperimentPolicy(),
		);
		if (
			policy.policyId !== source.policy.policyId ||
			policy.revision !== source.policy.revision ||
			Date.parse(policy.validUntil) <= Date.now()
		)
			throw new EvaluationDataErrorV1("denied");
		const variants: ((typeof policy.variants)[number] & {
			name: string;
			billing: { purpose: "agent-default"; subjectId: string };
		})[] = [];
		await this.#client.begin(async (tx) => {
			for (const variant of policy.variants) {
				const use = await readCurrentTaskApiUseGrantV1(tx, {
					principal: source.principal,
					agentId: variant.agentId,
				});
				if (!use || use.revoked) continue;
				const [agent] = await tx<
					{ name: string; current_configuration_revision: string }[]
				>`select a.name,g.current_configuration_revision from platform.agent_applications a join platform.agents g on g.id=a.agent_id where a.agent_id=${variant.agentId}`;
				if (
					!agent ||
					+agent.current_configuration_revision !==
						variant.configurationRevision
				)
					continue;
				variants.push({
					...variant,
					name: agent.name,
					billing: {
						purpose: "agent-default" as const,
						subjectId: variant.agentId,
					},
				});
			}
		});
		const scorers = policy.scorers
			.filter((s) => s.datasetScopes.includes(source.scope))
			.map((s) => ({
				scorerId: s.scorerId,
				version: s.version,
				rubricId: s.rubricId,
				source: s.implementation.kind,
				scoringModel:
					s.implementation.kind === "model" ? s.implementation.modelId : null,
				minimum: s.minimum,
				maximum: s.maximum,
				passThreshold: s.passThreshold,
			}));
		const after = await this.#data.authorizeRun(request, datasetId, versionId);
		if (
			!isDeepStrictEqual(source, after) ||
			!isDeepStrictEqual(
				policy,
				parseEvaluationExperimentPolicyV1(
					await this.options.loadExperimentPolicy(),
				),
			)
		)
			throw new EvaluationDataErrorV1("denied");
		await this.#client.begin(async (tx) => {
			const data = createEvaluationDataV1({
				store: new PostgresEvaluationDataStoreV1({
					...this.options,
					transaction: tx,
				}),
				loadPolicy: this.options.loadDataPolicy,
				storage: this.options.storage,
			});
			const current = await data.authorizeRun(request, datasetId, versionId);
			if (!isDeepStrictEqual(current, source))
				throw new EvaluationDataErrorV1("denied");
			for (const variant of variants) {
				const [agent] = await tx<
					{ current_configuration_revision: string }[]
				>`select current_configuration_revision from platform.agents where id=${variant.agentId} for share`;
				const grant = await readCurrentTaskApiUseGrantV1(tx, {
					principal: source.principal,
					agentId: variant.agentId,
				});
				if (
					!agent ||
					+agent.current_configuration_revision !==
						variant.configurationRevision ||
					!grant ||
					grant.revoked
				)
					throw new EvaluationDataErrorV1("denied");
			}
			await data.authorizeRun(request, datasetId, versionId);
			if (
				!isDeepStrictEqual(
					policy,
					parseEvaluationExperimentPolicyV1(
						await this.options.loadExperimentPolicy(),
					),
				) ||
				Date.parse(policy.validUntil) <= Date.now()
			)
				throw new EvaluationDataErrorV1("denied");
		});
		return {
			datasetId,
			versionId,
			policyId: policy.policyId,
			policyRevision: policy.revision,
			maximumTasks: policy.maximumTasks,
			variants,
			scorers,
		};
	}
	async history(request: EvaluationRequestV1, limit: number, cursor?: string) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
			throw new EvaluationDataErrorV1("invalid");
		const principal = await this.#dataStore.authenticate({
			...request,
			credentialScope: "eval:analyze",
		});
		const policy = parseEvaluationPolicyV1(await this.options.loadDataPolicy());
		const budget = await this.#client.begin(
			async (tx) =>
				(
					await bindEvaluationAnalysisPolicyV1(
						tx,
						this.options.loadAnalysisPolicy,
					)
				).policy,
		);
		if (
			Date.parse(policy.validUntil) <= Date.now() ||
			Date.parse(budget.validUntil) <= Date.now()
		)
			throw new EvaluationDataErrorV1("denied");
		const rows = await this.#client<
			{ id: string }[]
		>`select e.id from platform.evaluation_experiments e where e.metadata_expires_at>clock_timestamp() ${cursor ? this.#client`and e.id>${cursor}::uuid` : this.#client``} and exists(select 1 from platform.evaluation_grants g where g.dataset_id=e.dataset_id and g.data->'principal'=${this.#client.json(principal)}::jsonb and g.data->>'revoked'='false' and g.data->>'policyId'=${policy.policyId} and (g.data->>'policyRevision')::bigint=${policy.revision} and (g.data->>'expiresAt')::timestamptz>clock_timestamp() and g.data->'versionIds' @> jsonb_build_array(e.version_id::text) and g.data->'operations' @> '["analyze"]'::jsonb) order by e.id limit ${Math.min(budget.maximumTasks, 500) + 1}`;
		const items: EvaluationExperimentV1[] = [];
		let last: string | null = null;
		let more = false;
		for (const row of rows) {
			if (items.length === limit) {
				more = true;
				break;
			}
			last = row.id;
			try {
				items.push((await this.#current(request, row.id)).experiment);
			} catch (error) {
				if (error instanceof EvaluationDataErrorV1 && error.code === "denied")
					continue;
				throw error;
			}
		}
		await this.#client.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const reader = new PostgresEvaluationDataStoreV1({
				...this.options,
				transaction: tx,
			});
			const final = await reader.authenticate({
				...request,
				credentialScope: "eval:analyze",
			});
			if (!isDeepStrictEqual(principal, final))
				throw new EvaluationDataErrorV1("denied");
			const deadlines: number[] = [
				Date.parse(policy.validUntil),
				Date.parse(budget.validUntil),
			];
			for (const item of items) {
				const checked = await this.#current(
					request,
					item.experimentId,
					undefined,
					tx,
				);
				deadlines.push(
					Date.parse(checked.experiment.metadataExpiresAt),
					Date.parse(checked.data.version.metadataExpiresAt),
					Date.parse(checked.data.grant.expiresAt),
					Date.parse(checked.data.policy.validUntil),
				);
			}
			await reader.authenticate({
				...request,
				credentialScope: "eval:analyze",
			});
			if (
				!isDeepStrictEqual(
					policy,
					parseEvaluationPolicyV1(await this.options.loadDataPolicy()),
				) ||
				!isDeepStrictEqual(
					budget,
					parseEvaluationAnalysisPolicyV1(
						await this.options.loadAnalysisPolicy(),
					),
				)
			)
				throw new EvaluationDataErrorV1("denied");
			const [now] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
			if (!now || deadlines.some((deadline) => deadline <= +now.now))
				throw new EvaluationDataErrorV1("denied");
		});
		return {
			items,
			nextCursor:
				more || rows.length > Math.min(budget.maximumTasks, 500) ? last : null,
		};
	}
}
