import { randomUUID } from "node:crypto";
import {
	EvaluationModelScoringErrorV1,
	type ModelCatalogAdapterV1,
	scoreEvaluationModelV1,
} from "@agent-infra/model-catalog";
import {
	createEvaluationScoreWorkV1,
	EvaluationDataErrorV1,
	EvaluationModelAuthorizationDeniedErrorV1,
	EvaluationModelNotSentErrorV1,
} from "@agent-infra/platform-core";
import {
	createPostgresOutboxStore,
	type EvaluationExperimentStoreOptionsV1,
	PostgresEvaluationScoringV1,
} from "@agent-infra/platform-store";
import type { RelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
export interface EvaluationScoringWorkerOptionsV1
	extends EvaluationExperimentStoreOptionsV1 {
	catalog: ModelCatalogAdapterV1;
	decryptor: RelayKeyWorkerDecryptorV1;
	batchSize: number;
	leaseMs: number;
	retryDelayMs: number;
}
/** Independent scorer outbox; no business Task submit/regenerate dependency exists here. */
export function createEvaluationScoringWorkerV1(
	options: EvaluationScoringWorkerOptionsV1,
) {
	if (
		!Number.isSafeInteger(options.batchSize) ||
		options.batchSize < 1 ||
		options.batchSize > 100 ||
		!Number.isSafeInteger(options.leaseMs) ||
		options.leaseMs < 1 ||
		options.leaseMs > 600000 ||
		!Number.isSafeInteger(options.retryDelayMs) ||
		options.retryDelayMs < 1 ||
		options.retryDelayMs > 86400000
	)
		throw new EvaluationDataErrorV1("invalid");
	const lifetime = new AbortController();
	let running: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	const outbox = createPostgresOutboxStore(options);
	const owner = `evaluation-score-${randomUUID()}`;
	const store = new PostgresEvaluationScoringV1({
		...options,
		model: async (lease, intent, input) => {
			const scorer = intent.scorer;
			if (scorer.implementation.kind !== "model")
				throw new EvaluationDataErrorV1("invalid");
			const signal = AbortSignal.any([
				lifetime.signal,
				AbortSignal.timeout(Math.min(scorer.timeoutMs, options.leaseMs)),
			]);
			let sent = false;
			try {
				signal.throwIfAborted();
				const first = await store.readKey(lease);
				const decrypted = await options.decryptor.decrypt({
					encryptedRecord: first.ciphertext,
					expectedBinding: first.binding,
				});
				if (decrypted.outcome !== "decrypted")
					throw new EvaluationDataErrorV1("unavailable");
				const credential = decrypted.plaintext;
				try {
					const endpoint = await options.catalog.resolve(
						{
							endpointId: scorer.implementation.endpointId,
							catalogRevision: scorer.implementation.catalogRevision,
						},
						{ signal },
					);
					await store.readKey(lease);
					const categories = scorer.implementation.inputCategories;
					signal.throwIfAborted();
					sent = true;
					const result = await scoreEvaluationModelV1({
						endpoint,
						modelId: scorer.implementation.modelId,
						credential,
						rubric: input.rubric,
						output: input.output,
						...(categories.includes("sample") ? { sample: input.sample } : {}),
						...(categories.includes("context") && input.context !== null
							? { context: input.context }
							: {}),
						...(categories.includes("expected") && input.expected !== null
							? { expected: input.expected }
							: {}),
						minimum: scorer.minimum,
						maximum: scorer.maximum,
						maxInputBytes: scorer.maxInputBytes,
						maxOutputBytes: scorer.maxOutputBytes,
						maxOutputTokens: scorer.implementation.maxOutputTokens,
						timeoutMs: scorer.timeoutMs,
						signal,
					});
					await store.readKey(lease);
					return result;
				} finally {
					credential.fill(0);
				}
			} catch (error) {
				if (!sent) throw new EvaluationModelNotSentErrorV1();
				if (
					error instanceof EvaluationModelScoringErrorV1 &&
					error.code === "authorization_denied"
				)
					throw new EvaluationModelAuthorizationDeniedErrorV1();
				throw error;
			}
		},
	});
	const work = createEvaluationScoreWorkV1(store);
	async function runBatch() {
		for (const itemId of await store.due(options.batchSize)) {
			if (lifetime.signal.aborted) return;
			const claim = await outbox.claim({
				itemId,
				leaseOwner: owner,
				leaseDurationMs: options.leaseMs,
			});
			if (!claim) continue;
			if (lifetime.signal.aborted) {
				await outbox.scheduleRetry({
					itemId,
					leaseOwner: owner,
					deliveryFence: claim.deliveryFence,
					retryDelayMs: options.retryDelayMs,
					errorCode: "EVALUATION_SCORE_STOPPING",
				});
				return;
			}
			const intentId = claim.payload.intentId;
			if (typeof intentId !== "string")
				throw new EvaluationDataErrorV1("invalid");
			const lease = {
				intentId,
				itemId,
				leaseOwner: owner,
				deliveryFence: claim.deliveryFence.toString(),
			};
			try {
				const result = await work.execute(lease);
				if (result.outcome === "completed")
					await outbox.markSucceeded({
						itemId,
						leaseOwner: owner,
						deliveryFence: claim.deliveryFence,
					});
				else
					await outbox.scheduleRetry({
						itemId,
						leaseOwner: owner,
						deliveryFence: claim.deliveryFence,
						retryDelayMs: result.delayMs ?? options.retryDelayMs,
						errorCode:
							result.outcome === "waiting"
								? "EVALUATION_OUTPUT_PENDING"
								: "EVALUATION_SCORE_RETRY",
					});
			} catch {
				await outbox.scheduleRetry({
					itemId,
					leaseOwner: owner,
					deliveryFence: claim.deliveryFence,
					retryDelayMs: options.retryDelayMs,
					errorCode: "EVALUATION_SCORE_UNAVAILABLE",
				});
			}
		}
	}
	return {
		runOnce() {
			if (lifetime.signal.aborted) return Promise.resolve();
			if (running) return running;
			running = runBatch().finally(() => {
				running = undefined;
			});
			return running;
		},
		close() {
			if (closing) return closing;
			lifetime.abort();
			closing = (async () => {
				const drained = await Promise.allSettled([running]);
				const cleanup = await Promise.allSettled([
					store.close(),
					outbox.close(),
				]);
				const failed = [...drained, ...cleanup].find(
					(value) => value.status === "rejected",
				);
				if (failed?.status === "rejected") throw failed.reason;
			})();
			return closing;
		},
	};
}
