import { expect, it, vi } from "vitest";
import { createEvaluationDataWorkerV1 } from "./evaluation-data-worker.js";

vi.mock("@agent-infra/object-storage", () => ({
	requireEvaluationObjectStorageV1: () => {},
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresEvaluationDataStoreV1: class {
		async close() {}
	},
	createPostgresOutboxStore: () => ({ close: async () => {} }),
}));

it("waits for the deployment storage shutdown barrier", async () => {
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const closeStorage = vi.fn(() => barrier);
	const worker = createEvaluationDataWorkerV1({
		databaseUrl: "unused",
		storage: {} as Parameters<
			typeof createEvaluationDataWorkerV1
		>[0]["storage"],
		closeStorage,
		batchSize: 1,
		timeoutMs: 1000,
	});
	let closed = false;
	const closing = worker.close().then(() => {
		closed = true;
	});
	await vi.waitFor(() => expect(closeStorage).toHaveBeenCalledOnce());
	expect(closed).toBe(false);
	release();
	await closing;
	expect(closed).toBe(true);
});
