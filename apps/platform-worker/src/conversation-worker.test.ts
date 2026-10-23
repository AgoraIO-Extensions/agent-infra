import { generateKeyPairSync } from "node:crypto";
import type { ObservabilitySpan } from "@agent-infra/observability";
import type { ConnectionInstallationCommandDrainStoreV1 } from "@agent-infra/platform-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	claimSandbox: vi.fn(),
	prepareSandbox: vi.fn(),
	recordSandbox: vi.fn(),
	dispatch: vi.fn(),
	storeClose: vi.fn(async () => {}),
	eventsClose: vi.fn(async () => {}),
	authorizationClose: vi.fn(async () => {}),
	legacyClose: vi.fn(async () => {}),
	deploymentClose: vi.fn(async () => {}),
	runtimeClose: vi.fn(),
	dispatchAssemblyThrows: false,
	signal: undefined as AbortSignal | undefined,
	channelAuthorizationCurrent: undefined as unknown,
	transaction: undefined as unknown,
	observedEvents: { persist: vi.fn() },
	observedFactory: vi.fn(),
	telemetryRecord: vi.fn(),
	dispatchEvents: undefined as unknown,
	dispatchAuthorization: undefined as unknown,
	dispatchRuntimeHost: undefined as unknown,
	authorize: vi.fn(),
	runtimeDispatch: vi.fn(),
	installationActiveExecutionIds: vi.fn(() => ["execution-a"]),
	installationCanDrain: vi.fn(() => true),
	installationDrain: vi.fn(),
	wake: undefined as (() => void) | undefined,
	wakeStart: vi.fn(async () => {}),
	wakeClose: vi.fn(async () => {}),
}));
vi.mock("@agent-infra/platform-store", () => ({
	openPostgresConversationDispatchStoreV1: () => ({
		findDispatchable: mocks.find,
		claimSandboxReconciliation: mocks.claimSandbox,
		prepareSandboxReconciliation: mocks.prepareSandbox,
		recordSandboxObservation: mocks.recordSandbox,
		close: mocks.storeClose,
	}),
	PostgresConversationEventTransactionV1: class {
		constructor() {
			mocks.transaction = this;
		}
		close = mocks.eventsClose;
	},
	PostgresTaskAuthorizationStoreV1: class {
		close = mocks.authorizationClose;
	},
	PostgresLegacyTaskRecoveryReaderV1: class {
		close = mocks.legacyClose;
	},
	outboxWakeChannelV1: "agent_infra_outbox_available",
	PostgresCommitWakeupListenerV1: class {
		constructor(input: { onWake: () => void }) {
			mocks.wake = () => input.onWake();
		}
		start = mocks.wakeStart;
		close = mocks.wakeClose;
	},
}));
vi.mock("@agent-infra/platform-core", async (importOriginal) => ({
	ConversationRuntimeHostError: (
		await importOriginal<typeof import("@agent-infra/platform-core")>()
	).ConversationRuntimeHostError,
	createConversationDispatchUseCaseV1: (dependencies: {
		events: unknown;
		authorization: unknown;
		runtimeHost: unknown;
	}) => {
		if (mocks.dispatchAssemblyThrows)
			throw new Error("synthetic dispatch assembly failure");
		mocks.dispatchEvents = dependencies.events;
		mocks.dispatchAuthorization = dependencies.authorization;
		mocks.dispatchRuntimeHost = dependencies.runtimeHost;
		return { dispatch: mocks.dispatch };
	},
	createConversationEventUseCaseV1: () => ({}),
}));
vi.mock("@agent-infra/observability/worker", () => ({
	createObservedConversationEvents: (dependencies: unknown) => {
		mocks.observedFactory(dependencies);
		return mocks.observedEvents;
	},
}));
vi.mock("./conversation-runtime.js", () => ({
	createConversationRuntimeV2: (options: {
		signal: AbortSignal;
		channelAuthorizationCurrent?: unknown;
	}) => {
		mocks.channelAuthorizationCurrent = options.channelAuthorizationCurrent;
		mocks.signal = options.signal;
		return {
			authorization: { authorize: mocks.authorize },
			runtimeHost: { dispatch: mocks.runtimeDispatch },
			connectionInstallation: {
				activeExecutionIds: mocks.installationActiveExecutionIds,
				canDrain: mocks.installationCanDrain,
				drain: mocks.installationDrain,
			},
			close: mocks.runtimeClose,
		};
	},
}));

afterEach(() => vi.useRealTimers());

import { createPlatformConversationWorkerV2 } from "./conversation-worker.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";

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
	sandboxPolicy: {
		namespace: "synthetic",
		resourceConfigurationHash: "synthetic",
	},
	receiveSandbox: async () => ({ status: "unknown" as const, resources: [] }),
	maximumConcurrentDispatches: 1,
	closeDeployment: mocks.deploymentClose,
	log: vi.fn(),
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.signal = undefined;
	mocks.dispatchAssemblyThrows = false;
	mocks.telemetryRecord.mockReset();
	mocks.claimSandbox.mockReset();
	mocks.prepareSandbox.mockReset();
	mocks.recordSandbox.mockReset();
	mocks.prepareSandbox.mockResolvedValue(true);
	mocks.transaction = undefined;
	mocks.dispatchEvents = undefined;
	vi.mocked(options.log).mockReset();
});

describe("Conversation Worker discovery and shutdown", () => {
	it("exposes one poller lifecycle and logs each transition once", async () => {
		mocks.find.mockResolvedValue([]);
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: { record: mocks.telemetryRecord },
		});
		expect(worker.status()).toBe("not_started");
		worker.start();
		worker.start();
		expect(worker.status()).toBe("running");
		await vi.waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(1));
		expect(options.log).toHaveBeenCalledWith(
			JSON.stringify({
				service: "platform-worker",
				component: "conversation",
				code: "CONVERSATION_DISPATCH_STARTED",
			}),
		);
		const stopping = worker.stop();
		expect(worker.status()).toBe("stopping");
		expect(options.log).toHaveBeenCalledWith(
			JSON.stringify({
				service: "platform-worker",
				component: "conversation",
				code: "CONVERSATION_DISPATCH_STOPPING",
			}),
		);
		await stopping;
		expect(worker.status()).toBe("stopped");
		expect(options.log).toHaveBeenCalledWith(
			JSON.stringify({
				service: "platform-worker",
				component: "conversation",
				code: "CONVERSATION_DISPATCH_STOPPED",
			}),
		);
		expect(
			options.log.mock.calls.filter(([message]) =>
				String(message).includes("CONVERSATION_DISPATCH_STARTED"),
			),
		).toHaveLength(1);
		expect(
			options.log.mock.calls.filter(([message]) =>
				String(message).includes("CONVERSATION_DISPATCH_STOPPED"),
			),
		).toHaveLength(1);
	});
	it("receives a sandbox reconciliation through the existing discovery lease", async () => {
		const claim = { schemaVersion: 1, execution: null } as never;
		mocks.find.mockResolvedValue([
			{ itemId: "sandbox-1", operation: "conversation.sandbox.reconcile.v1" },
		]);
		mocks.claimSandbox.mockResolvedValue(claim);
		mocks.recordSandbox.mockResolvedValue(undefined);
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		expect(await worker.tick()).toBe(1);
		await vi.waitFor(() => expect(mocks.recordSandbox).toHaveBeenCalled());
		await worker.stop();
		expect(mocks.claimSandbox).toHaveBeenCalledWith(
			expect.objectContaining({ itemId: "sandbox-1", workerId: "instance" }),
			expect.any(Function),
		);
		expect(mocks.prepareSandbox.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(mocks.recordSandbox).toHaveBeenCalledWith({
			claim,
			observation: { status: "unknown", resources: [] },
		});
		expect(telemetry.record).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: "workload",
				outcome: "unknown",
				operationRef: "sandbox.reconcile.prepare",
				durationMs: expect.any(Number),
			}),
		);
	});
	it("drains begin and persists the returned authorization URL", async () => {
		mocks.find.mockResolvedValue([]);
		mocks.installationDrain.mockResolvedValue({
			schemaVersion: 1,
			authorizationId: "authorization-a",
			phase: "awaiting_callback",
			expiresAt: Date.now() + 600_000,
			authorizationUrl: `https://connection.test/oauth/authorize?state=${"a".repeat(64)}`,
		});
		const settle = vi.fn(async () => true);
		const worker = createPlatformConversationWorkerV2({
			...options,
			connectionInstallation: {
				configuration: {} as never,
				authorize: async () => null,
				commandStore: {
					listPending: async () => [
						{
							authorization: {
								authorizationId: "authorization-a",
								reference: { executionId: "execution-a" },
							},
							command: {
								commandId: "command-a",
								command: "begin",
							},
						},
					],
					claimPending: async () => ({
						authorization: {
							authorizationId: "authorization-a",
							reference: { executionId: "execution-a" },
						},
						command: {
							commandId: "command-a",
							command: "begin",
						},
					}),
					settle,
				} as unknown as ConnectionInstallationCommandDrainStoreV1,
			},
		});
		await worker.tick();
		expect(settle).toHaveBeenCalledWith({
			commandId: "command-a",
			attemptId: expect.any(String),
			attemptOwner: "instance",
			status: "completed",
			authorizationUrl: `https://connection.test/oauth/authorize?state=${"a".repeat(64)}`,
			authorizationExpiresAt: expect.any(Number),
		});
		await worker.stop();
	});
	it("discovers committed work on a wakeup without waiting for the poll (#1561)", async () => {
		mocks.find.mockResolvedValue([]);
		mocks.dispatch.mockResolvedValue(undefined);
		const worker = createPlatformConversationWorkerV2({
			...options,
			pollIntervalMs: 30_000,
		});
		worker.start();
		await vi.waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(1));
		expect(mocks.wakeStart).toHaveBeenCalledTimes(1);
		mocks.find.mockResolvedValueOnce([
			{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
		]);
		mocks.wake?.();
		await vi.waitFor(() =>
			expect(mocks.dispatch).toHaveBeenCalledWith(
				expect.objectContaining({ itemId: "turn-a" }),
			),
		);
		await worker.stop();
		expect(mocks.wakeClose).toHaveBeenCalledTimes(1);
	});
	it("links a durable W3C context around the Worker dispatch", async () => {
		const traceParent =
			"00-1234567890abcdef1234567890abcdef-1234567890abcdef-01";
		const run = vi.fn((work: () => unknown) =>
			work(),
		) as unknown as ObservabilitySpan["run"];
		const span: ObservabilitySpan = {
			traceParent,
			run,
			end: vi.fn(),
		};
		const startSpan = vi.fn(() => span);
		mocks.find.mockResolvedValue([
			{
				itemId: "turn-linked",
				operation: "conversation.turn.submit.v1",
				traceParent,
			},
		]);
		mocks.dispatch.mockResolvedValue(undefined);
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: { record: vi.fn(), startSpan },
		});
		await worker.tick();
		await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalled());
		expect(startSpan).toHaveBeenCalledWith(
			"platform.worker.dispatch",
			expect.objectContaining({ link: traceParent }),
		);
		expect(span.run).toHaveBeenCalledTimes(1);
		expect(span.end).toHaveBeenCalledTimes(1);
		await worker.stop();
	});

	it("rescans once when a wakeup arrives during a scan (#1561)", async () => {
		const scan = Promise.withResolvers<[]>();
		mocks.find.mockReturnValueOnce(scan.promise).mockResolvedValue([]);
		const worker = createPlatformConversationWorkerV2({
			...options,
			pollIntervalMs: 30_000,
		});
		worker.start();
		await vi.waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(1));
		mocks.wake?.();
		mocks.wake?.();
		expect(mocks.find).toHaveBeenCalledTimes(1);
		scan.resolve([]);
		await vi.waitFor(() => expect(mocks.find).toHaveBeenCalledTimes(2));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mocks.find).toHaveBeenCalledTimes(2);
		await worker.stop();
	});

	it("keeps polling when commit wakeups are unavailable (#1561)", async () => {
		const logs: string[] = [];
		mocks.wakeStart.mockRejectedValueOnce(new Error("LISTEN unsupported"));
		mocks.find.mockResolvedValue([]);
		const worker = createPlatformConversationWorkerV2({
			...options,
			pollIntervalMs: 5,
			log: (message) => logs.push(message),
		});
		worker.start();
		await vi.waitFor(() =>
			expect(mocks.find.mock.calls.length).toBeGreaterThanOrEqual(3),
		);
		await worker.stop();
		expect(logs.join("")).toContain("CONVERSATION_COMMIT_WAKEUP_UNAVAILABLE");
	});

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
		expect(mocks.deploymentClose).toHaveBeenCalledTimes(1);
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
			expect(await worker.tick()).toBe(0);
			expect(await worker.tick()).toBe(1);
			expect(mocks.dispatch.mock.calls.map((call) => call[0].itemId)).toEqual([
				"turn-000",
				"zz-stop",
			]);
			expect(mocks.find.mock.calls[1]?.[0]).toMatchObject({
				limit: 256,
				afterItemId: "turn-000",
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
	it("does not starve runnable work behind a repeatedly busy short-page item", async () => {
		const items = ["blocked-a", "runnable-b"].map((itemId) => ({
			itemId,
			operation: "conversation.turn.submit.v1",
		}));
		mocks.find.mockImplementation(async ({ afterItemId }) => [
			...items.filter((item) => !afterItemId || item.itemId > afterItemId),
			...items.filter((item) => afterItemId && item.itemId <= afterItemId),
		]);
		mocks.dispatch.mockResolvedValue({ outcome: "busy" });
		const worker = createPlatformConversationWorkerV2(options);
		try {
			await worker.tick();
			await worker.tick();
			expect(mocks.dispatch.mock.calls.map((call) => call[0].itemId)).toEqual([
				"blocked-a",
				"runnable-b",
			]);
		} finally {
			await worker.stop();
		}
	});
	it("keeps the cursor after a short page and lets the Store wrap", async () => {
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
		expect(mocks.deploymentClose).toHaveBeenCalledTimes(1);
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
		expect(worker.status()).toBe("stopping");
		expect(options.log).toHaveBeenCalledWith(
			JSON.stringify({
				service: "platform-worker",
				component: "conversation",
				code: "CONVERSATION_DISPATCH_STOP_FAILED",
			}),
		);
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

it("observes persisted conversation events through the original transaction", async () => {
	const telemetry = { record: vi.fn() };
	const worker = createPlatformConversationWorkerV2({
		...options,
		observability: telemetry,
	});
	expect(mocks.observedFactory).toHaveBeenCalledWith({
		transaction: mocks.transaction,
		telemetry,
	});
	expect(mocks.dispatchEvents).toBe(mocks.observedEvents);
	await worker.stop();
});

it("records bounded authorization and Runtime submit timings (#1561)", async () => {
	const telemetry = { record: vi.fn() };
	const worker = createPlatformConversationWorkerV2({
		...options,
		observability: telemetry,
	});
	mocks.authorize.mockResolvedValue({ outcome: "allowed", authority: {} });
	mocks.runtimeDispatch.mockResolvedValue({ schemaVersion: 2 });
	const ids = { conversationId: "conversation-1", executionId: "execution-1" };
	const authorization = mocks.dispatchAuthorization as {
		authorize(input: unknown): Promise<unknown>;
	};
	const runtimeHost = mocks.dispatchRuntimeHost as {
		dispatch(request: unknown): Promise<unknown>;
	};
	await expect(authorization.authorize(ids)).resolves.toEqual({
		outcome: "allowed",
		authority: {},
	});
	await expect(runtimeHost.dispatch(ids)).resolves.toEqual({
		schemaVersion: 2,
	});
	mocks.runtimeDispatch.mockRejectedValueOnce(new Error("submit lost"));
	await expect(runtimeHost.dispatch(ids)).rejects.toThrow("submit lost");
	// #3276：Runtime 返回的稳定错误码进入失败记录，消息不进入。
	const { ConversationRuntimeHostError } = await import(
		"@agent-infra/platform-core"
	);
	mocks.runtimeDispatch.mockRejectedValueOnce(
		new ConversationRuntimeHostError("RUNTIME_CODEX_UNAVAILABLE", true),
	);
	await expect(runtimeHost.dispatch(ids)).rejects.toMatchObject({
		code: "RUNTIME_CODEX_UNAVAILABLE",
	});
	expect(telemetry.record.mock.calls.map(([event]) => event)).toEqual([
		{
			stage: "authorization",
			outcome: "completed",
			durationMs: expect.any(Number),
			operationRef: "drain.authorization",
			...ids,
		},
		{
			stage: "runtime",
			outcome: "completed",
			durationMs: expect.any(Number),
			...ids,
		},
		{
			stage: "runtime",
			outcome: "failed",
			durationMs: expect.any(Number),
			...ids,
		},
		{
			stage: "runtime",
			outcome: "failed",
			durationMs: expect.any(Number),
			protocolCode: "RUNTIME_CODEX_UNAVAILABLE",
			...ids,
		},
	]);
	await worker.stop();
});

describe("conversation dispatch observability", () => {
	it("records one bounded task wait for a returned queue page", async () => {
		mocks.find
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
			]);
		mocks.dispatch.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "accepted",
		});
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			expect(await worker.tick()).toBe(0);
			expect(telemetry.record).not.toHaveBeenCalled();
			expect(await worker.tick()).toBe(1);
			expect(telemetry.record).toHaveBeenCalledWith({
				stage: "task_wait",
				outcome: "completed",
				durationMs: expect.any(Number),
				operationRef: "conversation.queue.find",
			});
			expect(
				telemetry.record.mock.calls.filter(
					([event]) => event.stage === "task_wait",
				),
			).toHaveLength(1);
		} finally {
			await worker.stop();
		}
	});

	it("does not count sandbox maintenance as a task wait", async () => {
		mocks.find.mockResolvedValueOnce([
			{ itemId: "sandbox-a", operation: "conversation.sandbox.reconcile.v1" },
		]);
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			expect(await worker.tick()).toBe(1);
			expect(
				telemetry.record.mock.calls.some(
					([event]) => event.stage === "task_wait",
				),
			).toBe(false);
		} finally {
			await worker.stop();
		}
	});

	it("records a sandbox claim wait once per reason change (#3089)", async () => {
		const sandbox = {
			itemId: "sandbox-a",
			operation: "conversation.sandbox.reconcile.v1",
		};
		mocks.find.mockResolvedValue([sandbox]);
		const waits = [
			"workload_not_ready",
			"workload_not_ready",
			"configuration_pending",
			null,
			"configuration_pending",
		] as const;
		for (const reason of waits)
			mocks.claimSandbox.mockImplementationOnce(
				async (_input: unknown, onWait?: (reason: string) => void) => {
					if (reason === null)
						return { schemaVersion: 1, execution: null } as never;
					onWait?.(reason);
					return null;
				},
			);
		mocks.recordSandbox.mockResolvedValue(undefined);
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			for (const [index, reason] of waits.entries()) {
				expect(await worker.tick()).toBe(1);
				await vi.waitFor(() =>
					expect(mocks.claimSandbox).toHaveBeenCalledTimes(index + 1),
				);
				if (reason === null)
					await vi.waitFor(() =>
						expect(mocks.recordSandbox).toHaveBeenCalled(),
					);
			}
		} finally {
			await worker.stop();
		}
		const events = telemetry.record.mock.calls
			.map(([event]) => event)
			.filter(
				(event) => event.stage === "workload" && event.outcome === "waiting",
			);
		// 同一原因连续出现只记一次；原因变化或认领成功后再次等待都会重新记录。
		expect(events).toEqual(
			[
				"sandbox.workload_not_ready",
				"sandbox.configuration_pending",
				"sandbox.configuration_pending",
			].map((failureStep) => ({
				stage: "workload",
				outcome: "waiting",
				code: "WORKLOAD_UNAVAILABLE",
				failureStep,
				operationRef: "conversation.sandbox.reconcile.v1",
			})),
		);
		expect(JSON.stringify(events)).not.toContain("sandbox-a");
	});

	describe("a Session Sandbox receiver failure (#2733)", () => {
		async function reconcileWith(receiveSandbox: () => Promise<never>) {
			const claim = { schemaVersion: 1, execution: null } as never;
			mocks.find.mockResolvedValueOnce([
				{ itemId: "sandbox-a", operation: "conversation.sandbox.reconcile.v1" },
			]);
			mocks.claimSandbox.mockResolvedValueOnce(claim);
			mocks.recordSandbox.mockResolvedValueOnce(undefined);
			const telemetry = { record: vi.fn() };
			const worker = createPlatformConversationWorkerV2({
				...options,
				receiveSandbox,
				observability: telemetry,
			});
			try {
				expect(await worker.tick()).toBe(1);
				await vi.waitFor(() => expect(mocks.recordSandbox).toHaveBeenCalled());
			} finally {
				await worker.stop();
			}
			// 观测与重试照旧：记为 unknown，由同一个 outbox 条目恢复。
			expect(mocks.recordSandbox).toHaveBeenCalledWith({
				claim,
				observation: { status: "unknown", resources: [] },
			});
			return telemetry.record.mock.calls
				.map(([event]) => event)
				.filter((event) => event.stage === "workload");
		}

		it("records a bounded failure for a Kubernetes workload policy rejection", async () => {
			const events = await reconcileWith(async () => {
				throw new WorkloadKubernetesError("policy");
			});
			expect(events).toEqual([
				{
					stage: "workload",
					outcome: "failed",
					code: "WORKLOAD_RECONCILIATION_FAILED",
					failureStep: "workload.policy",
					errorClass: "WorkloadKubernetesError",
					operationRef: "conversation.sandbox.reconcile.v1",
					durationMs: expect.any(Number),
				},
			]);
		});

		it("records only the class of any other failure, never its message", async () => {
			const events = await reconcileWith(async () => {
				throw new TypeError("sandbox-secret-name must never be logged");
			});
			expect(events).toEqual([
				{
					stage: "workload",
					outcome: "failed",
					code: "WORKLOAD_RECONCILIATION_FAILED",
					errorClass: "TypeError",
					operationRef: "conversation.sandbox.reconcile.v1",
					durationMs: expect.any(Number),
				},
			]);
			expect(JSON.stringify(events)).not.toContain("sandbox-secret-name");
		});

		it("uses a fixed class for non-Error thrown values", async () => {
			const events = await reconcileWith(async () => {
				throw "sandbox-secret-name must never be logged";
			});
			expect(events).toEqual([
				{
					stage: "workload",
					outcome: "failed",
					code: "WORKLOAD_RECONCILIATION_FAILED",
					errorClass: "NonErrorThrown",
					operationRef: "conversation.sandbox.reconcile.v1",
					durationMs: expect.any(Number),
				},
			]);
			expect(JSON.stringify(events)).not.toContain("sandbox-secret-name");
		});

		it("still records the unknown observation when building the telemetry event throws", async () => {
			const claim = { schemaVersion: 1, execution: null } as never;
			mocks.find.mockResolvedValueOnce([
				{ itemId: "sandbox-a", operation: "conversation.sandbox.reconcile.v1" },
			]);
			mocks.claimSandbox.mockResolvedValueOnce(claim);
			mocks.recordSandbox.mockResolvedValueOnce(undefined);
			const worker = createPlatformConversationWorkerV2({
				...options,
				receiveSandbox: async () => {
					// 读取类名本身就抛出：事件构造失败也不能妨碍记录观测。
					const error = new WorkloadKubernetesError("policy");
					Object.defineProperty(error, "constructor", {
						get() {
							throw new Error("hostile constructor");
						},
					});
					throw error;
				},
				observability: { record: vi.fn() },
			});
			try {
				expect(await worker.tick()).toBe(1);
				await vi.waitFor(() => expect(mocks.recordSandbox).toHaveBeenCalled());
			} finally {
				await worker.stop();
			}
			expect(mocks.recordSandbox).toHaveBeenCalledWith({
				claim,
				observation: { status: "unknown", resources: [] },
			});
		});

		it("records nothing when the receiver returns an observation", async () => {
			mocks.find.mockResolvedValueOnce([
				{ itemId: "sandbox-a", operation: "conversation.sandbox.reconcile.v1" },
			]);
			mocks.claimSandbox.mockResolvedValueOnce({
				schemaVersion: 1,
				execution: null,
			} as never);
			mocks.recordSandbox.mockResolvedValueOnce(undefined);
			const telemetry = { record: vi.fn() };
			const worker = createPlatformConversationWorkerV2({
				...options,
				observability: telemetry,
			});
			try {
				expect(await worker.tick()).toBe(1);
				await vi.waitFor(() => expect(mocks.recordSandbox).toHaveBeenCalled());
			} finally {
				await worker.stop();
			}
			expect(telemetry.record).toHaveBeenCalledWith(
				expect.objectContaining({
					stage: "workload",
					outcome: "unknown",
					operationRef: "sandbox.reconcile.prepare",
					durationMs: expect.any(Number),
				}),
			);
		});
	});

	it("records a failed task wait while preserving discovery errors", async () => {
		mocks.find.mockRejectedValueOnce(new Error("synthetic queue failure"));
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			await expect(worker.tick()).rejects.toThrow("synthetic queue failure");
			expect(telemetry.record).toHaveBeenCalledWith({
				stage: "task_wait",
				outcome: "failed",
				code: "TASK_UNAVAILABLE",
				durationMs: expect.any(Number),
				operationRef: "conversation.queue.find",
			});
		} finally {
			await worker.stop();
		}
	});

	it("contains telemetry failures without changing queue dispatch", async () => {
		mocks.find.mockResolvedValueOnce([
			{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
		]);
		mocks.dispatch.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "accepted",
		});
		const telemetry = {
			record: vi.fn(() => {
				throw new Error("sink down");
			}),
		};
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			expect(await worker.tick()).toBe(1);
			await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
		} finally {
			await worker.stop();
		}
	});

	it.each([
		[{ schemaVersion: 1, outcome: "accepted" }, { outcome: "completed" }],
		[
			{ schemaVersion: 1, outcome: "busy", retryScheduled: false },
			{ outcome: "waiting" },
		],
		[
			{ schemaVersion: 1, outcome: "retry", retryScheduled: true },
			{ outcome: "failed", code: "TASK_UNAVAILABLE" },
		],
		[
			{ schemaVersion: 1, outcome: "unknown", retryScheduled: false },
			{ outcome: "unknown" },
		],
		[{ schemaVersion: 1, outcome: "stale" }, { outcome: "rejected" }],
		[
			{ schemaVersion: 1, outcome: "already_completed" },
			{ outcome: "rejected" },
		],
	] as const)("records a bounded %s decision", async (decision, expected) => {
		mocks.find.mockResolvedValue([
			{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
		]);
		mocks.dispatch.mockResolvedValueOnce(decision);
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			expect(await worker.tick()).toBe(1);
			await vi.waitFor(() =>
				expect(telemetry.record).toHaveBeenCalledWith({
					stage: "task_dispatch",
					...expected,
					durationMs: expect.any(Number),
					operationRef: "conversation.turn.submit.v1",
				}),
			);
		} finally {
			await worker.stop();
		}
	});

	it("records thrown dispatch failures without changing the Worker result", async () => {
		mocks.find.mockResolvedValue([
			{ itemId: "turn-a", operation: "conversation.turn.submit.v1" },
		]);
		mocks.dispatch.mockRejectedValueOnce(
			new Error("synthetic dispatch failure"),
		);
		const telemetry = { record: vi.fn() };
		const worker = createPlatformConversationWorkerV2({
			...options,
			observability: telemetry,
		});
		try {
			expect(await worker.tick()).toBe(1);
			await vi.waitFor(() =>
				expect(telemetry.record).toHaveBeenCalledWith({
					stage: "task_dispatch",
					outcome: "failed",
					code: "TASK_UNAVAILABLE",
					durationMs: expect.any(Number),
					operationRef: "conversation.turn.submit.v1",
				}),
			);
		} finally {
			await worker.stop();
		}
	});
});
