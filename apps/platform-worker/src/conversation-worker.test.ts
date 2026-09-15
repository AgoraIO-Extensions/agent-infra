import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	dispatch: vi.fn(),
	storeClose: vi.fn(async () => {}),
	eventsClose: vi.fn(async () => {}),
	authorizationClose: vi.fn(async () => {}),
	legacyClose: vi.fn(async () => {}),
	runtimeClose: vi.fn(),
	signal: undefined as AbortSignal | undefined,
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
	createConversationDispatchUseCaseV1: () => ({ dispatch: mocks.dispatch }),
	createConversationEventUseCaseV1: () => ({}),
}));
vi.mock("./conversation-runtime.js", () => ({
	createConversationRuntimeV2: (options: { signal: AbortSignal }) => {
		mocks.signal = options.signal;
		return { authorization: {}, runtimeHost: {}, close: mocks.runtimeClose };
	},
}));

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
});
