import { randomUUID } from "node:crypto";
import {
	type ObjectStorageDataV1,
	requireEvaluationObjectStorageV1,
} from "@agent-infra/object-storage";
import {
	type EvaluationAnalysisPolicyV1,
	parseEvaluationAnalysisPolicyV1,
} from "@agent-infra/platform-core";
import {
	createPostgresOutboxStore,
	PostgresEvaluationDataStoreV1,
} from "@agent-infra/platform-store";

/** Uses the existing outbox lease/fence; cleanup needs no expired data-use policy. */
export function createEvaluationDataWorkerV1(input: {
	databaseUrl: string;
	loadAnalysisPolicy?: () => Promise<EvaluationAnalysisPolicyV1>;
	storage: ObjectStorageDataV1;
	closeStorage?: () => void | Promise<void>;
	batchSize: number;
	timeoutMs: number;
}) {
	if (
		!Number.isInteger(input.batchSize) ||
		input.batchSize < 1 ||
		input.batchSize > 100 ||
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs < 1 ||
		input.timeoutMs > 60000
	)
		throw new Error("EVALUATION_CONFIGURATION_INVALID");
	requireEvaluationObjectStorageV1(input.storage);
	const store = new PostgresEvaluationDataStoreV1(input);
	const outbox = createPostgresOutboxStore(input);
	const owner = `evaluation-cleanup-${randomUUID()}`;
	return {
		async runOnce() {
			let feedbackPolicy: EvaluationAnalysisPolicyV1 | undefined;
			if (input.loadAnalysisPolicy) {
				try {
					feedbackPolicy = parseEvaluationAnalysisPolicyV1(
						await input.loadAnalysisPolicy(),
					);
				} catch {
					/* Existing frozen expiry obligations remain valid if the current policy is unavailable. */
				}
			}
			for (const itemId of await store.expired(
				input.batchSize,
				feedbackPolicy,
			)) {
				const lease = await outbox.claim({
					itemId,
					leaseOwner: owner,
					leaseDurationMs: input.timeoutMs + 5000,
				});
				if (!lease) continue;
				try {
					const versionId =
						lease.operation === "evaluation.derived.delete.v1"
							? lease.payload.objectId
							: lease.payload.versionId;
					if (
						typeof versionId !== "string" ||
						![
							"evaluation.content.delete.v1",
							"evaluation.derived.delete.v1",
						].includes(lease.operation)
					)
						throw new Error("EVALUATION_DELETE_INVALID");
					await (lease.operation === "evaluation.derived.delete.v1"
						? store.cleanupDerived.bind(store)
						: store.cleanupVersion.bind(store))(
						{
							itemId,
							leaseOwner: owner,
							deliveryFence: lease.deliveryFence,
							versionId,
							objectRef: String(lease.payload.objectRef),
						},
						async (version) => {
							if (version.objectRef !== lease.payload.objectRef)
								throw new Error("EVALUATION_DELETE_INVALID");
							// List this exact key only, independent of total Eval prefix size; never read bodies.
							let cursor: string | null = null;
							let pages = 0;
							do {
								if (
									!(await outbox.renew({
										itemId,
										leaseOwner: owner,
										deliveryFence: lease.deliveryFence,
										leaseDurationMs: input.timeoutMs + 5000,
									}))
								)
									throw new Error("EVALUATION_DELETE_LEASE_LOST");
								const page = await input.storage.scan(
									cursor,
									100,
									version.objectRef,
								);
								for (const object of page.objects) {
									if (object.objectRef !== version.objectRef) continue;
									if (
										version.stored &&
										object.version !== version.stored.version
									)
										throw new Error("EVALUATION_DELETE_VERSION_DRIFT");
									await input.storage.remove(object.objectRef, object.version);
								}
								cursor = page.cursor;
								if (++pages > 100)
									throw new Error("EVALUATION_DELETE_SCAN_LIMIT");
							} while (cursor !== null);
						},
					);
					await outbox.markSucceeded({
						itemId,
						leaseOwner: owner,
						deliveryFence: lease.deliveryFence,
					});
				} catch {
					await outbox.scheduleRetry({
						itemId,
						leaseOwner: owner,
						deliveryFence: lease.deliveryFence,
						retryDelayMs: 5000,
						errorCode: "EVALUATION_DELETE_UNAVAILABLE",
					});
				}
			}
		},
		close: async () => {
			await Promise.all([
				store.close(),
				outbox.close(),
				Promise.resolve().then(() => input.closeStorage?.()),
			]);
		},
	};
}
