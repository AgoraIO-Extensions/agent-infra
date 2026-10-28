import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	createEvaluationDataV1,
	createEvaluationDerivedContentV1,
	EvaluationDataErrorV1,
	type EvaluationHumanScorePortV1,
	EvaluationModelNotSentErrorV1,
	type EvaluationRequestV1,
	type EvaluationScoreIntentV1,
	type EvaluationScoreLeaseV1,
	type EvaluationScoreOutcomeV1,
	type EvaluationScoreWorkPortV1,
	type EvaluationScoringInputV1,
	parseEvaluationExperimentPolicyV1,
	parseEvaluationScoreIntentV1,
	parseEvaluationScoreOutcomeV1,
	parseEvaluationScorerV1,
} from "@agent-infra/platform-core";
import { readCurrentTaskApiUseGrantV1 } from "./application-task-authorization.js";
import { PostgresEvaluationDataStoreV1 } from "./evaluation-data.js";
import { PostgresEvaluationDerivedContentV1 } from "./evaluation-derived-content.js";
import type { EvaluationExperimentStoreOptionsV1 } from "./evaluation-experiments.js";
import postgres from "./observed-postgres.js";
import {
	currentRelayKeyVersionInTransaction,
	readRelayKeyVersionInTransaction,
} from "./relay-key-versions.js";

type ScoreRow = {
	id: string;
	sample_task_id: string;
	result_version: string;
	scorer_id: string;
	scorer_version: string;
	rubric_id: string;
	status: string;
	revision: string;
	data: unknown;
};
function decodeScore(row: ScoreRow) {
	const value = parseEvaluationScoreIntentV1(row.data);
	if (
		value.id !== row.id ||
		value.sampleTaskId !== row.sample_task_id ||
		(value.resultVersion ?? "unobserved") !== row.result_version ||
		value.scorer.scorerId !== row.scorer_id ||
		value.scorer.version !== row.scorer_version ||
		value.scorer.rubricId !== row.rubric_id ||
		value.status !== row.status ||
		value.revision !== +row.revision
	)
		throw new EvaluationDataErrorV1("unavailable");
	return value;
}
const request = (lease: EvaluationScoreLeaseV1): EvaluationRequestV1 => ({
	authentication: {
		kind: "score_work",
		intentId: lease.intentId,
		leaseOwner: lease.leaseOwner,
		deliveryFence: lease.deliveryFence,
	},
	requestId: randomUUID(),
	traceId: randomUUID(),
});
export class PostgresEvaluationScoringV1
	implements EvaluationScoreWorkPortV1, EvaluationHumanScorePortV1
{
	readonly #client;
	readonly #dataStore;
	readonly #data;
	readonly #derivedStore;
	readonly #derived;
	constructor(
		private readonly options: EvaluationExperimentStoreOptionsV1 & {
			model?: (
				lease: EvaluationScoreLeaseV1,
				intent: EvaluationScoreIntentV1,
				input: EvaluationScoringInputV1,
			) => Promise<unknown>;
		},
	) {
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
		await this.#derivedStore.close();
		await this.#dataStore.close();
		await this.#client.end();
	}
	async #lock(tx: postgres.TransactionSql, lease: EvaluationScoreLeaseV1) {
		await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
		const [row] = await tx<
			ScoreRow[]
		>`select s.* from platform.evaluation_score_intents s join platform.outbox_items o on o.id=${lease.itemId} and o.scope_id=s.id::text where s.id=${lease.intentId} and o.operation='evaluation.score.v1' and o.status='processing' and o.lease_owner=${lease.leaseOwner} and o.delivery_fence=${lease.deliveryFence}::bigint and o.lease_expires_at>clock_timestamp() for update of s,o`;
		if (!row) throw new EvaluationDataErrorV1("denied");
		const intent = decodeScore(row);
		if (intent.id !== lease.intentId)
			throw new EvaluationDataErrorV1("unavailable");
		return intent;
	}
	async #current(
		tx: postgres.TransactionSql,
		req: EvaluationRequestV1,
		intent: EvaluationScoreIntentV1,
		purpose: "score" | "review" = "score",
	) {
		const data = createEvaluationDataV1({
			store: new PostgresEvaluationDataStoreV1({
				...this.options,
				transaction: tx,
			}),
			loadPolicy: this.options.loadDataPolicy,
			storage: this.options.storage,
		});
		const binding =
			purpose === "score"
				? await data.authorizeScore(req, intent.datasetId, intent.versionId)
				: await data.authorizeReview(req, intent.datasetId, intent.versionId);
		const policy = parseEvaluationExperimentPolicyV1(
			await this.options.loadExperimentPolicy(),
		);
		const [checkpoint] = await tx<
			{ revision: string; digest: string }[]
		>`select revision,digest from platform.evaluation_policies where id='experiment' for share`;
		const scorer = policy.scorers.find(
			(s) =>
				s.scorerId === intent.scorer.scorerId &&
				s.version === intent.scorer.version,
		);
		const [sample] = await tx<
			{
				binding: {
					variantId: string;
					configurationRevision: number;
					toolEnvironment: string;
					modelOptionId: string | null;
					reasoningLevel: string | null;
				};
				status: string;
			}[]
		>`select s.binding,e.status from platform.evaluation_sample_tasks s join platform.evaluation_experiments e on e.id=s.experiment_id where s.id=${intent.sampleTaskId} for share of s,e`;
		const variant = sample
			? policy.variants.find((v) => v.variantId === sample.binding.variantId)
			: undefined;
		const [now] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
		if (
			!now ||
			!checkpoint ||
			+checkpoint.revision !== policy.revision ||
			checkpoint.digest !==
				createHash("sha256").update(JSON.stringify(policy)).digest("hex") ||
			policy.policyId !== intent.policyId ||
			policy.revision !== intent.policyRevision ||
			policy.policyId !== binding.policy.policyId ||
			policy.revision !== binding.policy.revision ||
			Date.parse(policy.validUntil) <= +now.now ||
			Date.parse(intent.metadataExpiresAt) <= +now.now ||
			!scorer ||
			!scorer.datasetScopes.includes(binding.scope) ||
			!isDeepStrictEqual(parseEvaluationScorerV1(intent.scorer), scorer) ||
			!sample ||
			sample.status !== "active" ||
			!variant ||
			variant.agentId !== intent.agentId ||
			variant.configurationRevision !== sample.binding.configurationRevision ||
			variant.modelOptionId !== sample.binding.modelOptionId ||
			variant.reasoningLevel !== sample.binding.reasoningLevel ||
			variant.toolEnvironment !== sample.binding.toolEnvironment
		)
			throw new EvaluationDataErrorV1("denied");
		const use = await readCurrentTaskApiUseGrantV1(tx, {
			principal: binding.principal,
			agentId: intent.agentId,
		});
		if (!use || use.revoked) throw new EvaluationDataErrorV1("denied");
		return binding;
	}
	async #save(tx: postgres.TransactionSql, intent: EvaluationScoreIntentV1) {
		await tx`update platform.evaluation_score_intents set status=${intent.status},revision=${intent.revision},result_version=${intent.resultVersion ?? "unobserved"},data=${tx.json(intent as unknown as postgres.JSONValue)} where id=${intent.id}`;
	}
	async prepare(lease: EvaluationScoreLeaseV1) {
		const req = request(lease);
		const intent = await this.#client.begin(async (tx) => {
			const value = await this.#lock(tx, lease);
			await this.#current(tx, req, value);
			return value;
		});

		if (intent.status === "unknown") {
			const recovered = await this.#derivedStore.recover(
				req,
				`score-result:${intent.id}`,
				intent.datasetId,
				intent.versionId,
				"score",
			);
			if (recovered) {
				const result = parseEvaluationScoreOutcomeV1(
					await this.#derived.read(req, recovered.id, "score"),
					intent.scorer,
				);
				const ready = await this.#client.begin(async (tx) => {
					const current = await this.#lock(tx, lease);
					await this.#current(tx, req, current);
					const updated = {
						...current,
						status: "result_ready" as const,
						revision: current.revision + 1,
						reasonObjectId: recovered.id,
					};
					await this.#save(tx, updated);
					return updated;
				});
				return { intent: ready, recovered: result };
			}
		}
		if (intent.status === "result_ready" && intent.reasonObjectId) {
			const recovered = parseEvaluationScoreOutcomeV1(
				await this.#derived.read(req, intent.reasonObjectId, "score"),
				intent.scorer,
			);
			return { intent, recovered };
		}
		if (
			[
				"scored",
				"not_applicable",
				"failed",
				"awaiting_human",
				"unknown",
			].includes(intent.status)
		)
			return { terminal: true as const };
		const [execution] = await this.#client<
			{
				status: string;
				last_event_sequence: string;
				execution_source: string;
				model_configuration_revision: string | null;
				model_option_id: string | null;
				reasoning_level: string | null;
				execution_id: string;
			}[]
		>`select status,last_event_sequence,execution_source,model_configuration_revision,model_option_id,reasoning_level,execution_id from platform.conversation_executions where execution_id=${intent.executionId}`;
		if (!execution || execution.execution_source !== "eval")
			throw new EvaluationDataErrorV1("denied");
		if (!["completed", "failed", "stopped"].includes(execution.status))
			return { waiting: true as const, delayMs: intent.scorer.retryDelayMs };
		if (execution.status !== "completed") {
			await this.#client.begin(async (tx) => {
				const latest = await this.#lock(tx, lease);
				await this.#current(tx, req, latest);
				await this.#save(tx, {
					...latest,
					status: "not_applicable",
					revision: latest.revision + 1,
					failureCode: "TASK_NOT_COMPLETED",
					scoreActor: latest.principal,
				});
			});
			return { terminal: true as const };
		}
		const source = await this.#data.readForScore(
			req,
			intent.datasetId,
			intent.versionId,
		);
		const [sampleRow] = await this.#client<
			{ sample_id: string }[]
		>`select sample_id from platform.evaluation_sample_tasks where id=${intent.sampleTaskId}`;
		const sample = source.content.samples.find(
			(sample) => sample.id === sampleRow?.sample_id,
		);
		const rubric = source.content.rubric.find(
			(r) => r.id === intent.scorer.rubricId,
		);
		if (!sample || !rubric) throw new EvaluationDataErrorV1("denied");
		const [size] = await this.#client<
			{ bytes: string }[]
		>`select coalesce(sum(octet_length(event_payload->>'text')),0)::text as bytes from platform.conversation_events where execution_id=${intent.executionId} and event_type='text.delta'`;
		if (!size || +size.bytes > intent.scorer.maxInputBytes)
			throw new EvaluationDataErrorV1("invalid");
		const events = await this.#client<
			{ event_payload: { text: string } }[]
		>`select event_payload from platform.conversation_events where execution_id=${intent.executionId} and event_type='text.delta' order by sequence`;
		const output = events.map((event) => event.event_payload.text).join("");
		const resultVersion = createHash("sha256")
			.update(JSON.stringify([execution, output]))
			.digest("hex");
		const object = await this.#derived.write(
			req,
			`score-output:${intent.id}`,
			intent.datasetId,
			intent.versionId,
			"output",
			{ text: output, executionId: intent.executionId, resultVersion },
		);
		const prepared = await this.#client.begin(async (tx) => {
			const latest = await this.#lock(tx, lease);
			await this.#current(tx, req, latest);
			const [current] = await tx<
				{ status: string; last_event_sequence: string }[]
			>`select status,last_event_sequence from platform.conversation_executions where execution_id=${intent.executionId} for share`;
			if (
				!current ||
				current.status !== "completed" ||
				current.last_event_sequence !== execution.last_event_sequence ||
				(latest.resultVersion !== null &&
					latest.resultVersion !== resultVersion)
			)
				throw new EvaluationDataErrorV1("denied");
			const keyBinding =
				latest.keyBinding ??
				(latest.scorer.implementation.kind === "model"
					? await currentRelayKeyVersionInTransaction(tx, {
							purpose: "agent-default",
							subjectId: intent.agentId,
						})
					: null);
			if (latest.scorer.implementation.kind === "model" && !keyBinding)
				throw new EvaluationDataErrorV1("denied");
			const result: EvaluationScoreIntentV1 = {
				...latest,
				status:
					latest.scorer.implementation.kind === "human"
						? "awaiting_human"
						: "pending",
				revision: latest.revision + 1,
				attempts: latest.attempts + 1,
				resultVersion,
				outputObjectId: object.id,
				keyBinding: keyBinding as EvaluationScoreIntentV1["keyBinding"],
			};
			await this.#save(tx, result);
			return result;
		});
		return {
			intent: prepared,
			input: {
				sample: sample.input,
				context: sample.context,
				expected: sample.expectedResult,
				rubric: rubric.description,
				output,
			},
		};
	}
	async model(
		lease: EvaluationScoreLeaseV1,
		intent: EvaluationScoreIntentV1,
		input: EvaluationScoringInputV1,
	) {
		if (!this.options.model) throw new EvaluationDataErrorV1("unavailable");
		await this.#client.begin(async (tx) => {
			const current = await this.#lock(tx, lease);
			await this.#current(tx, request(lease), current);
			if (current.status !== "pending")
				throw new EvaluationDataErrorV1("conflict");
			await this.#save(tx, {
				...current,
				status: "unknown",
				revision: current.revision + 1,
			});
		});
		let output: unknown;
		try {
			output = await this.options.model(lease, intent, input);
		} catch (error) {
			if (
				error instanceof EvaluationModelNotSentErrorV1 ||
				(error &&
					typeof error === "object" &&
					"code" in error &&
					(error.code === "invalid" || error.code === "invalid_result"))
			)
				await this.#client.begin(async (tx) => {
					const current = await this.#lock(tx, lease);
					await this.#save(tx, {
						...current,
						status: "pending",
						revision: current.revision + 1,
						failureCode: "SCORER_RESULT_INVALID",
					});
				});
			throw error;
		}
		const result = parseEvaluationScoreOutcomeV1(output, intent.scorer);
		const object = await this.#derived.write(
			request(lease),
			`score-result:${intent.id}`,
			intent.datasetId,
			intent.versionId,
			"score",
			output,
		);
		await this.#client.begin(async (tx) => {
			const current = await this.#lock(tx, lease);
			await this.#current(tx, request(lease), current);
			if (current.status !== "unknown")
				throw new EvaluationDataErrorV1("conflict");
			await this.#save(tx, {
				...current,
				status: "result_ready",
				revision: current.revision + 1,
				reasonObjectId: object.id,
				value: result.value,
				passed: result.passed,
			});
		});
		return output;
	}
	async readKey(lease: EvaluationScoreLeaseV1) {
		return this.#client.begin(async (tx) => {
			const intent = await this.#lock(tx, lease);
			await this.#current(tx, request(lease), intent);
			if (!intent.keyBinding) throw new EvaluationDataErrorV1("denied");
			const current = await currentRelayKeyVersionInTransaction(tx, {
				purpose: "agent-default",
				subjectId: intent.agentId,
			});
			if (!current || !isDeepStrictEqual(current, intent.keyBinding))
				throw new EvaluationDataErrorV1("denied");
			const ciphertext = await readRelayKeyVersionInTransaction(
				tx,
				intent.keyBinding,
			);
			if (!ciphertext) throw new EvaluationDataErrorV1("denied");
			return { binding: intent.keyBinding, ciphertext };
		});
	}
	async commit(
		lease: EvaluationScoreLeaseV1,
		intent: EvaluationScoreIntentV1,
		result: EvaluationScoreOutcomeV1,
	) {
		const req = request(lease);
		const object = intent.reasonObjectId
			? await this.#derivedStore.get(intent.reasonObjectId)
			: await this.#derived.write(
					req,
					`score-result:${intent.id}`,
					intent.datasetId,
					intent.versionId,
					"score",
					{ status: result.status, value: result.value, reason: result.reason },
				);
		if (!object) throw new EvaluationDataErrorV1("unavailable");
		await this.#client.begin(async (tx) => {
			const current = await this.#lock(tx, lease);
			await this.#current(tx, req, current);
			if (
				(current.status !== "result_ready" &&
					current.revision !== intent.revision) ||
				!["pending", "result_ready"].includes(current.status)
			)
				throw new EvaluationDataErrorV1("conflict");
			await this.#save(tx, {
				...current,
				status: result.status,
				revision: current.revision + 1,
				reasonObjectId: object.id,
				value: result.value,
				passed: result.passed,
				scoreActor: current.principal,
			});
			await this.#audit(tx, req, current, "evaluation.score.completed");
		});
	}
	async failed(
		lease: EvaluationScoreLeaseV1,
		code: "SCORER_UNAVAILABLE" | "SCORER_RESULT_INVALID",
		preparationFailure = false,
	) {
		return this.#client.begin(async (tx) => {
			const intent = await this.#lock(tx, lease);
			if (["scored", "not_applicable", "failed"].includes(intent.status))
				return { retry: false, delayMs: intent.scorer.retryDelayMs };
			if (intent.status === "result_ready") {
				const retry = intent.attempts < intent.scorer.maxAttempts;
				await this.#save(tx, {
					...intent,
					attempts: intent.attempts + 1,
					revision: intent.revision + 1,
					status: retry ? "result_ready" : "failed",
					failureCode: code,
				});
				return { retry, delayMs: intent.scorer.retryDelayMs };
			}
			// Reconcile an unknown send against its stored result; prepare never
			// sends the model again from unknown.

			const attempts = intent.attempts + (preparationFailure ? 1 : 0);
			const retry =
				intent.status === "unknown"
					? !preparationFailure || attempts < intent.scorer.maxAttempts
					: attempts < intent.scorer.maxAttempts;
			await this.#save(tx, {
				...intent,
				status:
					intent.status === "unknown"
						? "unknown"
						: retry
							? "pending"
							: "failed",
				revision: intent.revision + 1,
				failureCode: code,
				attempts,
			});
			return { retry, delayMs: intent.scorer.retryDelayMs };
		});
	}
	async load(
		req: EvaluationRequestV1,
		id: string,
		purpose: "score" | "review",
	) {
		return this.#client.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const [row] = await tx<
				ScoreRow[]
			>`select * from platform.evaluation_score_intents where id=${id} for share`;
			if (!row) throw new EvaluationDataErrorV1("denied");
			const intent = decodeScore(row);
			if (intent.id !== id) throw new EvaluationDataErrorV1("unavailable");
			const binding = await this.#current(tx, req, intent, purpose);
			return { intent, actor: binding.principal };
		});
	}
	async content(
		req: EvaluationRequestV1,
		id: string,
		purpose: "score" | "review",
	) {
		const { intent } = await this.load(req, id, purpose);
		if (
			!intent.reasonObjectId ||
			!["scored", "not_applicable"].includes(intent.status)
		)
			throw new EvaluationDataErrorV1("denied");
		const value = await this.#derived.read(
			{
				...req,
				credentialScope: purpose === "review" ? "eval:review" : "eval:score",
			},
			intent.reasonObjectId,
			"score",
		);
		if (
			!value ||
			typeof value !== "object" ||
			!("status" in value) ||
			!("value" in value) ||
			!("reason" in value)
		)
			throw new EvaluationDataErrorV1("unavailable");
		return { status: value.status, value: value.value, reason: value.reason };
	}

	async submit(
		req: EvaluationRequestV1,
		key: string,
		intent: EvaluationScoreIntentV1,
		result: EvaluationScoreOutcomeV1,
	) {
		const authorized = await this.load(req, intent.id, "score");
		const digest = createHash("sha256")
			.update(JSON.stringify(result))
			.digest("hex");
		const id = `eval-human:${createHash("sha256")
			.update(JSON.stringify([authorized.actor, intent.id, key]))
			.digest("hex")}`;
		const object = await this.#derived.write(
			req,
			`human-score:${intent.id}:${key}`,
			intent.datasetId,
			intent.versionId,
			"score",
			result,
		);
		return this.#client.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const [row] = await tx<
				ScoreRow[]
			>`select * from platform.evaluation_score_intents where id=${intent.id} for update`;
			if (!row) throw new EvaluationDataErrorV1("denied");
			const current = decodeScore(row);
			const binding = await this.#current(tx, req, current);
			const [receipt] = await tx<
				{
					request_digest: string;
					result: { scoreId: string; expiresAt: string };
				}[]
			>`select request_digest,result from platform.idempotency_records where id=${id}`;
			if (receipt) {
				if (
					receipt.request_digest !== digest ||
					receipt.result.scoreId !== intent.id ||
					Date.parse(receipt.result.expiresAt) <= Date.now()
				)
					throw new EvaluationDataErrorV1("conflict");
				return current;
			}
			if (
				current.status !== "awaiting_human" ||
				current.revision !== intent.revision
			)
				throw new EvaluationDataErrorV1("conflict");
			const scored = {
				...current,
				status: result.status,
				revision: current.revision + 1,
				reasonObjectId: object.id,
				value: result.value,
				passed: result.passed,
				scoreActor: binding.principal,
			};
			await this.#save(tx, scored);
			await tx`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)values(${id},'evaluation',${JSON.stringify(binding.principal)},${binding.principal.id},'evaluation.score.human',${createHash("sha256").update(key).digest("hex")},${digest},'completed',${tx.json({ scoreId: intent.id, expiresAt: intent.metadataExpiresAt })})`;
			await this.#audit(
				tx,
				req,
				scored,
				"evaluation.score.human",
				binding.principal,
			);
			return scored;
		});
	}
	async review(
		req: EvaluationRequestV1,
		key: string,
		intent: EvaluationScoreIntentV1,
		actor: EvaluationScoreIntentV1["principal"],
		result: EvaluationScoreOutcomeV1,
	) {
		const digest = createHash("sha256")
			.update(JSON.stringify([intent.revision, result]))
			.digest("hex");
		const id = `eval-review:${createHash("sha256")
			.update(JSON.stringify([actor, intent.id, key]))
			.digest("hex")}`;
		const object = await this.#derived.write(
			req,
			`review:${intent.id}:${key}`,
			intent.datasetId,
			intent.versionId,
			"review",
			result,
		);
		return this.#client.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended('evaluation-data-v1',0))`;
			const [row] = await tx<
				ScoreRow[]
			>`select * from platform.evaluation_score_intents where id=${intent.id} for share`;
			if (!row) throw new EvaluationDataErrorV1("denied");
			const current = decodeScore(row);
			const binding = await this.#current(tx, req, current, "review");
			if (!isDeepStrictEqual(actor, binding.principal))
				throw new EvaluationDataErrorV1("denied");
			const [receipt] = await tx<
				{
					request_digest: string;
					result: {
						reviewId: string;
						scoreId: string;
						scoreRevision: number;
						reviewer: typeof actor;
						expiresAt: string;
					};
				}[]
			>`select request_digest,result from platform.idempotency_records where id=${id} for update`;
			if (receipt) {
				if (
					receipt.request_digest !== digest ||
					Date.parse(receipt.result.expiresAt) <= Date.now()
				)
					throw new EvaluationDataErrorV1("conflict");
				return {
					reviewId: receipt.result.reviewId,
					scoreId: receipt.result.scoreId,
					scoreRevision: receipt.result.scoreRevision,
					reviewer: receipt.result.reviewer,
				};
			}
			if (
				current.revision !== intent.revision ||
				isDeepStrictEqual(current.scoreActor, actor)
			)
				throw new EvaluationDataErrorV1("conflict");
			const review = {
				reviewId: randomUUID(),
				scoreId: intent.id,
				scoreRevision: intent.revision,
				reviewer: actor,
			};
			await tx`insert into platform.evaluation_score_reviews(id,score_id,revision,data)values(${review.reviewId},${intent.id},1,${tx.json({ ...review, objectId: object.id, metadataExpiresAt: object.metadataExpiresAt })})`;
			await tx`insert into platform.idempotency_records(id,scope_type,scope_id,actor_id,command_type,idempotency_key,request_digest,status,result)values(${id},'evaluation',${JSON.stringify(actor)},${actor.id},'evaluation.score.review',${createHash("sha256").update(key).digest("hex")},${digest},'completed',${tx.json({ ...review, expiresAt: object.metadataExpiresAt })})`;
			await this.#audit(tx, req, intent, "evaluation.score.reviewed", actor);
			return review;
		});
	}
	async #audit(
		tx: postgres.TransactionSql,
		req: EvaluationRequestV1,
		intent: EvaluationScoreIntentV1,
		action: string,
		actor = intent.principal,
	) {
		await tx`insert into platform.audit_events(id,trace_id,request_id,actor_type,actor_id,action,target_type,target_id,outcome,details)values(${randomUUID()},${req.traceId},${req.requestId},${actor.kind},${actor.id},${action},'evaluation_score',${intent.id},'succeeded',${tx.json({ purpose: "eval", returnedMaterial: false })})`;
	}
	async due(limit: number) {
		const rows = await this.#client<
			{ id: string }[]
		>`select id from platform.outbox_items where operation='evaluation.score.v1' and ((status in ('pending','retry_scheduled') and available_at<=clock_timestamp()) or (status='processing' and lease_expires_at<=clock_timestamp())) order by case when status='processing' then lease_expires_at else available_at end,id limit ${limit}`;
		return rows.map((r) => r.id);
	}
}
