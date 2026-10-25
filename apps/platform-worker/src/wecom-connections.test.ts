import type { WecomMessageV1 } from "@agent-infra/platform-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	current: vi.fn(async () => true),
	release: vi.fn(async () => {}),
	connect: vi.fn(async () => {}),
	terminal: null as string | null,
	socketClose: vi.fn(),
	storeClose: vi.fn(async () => {}),
	socketSend: vi.fn(async () => "sent"),
	socketAcknowledge: vi.fn(async () => "sent"),
	receive: undefined as
		| undefined
		| ((message: WecomMessageV1) => Promise<void>),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresWecomConnectionsV1: class {
		claim = mocks.claim;
		current = mocks.current;
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
			acknowledge: mocks.socketAcknowledge,
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
	mocks.current.mockResolvedValue(true);
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

it("lets a replacement binding connect without retrying the failed binding", async () => {
	let agentId = "original-agent";
	let bindingReference = "original-binding";
	const worker = createPlatformWecomConnectionsV1({
		databaseUrl: "postgres://fixture",
		holderId: "worker",
		bindings: async () => [
			{
				botId: "bot",
				agentId,
				bindingReference,
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
		await worker.tick();
		mocks.terminal = "auth_failed";
		await worker.tick();
		expect(mocks.connect).toHaveBeenCalledTimes(1);

		mocks.terminal = null;
		agentId = "replacement-agent";
		bindingReference = "replacement-binding";
		await worker.tick();
		expect(mocks.connect).toHaveBeenCalledTimes(2);

		agentId = "original-agent";
		bindingReference = "original-binding";
		await worker.tick();
		expect(mocks.connect).toHaveBeenCalledTimes(2);
	} finally {
		await worker.close();
	}
});

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
		await vi.waitFor(() =>
			expect(mocks.socketSend).toHaveBeenCalledWith({
				scope: message,
				replyHandle: "reply",
				text: "Agent 当前不可用，请稍后重试",
			}),
		);
	} finally {
		await worker.close();
	}
});

it("does not reply after the connection lease is lost", async () => {
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
		await worker.tick();
		mocks.current.mockResolvedValueOnce(false);
		await mocks.receive?.({
			agentId: "agent",
			bindingReference: "binding",
			kind: "wecom_bot",
			senderId: "sender",
			peerId: "peer",
			conversationType: "single",
			threadId: null,
			providerId: "bot",
			eventId: "event",
			text: "fixture",
			replyHandle: "reply",
			replyExpiresAt: new Date(Date.now() + 60000).toISOString(),
		});
	} finally {
		await worker.close();
	}
	expect(mocks.socketSend).not.toHaveBeenCalled();
});

it("does not route application scopes through a bot socket", async () => {
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
		await worker.tick();
		await expect(
			worker.sender.send({
				scope: {
					agentId: "agent",
					bindingReference: "binding",
					kind: "wecom_app",
					senderId: "sender",
					peerId: "peer",
					conversationType: "single",
					threadId: null,
				},
				replyHandle: "reply",
				text: "fixture",
			}),
		).resolves.toBe("failed");
		expect(mocks.socketSend).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

it("revalidates the lease immediately before sending a reply", async () => {
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
		await worker.tick();
		mocks.current.mockResolvedValue(false);
		await expect(
			worker.sender.send({
				scope: {
					agentId: "agent",
					bindingReference: "binding",
					kind: "wecom_bot",
					senderId: "sender",
					peerId: "peer",
					conversationType: "single",
					threadId: null,
				},
				replyHandle: "reply",
				text: "fixture",
			}),
		).resolves.toBe("failed");
		expect(mocks.socketSend).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

// #3077：新受理的消息立即在原 stream 上回处理中提示；繁忙、重投与拒绝的消息不发。
it.each([
	[
		"a newly accepted message",
		{ outcome: "accepted", status: "accepted" },
		true,
	],
	["a busy acceptance", { outcome: "accepted", status: "busy" }, false],
	["a replayed message", { outcome: "replayed", status: "accepted" }, false],
] as const)(
	"acknowledges %s only when it started an execution",
	async (_name, decision, acknowledged) => {
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
			receive: async () => ({
				outcome: decision.outcome,
				receipt: {
					receiptId: "receipt",
					status: decision.status,
					conversationId: "conversation",
					executionId: decision.status === "accepted" ? "execution" : null,
				},
			}),
		});
		try {
			await worker.tick();
			const message: WecomMessageV1 = {
				agentId: "agent",
				bindingReference: "binding",
				kind: "wecom_bot",
				senderId: "sender",
				peerId: "peer",
				conversationType: "single",
				threadId: null,
				providerId: "bot",
				eventId: "event",
				text: "fixture",
				replyHandle: "reply",
				replyExpiresAt: new Date(Date.now() + 60000).toISOString(),
			};
			await mocks.receive?.(message);
			if (acknowledged)
				await vi.waitFor(() =>
					expect(mocks.socketAcknowledge).toHaveBeenCalledWith({
						scope: message,
						replyHandle: "reply",
						text: "已收到，正在处理…",
					}),
				);
		} finally {
			// 关闭等待受理之后在槽位外发送的回复结束。
			await worker.close();
		}
		if (!acknowledged) expect(mocks.socketAcknowledge).not.toHaveBeenCalled();
		expect(mocks.socketSend).not.toHaveBeenCalled();
	},
);

// #3374：处理中提示在会话键的串行槽位之外发送，等待 ACK 不推迟同一会话的下一条消息。
it("returns from admission before the processing notice is acknowledged", async () => {
	let acknowledge: (status: string) => void = () => {};
	mocks.socketAcknowledge.mockImplementationOnce(
		() =>
			new Promise<string>((resolve) => {
				acknowledge = resolve;
			}),
	);
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
		receive: async () => ({
			outcome: "accepted",
			receipt: {
				receiptId: "receipt",
				status: "accepted",
				conversationId: "conversation",
				executionId: "execution",
			},
		}),
	});
	try {
		await worker.tick();
		await mocks.receive?.({
			agentId: "agent",
			bindingReference: "binding",
			kind: "wecom_bot",
			senderId: "sender",
			peerId: "peer",
			conversationType: "single",
			threadId: null,
			providerId: "bot",
			eventId: "event",
			text: "fixture",
			replyHandle: "reply",
			replyExpiresAt: new Date(Date.now() + 60000).toISOString(),
		});
		// 受理已返回，处理中提示仍在等待 ACK。
		await vi.waitFor(() => expect(mocks.socketAcknowledge).toHaveBeenCalled());
	} finally {
		acknowledge("sent");
		await worker.close();
	}
});

// #3376：排队受理的消息首帧是排队提示，之后的位次更新走同一 stream，只由持有租约的连接发送。
it("acknowledges a queued message with its position and updates the same stream later", async () => {
	const queued: [string, number][] = [];
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
		onQueued: (receiptId, position) => queued.push([receiptId, position]),
		receive: async () => ({
			outcome: "accepted",
			receipt: {
				receiptId: "receipt",
				status: "accepted",
				conversationId: "conversation",
				executionId: "execution",
				queuePosition: 2,
			},
		}),
	});
	try {
		await worker.tick();
		const message: WecomMessageV1 = {
			agentId: "agent",
			bindingReference: "binding",
			kind: "wecom_bot",
			senderId: "sender",
			peerId: "peer",
			conversationType: "single",
			threadId: null,
			providerId: "bot",
			eventId: "event",
			text: "fixture",
			replyHandle: "reply",
			replyExpiresAt: new Date(Date.now() + 60000).toISOString(),
		};
		await mocks.receive?.(message);
		expect(queued).toEqual([["receipt", 2]]);
		expect(mocks.socketAcknowledge).toHaveBeenCalledWith({
			scope: message,
			replyHandle: "reply",
			text: "已排队：第 2 位，前面还有 1 条消息，当前回复结束后按顺序处理",
		});
		mocks.socketAcknowledge.mockClear();
		await expect(
			worker.updater.update({
				scope: message,
				replyHandle: "reply",
				text: "开始处理",
			}),
		).resolves.toBe("sent");
		expect(mocks.socketAcknowledge).toHaveBeenCalledWith({
			scope: message,
			replyHandle: "reply",
			text: "开始处理",
		});
		// 其他机器人或自建应用的回执没有本连接，不发送。
		await expect(
			worker.updater.update({
				scope: { ...message, bindingReference: "other-binding" },
				replyHandle: "reply",
				text: "开始处理",
			}),
		).resolves.toBe("failed");
		expect(mocks.socketSend).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

it("does not acknowledge after the connection lease is lost", async () => {
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
		receive: async () => ({
			outcome: "accepted",
			receipt: {
				receiptId: "receipt",
				status: "accepted",
				conversationId: "conversation",
				executionId: "execution",
			},
		}),
	});
	try {
		await worker.tick();
		mocks.current.mockResolvedValueOnce(false);
		await mocks.receive?.({
			agentId: "agent",
			bindingReference: "binding",
			kind: "wecom_bot",
			senderId: "sender",
			peerId: "peer",
			conversationType: "single",
			threadId: null,
			providerId: "bot",
			eventId: "event",
			text: "fixture",
			replyHandle: "reply",
			replyExpiresAt: new Date(Date.now() + 60000).toISOString(),
		});
	} finally {
		await worker.close();
	}
	expect(mocks.socketAcknowledge).not.toHaveBeenCalled();
});

// #3374：同一会话键的下一帧要等这一帧受理结束；受理最多占用到回复有效期结束，依赖挂起时也会释放。
it("bounds one admission by the reply lifetime so a stuck frame releases its session slot", async () => {
	vi.useRealTimers();
	let observed: AbortSignal | undefined;
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
		receive: (_message, _fence, signal) =>
			new Promise((resolve) => {
				observed = signal;
				// 模拟挂起的依赖：只有截止信号能结束这次受理。
				signal?.addEventListener("abort", () =>
					resolve({ outcome: "unavailable" }),
				);
			}),
	});
	try {
		await worker.tick();
		await mocks.receive?.({
			agentId: "agent",
			bindingReference: "binding",
			kind: "wecom_bot",
			senderId: "sender",
			peerId: "peer",
			conversationType: "single",
			threadId: null,
			providerId: "bot",
			eventId: "event",
			text: "fixture",
			replyHandle: "reply",
			replyExpiresAt: new Date(Date.now() + 50).toISOString(),
		});
		expect(observed?.aborted).toBe(true);
	} finally {
		await worker.close();
	}
});
