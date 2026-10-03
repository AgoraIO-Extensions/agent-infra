import { generateKeyPairSync } from "node:crypto";
import type { startObservability } from "@agent-infra/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1064 consumer contract. The production sampler and Store reader remain
// owner-supplied; these controlled tests do not replace PostgreSQL/collector proof.
const mocks = vi.hoisted(() => ({
	read: vi.fn<
		(
			signal: AbortSignal,
		) => Promise<{ taskWaiting: number; outboxPending: number }>
	>(),
	find: vi.fn(),
	dispatch: vi.fn(),
	storeClose: vi.fn(),
	eventsClose: vi.fn(),
	authorizationClose: vi.fn(),
	legacyClose: vi.fn(),
	runtimeClose: vi.fn(),
	openStore: vi.fn(),
	runtimeStore: undefined as unknown,
	dispatchStore: undefined as unknown,
	signal: undefined as AbortSignal | undefined,
	assemblyFails: false,
}));

vi.mock("@agent-infra/platform-store", () => ({
	openPostgresConversationDispatchStoreV1: () => {
		const store = {
			findDispatchable: mocks.find,
			readResourceSnapshot: mocks.read,
			close: mocks.storeClose,
		};
		mocks.openStore(store);
		return store;
	},
	PostgresConversationEventTransactionV1: class {
		close = mocks.eventsClose;
	},
	PostgresTaskAuthorizationStoreV1: class {
		close = mocks.authorizationClose;
	},
	PostgresLegacyTaskRecoveryReaderV1: class {
		close = mocks.legacyClose;
	},
}));
vi.mock("@agent-infra/platform-core", () => ({
	createConversationDispatchUseCaseV1: (input: { store: unknown }) => {
		if (mocks.assemblyFails) throw new Error("controlled assembly failure");
		mocks.dispatchStore = input.store;
		return { dispatch: mocks.dispatch };
	},
	createConversationEventUseCaseV1: () => ({ persist: vi.fn() }),
}));
vi.mock("@agent-infra/observability/worker", () => ({
	createObservedConversationEvents: () => ({ persist: vi.fn() }),
}));
vi.mock("./conversation-runtime.js", () => ({
	createConversationRuntimeV2: (input: {
		signal: AbortSignal;
		dispatchStore: unknown;
	}) => {
		mocks.signal = input.signal;
		mocks.runtimeStore = input.dispatchStore;
		return { authorization: {}, runtimeHost: {}, close: mocks.runtimeClose };
	},
}));

import { createPlatformConversationWorkerV2 } from "./conversation-worker.js";

type TelemetryStatus = ReturnType<
	ReturnType<typeof startObservability>["status"]
>;
const keys = generateKeyPairSync("ed25519");
const options = {
	databaseUrl: "postgres://synthetic",
	workerId: "sampling-test",
	signing: {
		issuer: "platform",
		workerId: "transport",
		keyId: "key",
		privateKey: keys.privateKey,
	},
	directory: { resolveUser: async () => null },
	resolveRuntimeHost: async () => ({
		baseUrl: "http://runtime.test",
		serviceToken: "synthetic",
		workerId: "transport",
	}),
	log: () => {},
};
let workers: ReturnType<typeof createPlatformConversationWorkerV2>[];
let releasePending: (() => void)[];

function telemetry(overrides: Partial<TelemetryStatus> = {}) {
	const state: TelemetryStatus = {
		enabled: true,
		state: "active",
		captureFailures: 0,
		exportFailures: 0,
		lastExportFailureAt: undefined,
		droppedLogs: 0,
		invalidRecords: 0,
		...overrides,
	};
	return {
		record: vi.fn(),
		observeResource: vi.fn(),
		status: vi.fn(() => state),
	};
}

function create(
	observability: Parameters<
		typeof createPlatformConversationWorkerV2
	>[0]["observability"],
	signal?: AbortSignal,
) {
	const worker = createPlatformConversationWorkerV2({
		...options,
		observability,
		...(signal ? { signal } : {}),
	});
	workers.push(worker);
	return worker;
}

function deferredSnapshot() {
	const deferred = Promise.withResolvers<{
		taskWaiting: number;
		outboxPending: number;
	}>();
	releasePending.push(() =>
		deferred.resolve({ taskWaiting: 7, outboxPending: 9 }),
	);
	return deferred;
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	workers = [];
	releasePending = [];
	mocks.signal = undefined;
	mocks.runtimeStore = undefined;
	mocks.dispatchStore = undefined;
	mocks.assemblyFails = false;
	mocks.find.mockResolvedValue([]);
	mocks.dispatch.mockResolvedValue(undefined);
	mocks.read.mockResolvedValue({ taskWaiting: 2, outboxPending: 5 });
});

afterEach(async () => {
	try {
		for (const release of releasePending) release();
		await Promise.allSettled(workers.map((worker) => worker.stop()));
	} finally {
		vi.useRealTimers();
	}
});

describe("Conversation Worker automatic queue sampling", () => {
	it("does not sample or create a timer before start, including an explicit business tick", async () => {
		const observation = telemetry();
		const worker = create(observation);
		await worker.tick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(observation.observeResource).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["omitted", "record-only", "disabled", "closing", "closed"] as const)(
		"keeps business discovery working without a sampler for %s telemetry",
		async (mode) => {
			const observation = telemetry({
				enabled: mode !== "disabled",
				state: mode === "closing" || mode === "closed" ? mode : "active",
			});
			const worker = create(
				mode === "omitted"
					? undefined
					: mode === "record-only"
						? { record: observation.record }
						: observation,
			);
			worker.start();
			await vi.advanceTimersByTimeAsync(5000);
			expect(mocks.find).toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
			expect(observation.observeResource).not.toHaveBeenCalled();
			// Only the pre-existing business discovery timer remains.
			expect(vi.getTimerCount()).toBe(1);
		},
	);

	it("samples automatically from the exact dispatch Store and exports the two counts separately", async () => {
		const observation = telemetry();
		const worker = create(observation);
		worker.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.read).toHaveBeenCalled();
		expect(mocks.openStore).toHaveBeenCalledTimes(1);
		expect(mocks.dispatchStore).toBe(mocks.runtimeStore);
		expect(mocks.dispatchStore).toBe(mocks.openStore.mock.calls[0]?.[0]);
		expect(observation.observeResource).toHaveBeenCalledWith({
			kind: "task_waiting",
			value: 2,
		});
		expect(observation.observeResource).toHaveBeenCalledWith({
			kind: "outbox_pending",
			value: 5,
		});
		expect(
			observation.observeResource.mock.calls.every(
				([snapshot]) => Object.keys(snapshot).sort().join(",") === "kind,value",
			),
		).toBe(true);
		const before = mocks.read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.read.mock.calls.length - before).toBe(1);
	});

	it("keeps one unresolved read despite repeated starts and elapsed intervals", async () => {
		const pending = deferredSnapshot();
		mocks.read.mockReturnValue(pending.promise);
		const worker = create(telemetry());
		worker.start();
		worker.start();
		await vi.advanceTimersByTimeAsync(6000);
		expect(mocks.read).toHaveBeenCalledTimes(1);
		pending.resolve({ taskWaiting: 2, outboxPending: 5 });
		await flush();
		const settledCalls = mocks.read.mock.calls.length;
		await flush();
		expect(mocks.read).toHaveBeenCalledTimes(settledCalls);
	});

	it("publishes a confirmed zero snapshot rather than treating zero as missing", async () => {
		mocks.read.mockResolvedValue({ taskWaiting: 0, outboxPending: 0 });
		const observation = telemetry();
		create(observation).start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(observation.observeResource).toHaveBeenCalledWith({
			kind: "task_waiting",
			value: 0,
		});
		expect(observation.observeResource).toHaveBeenCalledWith({
			kind: "outbox_pending",
			value: 0,
		});
	});

	it("does not refresh gauges on rejection and resumes automatic sampling after recovery", async () => {
		const observation = telemetry();
		create(observation).start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(observation.observeResource).toHaveBeenCalled();
		observation.observeResource.mockClear();
		mocks.read.mockRejectedValue(new Error("controlled snapshot failure"));
		await vi.advanceTimersByTimeAsync(4000);
		expect(observation.observeResource).not.toHaveBeenCalled();
		mocks.read.mockResolvedValue({ taskWaiting: 3, outboxPending: 8 });
		await vi.advanceTimersByTimeAsync(1000);
		expect(observation.observeResource).toHaveBeenCalledWith({
			kind: "task_waiting",
			value: 3,
		});
		expect(observation.observeResource).toHaveBeenCalledWith({
			kind: "outbox_pending",
			value: 8,
		});
	});

	it.each(["status", "observeResource"] as const)(
		"does not break dispatch or shutdown when telemetry.%s throws",
		async (method) => {
			const observation = telemetry();
			observation[method].mockImplementation(() => {
				throw new Error("controlled observer failure");
			});
			mocks.find.mockResolvedValueOnce([
				{ itemId: "business-a", operation: "conversation.turn.submit.v1" },
			]);
			const worker = create(observation);
			worker.start();
			await vi.advanceTimersByTimeAsync(1000);
			expect(mocks.dispatch).toHaveBeenCalledWith({
				schemaVersion: 1,
				itemId: "business-a",
				workerId: options.workerId,
			});
			await expect(worker.stop()).resolves.toBeUndefined();
		},
	);

	it("does not start a sampler for an already aborted Worker", async () => {
		const controller = new AbortController();
		controller.abort();
		const observation = telemetry();
		const worker = create(observation, controller.signal);
		worker.start();
		await vi.advanceTimersByTimeAsync(3000);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(observation.observeResource).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts a pending read, settles it before Store close and drops its late result", async () => {
		const pending = deferredSnapshot();
		let readSignal: AbortSignal | undefined;
		mocks.read.mockImplementation((signal) => {
			readSignal = signal;
			return pending.promise;
		});
		const observation = telemetry();
		const worker = create(observation);
		worker.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(readSignal).toBeDefined();
		const stopping = worker.stop();
		expect(worker.stop()).toBe(stopping);
		await flush();
		expect(readSignal?.aborted).toBe(true);
		expect(mocks.storeClose).not.toHaveBeenCalled();
		pending.resolve({ taskWaiting: 7, outboxPending: 9 });
		await stopping;
		expect(observation.observeResource).not.toHaveBeenCalled();
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
		const reads = mocks.read.mock.calls.length;
		worker.start();
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.read).toHaveBeenCalledTimes(reads);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards a pending result when telemetry closes before the reader resolves", async () => {
		const pending = deferredSnapshot();
		mocks.read.mockReturnValue(pending.promise);
		const observation = telemetry();
		create(observation).start();
		await vi.advanceTimersByTimeAsync(1000);
		observation.status().state = "closed";
		pending.resolve({ taskWaiting: 7, outboxPending: 9 });
		await flush();
		expect(observation.observeResource).not.toHaveBeenCalled();
	});

	it("cleans a failed assembly without starting a sampler and allows a fresh Worker", async () => {
		mocks.assemblyFails = true;
		expect(() => create(telemetry())).toThrow("controlled assembly failure");
		await flush();
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
		expect(mocks.runtimeClose).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		mocks.assemblyFails = false;
		const observation = telemetry();
		const worker = create(observation);
		worker.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(observation.observeResource).toHaveBeenCalled();
		await worker.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
