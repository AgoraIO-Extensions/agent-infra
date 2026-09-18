import type { WecomSendPortV1 } from "@agent-infra/platform-core";
import type { WecomWebSocketConfigurationV1 } from "@agent-infra/wecom/worker";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	storeOpen: vi.fn(),
	sender: undefined as WecomSendPortV1 | undefined,
	close: vi.fn(async () => {}),
	connectionsTick: vi.fn(async () => {}),
	connectionsClose: vi.fn(async () => {}),
	setupClose: vi.fn(async () => {}),
	connectionBindings: undefined as
		| (() => Promise<readonly WecomWebSocketConfigurationV1[]>)
		| undefined,
	deploymentBindings: vi.fn(
		async (): Promise<readonly WecomWebSocketConfigurationV1[]> => [],
	),
	setupBindings: vi.fn(
		async (): Promise<readonly WecomWebSocketConfigurationV1[]> => [],
	),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresWecomChannelV1: class {
		constructor() {
			mocks.storeOpen();
		}
		close = mocks.close;
	},
}));
vi.mock("@agent-infra/platform-core", () => ({
	createWecomAuthorizationV1: () => ({}),
	createWecomChannelV1: () => ({}),
	createWecomDeliveryV1: (options: { sender: WecomSendPortV1 }) => {
		mocks.sender = options.sender;
		return { dispatch: mocks.dispatch };
	},
}));

vi.mock("./wecom-connections.js", () => ({
	createPlatformWecomConnectionsV1: (options: {
		bindings: () => Promise<readonly WecomWebSocketConfigurationV1[]>;
	}) => {
		mocks.connectionBindings = options.bindings;
		return {
			tick: mocks.connectionsTick,
			close: mocks.connectionsClose,
		};
	},
}));
vi.mock("./wecom-setup.js", () => ({
	createWecomSetupWorkerV1: () => ({
		tick: async () => {},
		close: mocks.setupClose,
		bindings: mocks.setupBindings,
	}),
}));

import { createPlatformWecomWorkerV1 } from "./wecom-worker.js";

afterEach(() => vi.resetAllMocks());

it("merges setup bindings by botId and lets setup take precedence", async () => {
	const deployment = [
		{
			botId: "bot-1",
			agentId: "agent-1",
			bindingReference: "deployment",
			credentialVersion: "v1",
			secret: "deployment-secret",
		},
		{
			botId: "bot-2",
			agentId: "agent-2",
			bindingReference: "deployment-2",
			credentialVersion: "v1",
			secret: "deployment-secret-2",
		},
	];
	const setup = {
		botId: "bot-1",
		agentId: "agent-1",
		bindingReference: "setup",
		credentialVersion: "v2",
		secret: "setup-secret",
	};
	mocks.deploymentBindings.mockResolvedValue(deployment);
	mocks.setupBindings.mockResolvedValue([setup]);
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send: async () => "failed" },
		connections: {
			bindings: mocks.deploymentBindings,
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("unused");
			},
		},
		setup: {
			decryptor: {
				decrypt: async () => {
					throw new Error("unused");
				},
			},
			directory: { resolveUser: async () => null },
		},
	});
	try {
		await expect(mocks.connectionBindings?.()).resolves.toEqual([
			setup,
			deployment[1],
		]);
	} finally {
		await worker.close();
	}
});

it.each([false, true])(
	"bounds a reply batch and settles every claim before returning, rejection=%s",
	async (reject) => {
		const pending = Array.from({ length: 8 }, () =>
			Promise.withResolvers<boolean>(),
		);
		let index = 0;
		mocks.dispatch.mockImplementation(() => pending[index++]?.promise);
		const worker = createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
		});
		try {
			const result = worker.dispatch();
			const settled = vi.fn();
			void result.then(settled, settled);
			await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(8));
			if (reject) pending[0]?.reject(new Error("delivery unavailable"));
			else pending[0]?.resolve(true);
			await Promise.resolve();
			expect(settled).not.toHaveBeenCalled();
			for (const item of pending.slice(1)) item.resolve(false);
			if (reject) await expect(result).rejects.toThrow("delivery unavailable");
			else expect(await result).toBe(true);
			expect(mocks.dispatch).toHaveBeenCalledTimes(8);
		} finally {
			for (const item of pending) item.resolve(false);
			await worker.close();
		}
	},
);

it.each(["reconcile", "setup-close", "connections-close"])(
	"continues independent work after %s fails",
	async (mode) => {
		const worker = createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
			connections: {
				bindings: async () => [],
				protectReply: async () => "fixture",
				revealReply: async () => {
					throw new Error("unused");
				},
			},
			setup: {
				decryptor: {
					decrypt: async () => {
						throw new Error("unused");
					},
				},
				directory: { resolveUser: async () => null },
			},
		});
		if (mode === "reconcile") {
			mocks.connectionsTick.mockRejectedValueOnce(
				new Error("reconcile unavailable"),
			);
			mocks.dispatch.mockResolvedValue(true);
			await expect(worker.reconcile()).rejects.toThrow("reconcile unavailable");
			expect(await worker.dispatch()).toBe(true);
			expect(mocks.dispatch).toHaveBeenCalledTimes(8);
			await worker.close();
		} else {
			(mode === "setup-close"
				? mocks.setupClose
				: mocks.connectionsClose
			).mockRejectedValueOnce(new Error("close unavailable"));
			await expect(worker.close()).rejects.toThrow("close unavailable");
		}
		expect(mocks.setupClose).toHaveBeenCalledTimes(1);
		expect(mocks.connectionsClose).toHaveBeenCalledTimes(1);
		expect(mocks.close).toHaveBeenCalledTimes(1);
	},
);

it("classifies a rejected reply route as failed without calling any external sender", async () => {
	const send = vi.fn(async () => "sent" as const);
	const worker = createPlatformWecomWorkerV1({
		databaseUrl: "postgres://fixture",
		identity: { resolveSender: async () => null, activeUsers: async () => [] },
		observe: () => {},
		sender: { send },
		connections: {
			bindings: async () => [],
			protectReply: async () => "fixture",
			revealReply: async () => {
				throw new Error("invalid route");
			},
		},
	});
	try {
		expect(
			await mocks.sender?.send({
				scope: {
					agentId: "agent",
					bindingReference: "binding",
					kind: "wecom_bot",
					senderId: "sender",
					peerId: "peer",
					conversationType: "single",
					threadId: null,
				},
				replyHandle: "invalid",
				text: "fixture",
			}),
		).toBe("failed");
		expect(send).not.toHaveBeenCalled();
	} finally {
		await worker.close();
	}
});

it("rejects invalid setup deployment before opening a database store", () => {
	expect(() =>
		createPlatformWecomWorkerV1({
			databaseUrl: "postgres://fixture",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
			setup: {
				directory: { resolveUser: async () => null },
				decryptor: {
					decrypt: async () => {
						throw new Error("unused");
					},
				},
			},
		}),
	).toThrow("requires a connection deployment");
	expect(mocks.storeOpen).not.toHaveBeenCalled();
});
