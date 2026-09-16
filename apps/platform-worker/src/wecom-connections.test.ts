import type { WecomMessageV1 } from "@agent-infra/platform-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	release: vi.fn(async () => {}),
	connect: vi.fn(async () => {}),
	terminal: null as string | null,
	socketClose: vi.fn(),
	storeClose: vi.fn(async () => {}),
	socketSend: vi.fn(async () => "sent"),
	receive: undefined as
		| undefined
		| ((message: WecomMessageV1) => Promise<void>),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresWecomConnectionsV1: class {
		claim = mocks.claim;
		release = mocks.release;
		renew = async () => true;
		close = mocks.storeClose;
	},
}));
vi.mock("@agent-infra/wecom/worker", () => ({
	createWecomWebSocketV1: (options: {
		receive: (message: WecomMessageV1) => Promise<void>;
	}) => {
		mocks.receive = options.receive;
		return {
			connect: mocks.connect,
			close: mocks.socketClose,
			get terminalReason() {
				return mocks.terminal;
			},
			sender: { send: mocks.socketSend },
		};
	},
}));

import { createPlatformWecomConnectionsV1 } from "./wecom-connections.js";

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	mocks.terminal = null;
	mocks.claim.mockImplementation(async (input) => ({
		...input,
		fence: 1,
		leaseUntil: new Date(Date.now() + 30000),
	}));
});
afterEach(() => vi.useRealTimers());
it.each(["timeout", "retry_exhausted", "auth_failed"])(
	"recovers %s only when its retry policy allows",
	async (reason) => {
		let credentialVersion = "v1";
		const worker = createPlatformWecomConnectionsV1({
			databaseUrl: "postgres://fixture",
			holderId: "worker",
			bindings: async () => [
				{
					botId: "bot",
					agentId: "agent",
					bindingReference: "binding",
					credentialVersion,
					secret: "fixture",
				},
			],
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
			receive: async () => ({ outcome: "denied" }),
		});
		try {
			await worker.tick();
			expect(mocks.connect).toHaveBeenCalledTimes(1);
			mocks.terminal = reason;
			await worker.tick();
			expect(mocks.release).toHaveBeenCalledTimes(1);
			// A failed connection cannot cause an immediate tight reconnect loop.
			expect(mocks.connect).toHaveBeenCalledTimes(1);
			mocks.terminal = null;
			await vi.advanceTimersByTimeAsync(5000);
			await worker.tick();
			expect(mocks.connect).toHaveBeenCalledTimes(
				reason === "auth_failed" ? 1 : 2,
			);
			if (reason === "auth_failed") {
				credentialVersion = "v2";
				await worker.tick();
				expect(mocks.connect).toHaveBeenCalledTimes(2);
			}
		} finally {
			await worker.close();
		}
	},
);

it.each([false, true])(
	"releases claimed leases after reconcile failure even if release fails: %s",
	async (releaseFails) => {
		mocks.connect.mockRejectedValueOnce(new Error("connect unavailable"));
		if (releaseFails)
			mocks.release.mockRejectedValueOnce(new Error("release unavailable"));
		const worker = createPlatformWecomConnectionsV1({
			databaseUrl: "postgres://fixture",
			holderId: "worker",
			bindings: async () => [
				{
					botId: "bot",
					agentId: "agent",
					bindingReference: "binding",
					credentialVersion: "v1",
					secret: "fixture",
				},
			],
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
			receive: async () => ({ outcome: "denied" }),
		});
		try {
			await expect(worker.tick()).rejects.toThrow("connect unavailable");
			expect(mocks.release).toHaveBeenCalledWith(
				expect.objectContaining({ botId: "bot", holderId: "worker", fence: 1 }),
			);
			await worker.tick();
			expect(mocks.connect).toHaveBeenCalledTimes(2);
		} finally {
			await worker.close();
		}
	},
);

it("closes every connection and store when releasing the first lease fails", async () => {
	const worker = createPlatformWecomConnectionsV1({
		databaseUrl: "postgres://fixture",
		holderId: "worker",
		bindings: async () =>
			["one", "two"].map((botId) => ({
				botId,
				agentId: botId,
				bindingReference: botId,
				credentialVersion: "v1",
				secret: "fixture",
			})),
		protectReply: async () => "fixture",
		revealReply: async () => {
			throw new Error("unused");
		},
		receive: async () => ({ outcome: "denied" }),
	});
	await worker.tick();
	mocks.release.mockRejectedValueOnce(new Error("release unavailable"));
	await expect(worker.close()).rejects.toThrow("release unavailable");
	expect(mocks.socketClose).toHaveBeenCalledTimes(2);
	expect(mocks.release).toHaveBeenCalledTimes(2);
	expect(mocks.storeClose).toHaveBeenCalledTimes(1);
});

it("reconciles more than 100 bindings and responds when ingress persistence fails", async () => {
	const receive = vi.fn(async () => {
		throw new Error("database unavailable");
	});
	const worker = createPlatformWecomConnectionsV1({
		databaseUrl: "postgres://fixture",
		holderId: "worker",
		bindings: async () =>
			Array.from({ length: 101 }, (_, i) => ({
				botId: `bot-${i}`,
				agentId: `agent-${i}`,
				bindingReference: `binding-${i}`,
				credentialVersion: "v1",
				secret: "fixture",
			})),
		protectReply: async () => "fixture",
		revealReply: async () => {
			throw new Error("unused");
		},
		receive,
	});
	try {
		await worker.tick();
		expect(mocks.connect).toHaveBeenCalledTimes(101);
		const message: WecomMessageV1 = {
			agentId: "agent-100",
			bindingReference: "binding-100",
			kind: "wecom_bot",
			senderId: "sender",
			peerId: "peer",
			conversationType: "single",
			threadId: null,
			providerId: "bot-100",
			eventId: "event",
			text: "fixture",
			replyHandle: "reply",
			replyExpiresAt: new Date(Date.now() + 60000).toISOString(),
		};
		await mocks.receive?.(message);
		expect(receive).toHaveBeenCalledOnce();
		expect(mocks.socketSend).toHaveBeenCalledWith({
			scope: message,
			replyHandle: "reply",
			text: "Agent 当前不可用，请稍后重试",
		});
	} finally {
		await worker.close();
	}
});
