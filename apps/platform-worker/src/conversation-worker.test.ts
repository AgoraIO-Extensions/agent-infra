import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	dispatch: vi.fn(),
	storeClose: vi.fn(async () => {}),
	eventsClose: vi.fn(async () => {}),
	authorizationClose: vi.fn(async () => {}),
	legacyClose: vi.fn(async () => {}),
	runtimeClose: vi.fn(),
	dispatchAssemblyThrows: false,
	signal: undefined as AbortSignal | undefined,
	channelAuthorizationCurrent: undefined as unknown,
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresConversationDispatchStoreV1: () => ({
		findDispatchable: mocks.find,
		close: mocks.storeClose,
	}),
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
	createConversationDispatchUseCaseV1: () => {
		if (mocks.dispatchAssemblyThrows)
			throw new Error("synthetic dispatch assembly failure");
		return { dispatch: mocks.dispatch };
	},
	createConversationEventUseCaseV1: () => ({}),
}));
vi.mock("./conversation-runtime.js", () => ({
	createConversationRuntimeV2: (options: {
		signal: AbortSignal;
		channelAuthorizationCurrent?: unknown;
	}) => {
		mocks.channelAuthorizationCurrent = options.channelAuthorizationCurrent;
		mocks.signal = options.signal;
		return { authorization: {}, runtimeHost: {}, close: mocks.runtimeClose };
	},
}));

afterEach(() => vi.useRealTimers());

import { createPlatformConversationWorkerV2 } from "./conversation-worker.js";

const keys = generateKeyPairSync("ed25519");
const options = {
	databaseUrl: "postgres://synthetic",
	workerId: "instance",
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
	maximumConcurrentDispatches: 1,
	log: () => {},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.signal = undefined;
	mocks.dispatchAssemblyThrows = false;
});

describe("Conversation Worker discovery and shutdown", () => {
	it("reserves stop capacity while a business Turn occupies the dispatch slot", async () => {
		const pending = Promise.withResolvers<void>();
		let stoppedItem = false;
		mocks.find.mockImplementation(async () => [
			{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
			{ itemId: "turn-b", operation: "conversation.turn.submit.v1" },
			...(stoppedItem
				? []
				: [{ itemId: "stop-a", operation: "conversation.turn.stop.v1" }]),
		]);
		mocks.dispatch.mockImplementation(async (input: { itemId: string }) => {
			if (input.itemId === "stop-a") {
				stoppedItem = true;
				return;
			}
			mocks.signal?.addEventListener("abort", () => pending.resolve(), {
				once: true,
			});
			await pending.promise;
		});
		const worker = createPlatformConversationWorkerV2(options);
		expect(await worker.tick()).toBe(2);
		expect(mocks.dispatch.mock.calls.map((call) => call[0].itemId)).toEqual([
			"turn-a",
			"stop-a",
		]);
		expect(await worker.tick()).toBe(0);
		const stopping = worker.stop();
		expect(worker.stop()).toBe(stopping);
		await stopping;
		expect(mocks.signal?.aborted).toBe(true);
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
		expect(mocks.eventsClose).toHaveBeenCalledTimes(1);
		expect(mocks.authorizationClose).toHaveBeenCalledTimes(1);
		expect(mocks.legacyClose).toHaveBeenCalledTimes(1);
		expect(await worker.tick()).toBe(0);
	});
	it("shares overlapping discovery and never claims from a duplicate tick", async () => {
		const discovery = Promise.withResolvers<[]>();
		mocks.find.mockReturnValue(discovery.promise);
		const worker = createPlatformConversationWorkerV2(options);
		const first = worker.tick();
		const second = worker.tick();
		expect(first).toBe(second);
		expect(mocks.find).toHaveBeenCalledTimes(1);
		discovery.resolve([]);
		await first;
		await worker.stop();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
	it("passes the worker cancellation signal to discovery", async () => {
		mocks.find.mockImplementation(async (input: { signal?: AbortSignal }) => {
			expect(input.signal).toBe(mocks.signal);
			return [];
		});
		const worker = createPlatformConversationWorkerV2(options);
		await worker.tick();
		await worker.stop();
	});
	it("aborts in-flight discovery before closing stores", async () => {
		mocks.find.mockImplementation(
			(input: { signal?: AbortSignal }) =>
				new Promise<[]>((resolve) => {
					input.signal?.addEventListener(
						"abort",
						() => {
							resolve([]);
							resolve([]);
						},
						{ once: true },
					);
				}),
		);
		const worker = createPlatformConversationWorkerV2(options);
		const polling = worker.tick();
		await vi.waitFor(() => expect(mocks.find).toHaveBeenCalled());
		await worker.stop();
		await expect(polling).resolves.toBe(0);
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
	});
	it("scans past a saturated page to stop and revisits deferred work after release", async () => {
		const pending = Promise.withResolvers<void>();
		const items = Array.from({ length: 300 }, (_, index) => ({
			itemId: `turn-${String(index).padStart(3, "0")}`,
			operation: "conversation.turn.submit.v1",
		}));
		items.push({ itemId: "zz-stop", operation: "conversation.turn.stop.v1" });
		const completed = new Set<string>();
		mocks.find.mockImplementation(async ({ limit, afterItemId }) => {
			const eligible = items.filter((item) => !completed.has(item.itemId));
			return [
				...eligible.filter((item) => !afterItemId || item.itemId > afterItemId),
				...eligible.filter((item) => afterItemId && item.itemId <= afterItemId),
			].slice(0, limit);
		});
		mocks.dispatch.mockImplementation(async ({ itemId }) => {
			if (itemId !== "zz-stop") await pending.promise;
			completed.add(itemId);
		});
		const worker = createPlatformConversationWorkerV2(options);
		try {
			expect(await worker.tick()).toBe(1);
			expect(await worker.tick()).toBe(1);
			expect(mocks.dispatch.mock.calls.map((call) => call[0].itemId)).toEqual([
				"turn-000",
				"zz-stop",
			]);
			expect(mocks.find.mock.calls[1]?.[0]).toMatchObject({
				limit: 256,
				afterItemId: "turn-255",
			});
			pending.resolve();
			await vi.waitFor(() => expect(completed.has("turn-000")).toBe(true));
			expect(await worker.tick()).toBe(1);
			expect(mocks.dispatch).toHaveBeenCalledTimes(3);
		} finally {
			pending.resolve();
			await worker.stop();
		}
	});
	it("restarts discovery from the beginning after a short page", async () => {
		mocks.find
			.mockResolvedValueOnce([
				{ itemId: "turn-b", operation: "conversation.turn.submit.v1" },
			])
			.mockResolvedValueOnce([
				{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
			]);
		mocks.dispatch.mockResolvedValue(undefined);
		const worker = createPlatformConversationWorkerV2(options);
		try {
			expect(await worker.tick()).toBe(1);
			expect(await worker.tick()).toBe(1);
			expect(mocks.find.mock.calls[1]?.[0]).toMatchObject({ limit: 256 });
			expect(mocks.dispatch.mock.calls.map((call) => call[0].itemId)).toEqual([
				"turn-b",
				"turn-a",
			]);
		} finally {
			await worker.stop();
		}
	});
	it("closes every database resource even when one close rejects", async () => {
		mocks.find.mockResolvedValue([]);
		mocks.storeClose.mockRejectedValueOnce(
			new Error("synthetic close failure"),
		);
		const worker = createPlatformConversationWorkerV2(options);
		await expect(worker.stop()).rejects.toThrow("synthetic close failure");
		expect(mocks.eventsClose).toHaveBeenCalledTimes(1);
		expect(mocks.authorizationClose).toHaveBeenCalledTimes(1);
		expect(mocks.legacyClose).toHaveBeenCalledTimes(1);
	});
	it("closes every database resource when one close throws synchronously", async () => {
		mocks.find.mockResolvedValue([]);
		mocks.storeClose.mockImplementationOnce(() => {
			throw new Error("synthetic synchronous close failure");
		});
		const worker = createPlatformConversationWorkerV2(options);
		await expect(worker.stop()).rejects.toThrow(
			"synthetic synchronous close failure",
		);
		expect(mocks.eventsClose).toHaveBeenCalledTimes(1);
		expect(mocks.authorizationClose).toHaveBeenCalledTimes(1);
		expect(mocks.legacyClose).toHaveBeenCalledTimes(1);
	});
	it("closes the runtime when dispatch assembly fails", async () => {
		mocks.dispatchAssemblyThrows = true;
		mocks.find.mockResolvedValue([]);
		expect(() => createPlatformConversationWorkerV2(options)).toThrow(
			"synthetic dispatch assembly failure",
		);
		await vi.waitFor(() => expect(mocks.runtimeClose).toHaveBeenCalledTimes(1));
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
		expect(mocks.eventsClose).toHaveBeenCalledTimes(1);
		expect(mocks.authorizationClose).toHaveBeenCalledTimes(1);
		expect(mocks.legacyClose).toHaveBeenCalledTimes(1);
	});
	it("awaits Runtime cleanup before settling worker shutdown", async () => {
		mocks.find.mockResolvedValue([]);
		const runtimeClosed = Promise.withResolvers<void>();
		mocks.runtimeClose.mockReturnValueOnce(runtimeClosed.promise);
		const worker = createPlatformConversationWorkerV2(options);
		const stopping = worker.stop();
		await Promise.resolve();
		expect(mocks.storeClose).not.toHaveBeenCalled();
		runtimeClosed.resolve();
		await stopping;
		expect(mocks.runtimeClose).toHaveBeenCalledTimes(1);
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
		expect(mocks.eventsClose).toHaveBeenCalledTimes(1);
	});
	it("surfaces Runtime cleanup failures after closing every resource", async () => {
		mocks.find.mockResolvedValue([]);
		mocks.runtimeClose.mockRejectedValueOnce(
			new Error("synthetic runtime failure"),
		);
		const worker = createPlatformConversationWorkerV2(options);
		await expect(worker.stop()).rejects.toThrow("synthetic runtime failure");
		expect(mocks.storeClose).toHaveBeenCalledTimes(1);
		expect(mocks.eventsClose).toHaveBeenCalledTimes(1);
		expect(mocks.authorizationClose).toHaveBeenCalledTimes(1);
		expect(mocks.legacyClose).toHaveBeenCalledTimes(1);
	});
});

it("does not invent channel authority when deployment omits it", async () => {
	const worker = createPlatformConversationWorkerV2(options);
	expect(mocks.channelAuthorizationCurrent).toBeUndefined();
	await worker.stop();
	const current = async () => {
		throw Error("authority dependency unavailable");
	};
	const configured = createPlatformConversationWorkerV2({
		...options,
		channelAuthorizationCurrent: current,
	});
	expect(mocks.channelAuthorizationCurrent).toBe(current);
	await configured.stop();
});
