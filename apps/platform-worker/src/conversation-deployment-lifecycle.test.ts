// Controlled process-lifecycle fixtures; these do not establish real Key/PG acceptance.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	options: undefined as unknown,
	runtimeClose: vi.fn(async () => {}),
	storeClose: vi.fn(async () => {}),
}));
vi.mock("./deployment-entry.js", () => ({
	createPlatformConversationWorkerOptionsV2: async () => mocks.options,
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresConversationDispatchStoreV1: () => ({
		findDispatchable: async () => [],
		close: mocks.storeClose,
	}),
	PostgresConversationEventTransactionV1: class {
		close = mocks.storeClose;
	},
	PostgresTaskAuthorizationStoreV1: class {
		close = mocks.storeClose;
	},
	PostgresLegacyTaskRecoveryReaderV1: class {
		close = mocks.storeClose;
	},
}));
vi.mock("@agent-infra/platform-core", () => ({
	createConversationDispatchUseCaseV1: () => ({ dispatch: async () => {} }),
	createConversationEventUseCaseV1: () => ({}),
}));
vi.mock("./conversation-runtime.js", () => ({
	createConversationRuntimeV2: () => ({
		authorization: {},
		runtimeHost: {},
		close: mocks.runtimeClose,
	}),
}));

import { startPlatformConversationWorkerFromDeploymentV2 } from "./conversation-worker.js";

const options = {
	databaseUrl: "postgres://fixture",
	workerId: "fixture-process",
	log: () => {},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.runtimeClose.mockResolvedValue(undefined);
	mocks.storeClose.mockResolvedValue(undefined);
});

describe("deployment-owned resources around the original Conversation Worker", () => {
	it.each([false, true])(
		"joins the original Worker before closing resources (join rejects: %s)",
		async (rejects) => {
			const joining = Promise.withResolvers<void>();
			const runtimeEntered = Promise.withResolvers<void>();
			mocks.runtimeClose.mockImplementation(() => {
				runtimeEntered.resolve();
				return joining.promise;
			});
			const closing = Promise.withResolvers<void>();
			const closeEntered = Promise.withResolvers<void>();
			const closeDeployment = vi.fn(() => {
				closeEntered.resolve();
				return closing.promise;
			});
			mocks.options = { ...options, closeDeployment };
			const worker = await startPlatformConversationWorkerFromDeploymentV2(
				"./deployment-entry.js",
			);
			let settled = false;
			const stopping = worker.stop();
			const observed = stopping.then(
				() => {
					settled = true;
					return undefined;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			expect(worker.stop()).toBe(stopping);
			await runtimeEntered.promise;
			expect(closeDeployment).not.toHaveBeenCalled();
			const failure = new Error("fixture original join failure");
			if (rejects) joining.reject(failure);
			else joining.resolve();
			await closeEntered.promise;
			expect(settled).toBe(false);
			expect(mocks.storeClose).toHaveBeenCalledTimes(4);
			closing.reject(new Error("fixture cleanup failure"));
			expect(await observed).toEqual(
				rejects ? failure : new Error("fixture cleanup failure"),
			);
			expect(closeDeployment).toHaveBeenCalledOnce();
		},
	);

	it("joins cleanup on construction failure and preserves the construction error", async () => {
		const closing = Promise.withResolvers<void>();
		const closeEntered = Promise.withResolvers<void>();
		const closeDeployment = vi.fn(() => {
			closeEntered.resolve();
			return closing.promise;
		});
		mocks.options = { ...options, pollIntervalMs: 0, closeDeployment };
		let settled = false;
		const starting = startPlatformConversationWorkerFromDeploymentV2(
			"./deployment-entry.js",
		).catch((error: unknown) => {
			settled = true;
			return error;
		});
		await closeEntered.promise;
		expect(settled).toBe(false);
		closing.reject(new Error("fixture cleanup failure"));
		expect(await starting).toEqual(
			new TypeError("Conversation Worker polling options are invalid"),
		);
		expect(closeDeployment).toHaveBeenCalledOnce();
		expect(mocks.runtimeClose).not.toHaveBeenCalled();
	});

	it("supports caller-owned dependencies without a deployment cleanup hook", async () => {
		mocks.options = options;
		const worker = await startPlatformConversationWorkerFromDeploymentV2(
			"./deployment-entry.js",
		);
		await worker.stop();
		expect(mocks.runtimeClose).toHaveBeenCalledOnce();
	});
});
