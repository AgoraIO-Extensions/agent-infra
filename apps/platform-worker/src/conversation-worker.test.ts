import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	wecomDispatch: vi.fn(async () => {}),
	wecomReconcile: vi.fn(async () => {}),
	wecomClose: vi.fn(async () => {}),
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

vi.mock("./wecom-worker.js", () => ({
	createPlatformWecomWorkerV1: () => ({
		dispatch: mocks.wecomDispatch,
		reconcile: mocks.wecomReconcile,
		close: mocks.wecomClose,
	}),
}));
afterEach(() => vi.useRealTimers());

import {
	createPlatformConversationWorkerV2,
	startPlatformConversationWorkerFromDeploymentV2,
} from "./conversation-worker.js";

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
	mocks.wecomDispatch.mockReset().mockResolvedValue(undefined);
	mocks.wecomReconcile.mockReset().mockResolvedValue(undefined);
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
	it("retains the cursor before an item deferred by capacity", async () => {
		mocks.find
			.mockResolvedValueOnce([
				{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
				{ itemId: "turn-b", operation: "conversation.turn.submit.v1" },
			])
			.mockResolvedValueOnce([
				{ itemId: "turn-b", operation: "conversation.turn.submit.v1" },
			]);
		mocks.dispatch.mockResolvedValue(undefined);
		const worker = createPlatformConversationWorkerV2(options);
		try {
			expect(await worker.tick()).toBe(1);
			expect(await worker.tick()).toBe(1);
			const secondCall = mocks.find.mock.calls[1];
			expect(secondCall?.[0]).toEqual({
				limit: 256,
				afterItemId: "turn-a",
			});
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
});

it("starts WeCom dispatch independently of failed or unsettled discovery", async () => {
	vi.useFakeTimers();
	const pending = Promise.withResolvers<[]>();
	mocks.find
		.mockRejectedValueOnce(new Error("unavailable"))
		.mockReturnValue(pending.promise);
	const log = vi.fn();
	const worker = createPlatformConversationWorkerV2({
		...options,
		log,
		pollIntervalMs: 1000,
		wecom: {
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
		},
	});
	try {
		worker.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.wecomDispatch).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.wecomDispatch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(3000);
		expect(mocks.wecomDispatch).toHaveBeenCalledTimes(5);
		expect(mocks.find).toHaveBeenCalledTimes(2);
	} finally {
		pending.resolve([]);
		await worker.stop();
	}
});

it.each(["reply", "connection"])(
	"keeps independent work running past 30s while %s is pending",
	async (pendingKind) => {
		vi.useFakeTimers();
		const pending = Promise.withResolvers<void>();
		mocks.find.mockResolvedValue([]);
		if (pendingKind === "reply")
			mocks.wecomDispatch.mockReturnValue(pending.promise);
		else mocks.wecomReconcile.mockReturnValue(pending.promise);
		const worker = createPlatformConversationWorkerV2({
			...options,
			pollIntervalMs: 1000,
			wecom: {
				identity: {
					resolveSender: async () => null,
					activeUsers: async () => [],
				},
				observe: () => {},
				sender: { send: async () => "failed" },
			},
		});
		try {
			worker.start();
			await vi.advanceTimersByTimeAsync(31000);
			expect(mocks.find).toHaveBeenCalledTimes(32);
			expect(mocks.wecomReconcile).toHaveBeenCalledTimes(
				pendingKind === "reply" ? 32 : 1,
			);
			expect(mocks.wecomDispatch).toHaveBeenCalledTimes(
				pendingKind === "reply" ? 1 : 32,
			);
			const stopped = worker.stop();
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.wecomClose).not.toHaveBeenCalled();
			pending.resolve();
			await stopped;
			expect(mocks.wecomClose).toHaveBeenCalledTimes(1);
		} finally {
			pending.resolve();
			await worker.stop();
		}
	},
);

it("loads WeCom deployment through the production conversation startup", async () => {
	vi.useFakeTimers();
	mocks.find.mockResolvedValue([]);
	const deployed = {
		...options,
		signing: {
			...options.signing,
			privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
		},
	};
	const source = `export function createPlatformConversationWorkerOptionsV2() {return {...${JSON.stringify(deployed)}, directory:{resolveUser:async()=>null}, resolveRuntimeHost:async()=>({}), log:()=>{}, wecom:{identity:{resolveSender:async()=>null,activeUsers:async()=>[]},observe:()=>{},sender:{send:async()=>"failed"}}};}`;
	const worker = await startPlatformConversationWorkerFromDeploymentV2(
		`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
	);
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.wecomDispatch).toHaveBeenCalledOnce();
	} finally {
		await worker.stop();
	}
});
