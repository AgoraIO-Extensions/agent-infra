import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	close: vi.fn(async () => {}),
	connectionsTick: vi.fn(async () => {}),
	connectionsClose: vi.fn(async () => {}),
	setupClose: vi.fn(async () => {}),
}));
vi.mock("@agent-infra/platform-store", () => ({
	PostgresWecomChannelV1: class {
		close = mocks.close;
	},
}));
vi.mock("@agent-infra/platform-core", () => ({
	createWecomAuthorizationV1: () => ({}),
	createWecomChannelV1: () => ({}),
	createWecomDeliveryV1: () => ({ dispatch: mocks.dispatch }),
}));

vi.mock("./wecom-connections.js", () => ({
	createPlatformWecomConnectionsV1: () => ({
		tick: mocks.connectionsTick,
		close: mocks.connectionsClose,
	}),
}));
vi.mock("./wecom-setup.js", () => ({
	createWecomSetupWorkerV1: () => ({
		tick: async () => {},
		close: mocks.setupClose,
	}),
}));

import { createPlatformWecomWorkerV1 } from "./wecom-worker.js";

afterEach(() => vi.resetAllMocks());
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
			await expect(worker.dispatch()).rejects.toThrow("reconcile unavailable");
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
