import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	close: vi.fn(async () => {}),
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
