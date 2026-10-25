import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWecomDeploymentCoordinatorV1,
	startPlatformWecomPollingWorkerV1,
	startPlatformWecomWorkerFromDeploymentV1,
} from "./wecom-deployment.js";

afterEach(() => {
	vi.useRealTimers();
});

it("runs delivery while connection reconciliation is pending and drains before close", async () => {
	vi.useFakeTimers();
	const reconciliation = Promise.withResolvers<void>();
	const worker = {
		reconcile: vi.fn(() => reconciliation.promise),
		dispatch: vi.fn(async () => false),
		close: vi.fn(async () => {}),
	};
	const running = startPlatformWecomPollingWorkerV1(worker, {
		intervalMs: 1_000,
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(worker.reconcile).toHaveBeenCalledOnce();
	expect(worker.dispatch).toHaveBeenCalledOnce();
	const stopping = running.stop();
	expect(worker.close).not.toHaveBeenCalled();
	reconciliation.resolve();
	await stopping;
	expect(worker.close).toHaveBeenCalledOnce();
	expect(running.stop()).toBe(stopping);
	expect(vi.getTimerCount()).toBe(0);
});

it("retries failed channel polls with diagnostic codes only", async () => {
	vi.useFakeTimers();
	const log = vi.fn();
	const worker = {
		reconcile: vi
			.fn()
			.mockRejectedValueOnce(new Error("private configuration"))
			.mockResolvedValue(undefined),
		dispatch: vi
			.fn()
			.mockRejectedValueOnce(new Error("message body"))
			.mockResolvedValue(false),
		close: vi.fn(async () => {}),
	};
	const running = startPlatformWecomPollingWorkerV1(worker, {
		intervalMs: 100,
		log,
	});
	await vi.advanceTimersByTimeAsync(100);
	expect(worker.reconcile).toHaveBeenCalledTimes(2);
	expect(worker.dispatch).toHaveBeenCalledTimes(2);
	expect(log.mock.calls.map(([code]) => code)).toEqual([
		"WECOM_RECONCILE_UNAVAILABLE",
		"WECOM_DELIVERY_UNAVAILABLE",
	]);
	await running.stop();
});

it("refreshes streaming progress on its own loop so a slow reply cannot stall it (#3377)", async () => {
	vi.useFakeTimers();
	const log = vi.fn();
	const slow = Promise.withResolvers<boolean>();
	const worker = {
		reconcile: vi.fn(async () => {}),
		dispatch: vi.fn(() => slow.promise),
		progress: vi
			.fn()
			.mockRejectedValueOnce(new Error("message body"))
			.mockResolvedValue(1),
		close: vi.fn(async () => {}),
	};
	const running = startPlatformWecomPollingWorkerV1(worker, {
		intervalMs: 100,
		log,
	});
	await vi.advanceTimersByTimeAsync(350);
	// 终态回复仍在进行，进度照常每轮刷新；失败只记固定诊断码。
	expect(worker.dispatch).toHaveBeenCalledOnce();
	expect(worker.progress.mock.calls.length).toBeGreaterThanOrEqual(3);
	expect(log.mock.calls.map(([code]) => code)).toEqual([
		"WECOM_PROGRESS_UNAVAILABLE",
	]);
	const stopping = running.stop();
	slow.resolve(false);
	await stopping;
	expect(worker.close).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("rejects missing deployment factories without exposing imported errors", async () => {
	await expect(
		startPlatformWecomWorkerFromDeploymentV1(
			"data:text/javascript,export const unrelated = true",
		),
	).rejects.toThrow("WeCom Worker deployment dependencies are unavailable");
	await expect(
		startPlatformWecomWorkerFromDeploymentV1(
			"data:text/javascript,export function createPlatformWecomWorkerInstanceV1() { return {}; }",
		),
	).rejects.toThrow("WeCom Worker deployment dependencies are unavailable");
});

it("uses structured redacted default diagnostics and keeps polling if logging fails", async () => {
	vi.useFakeTimers();
	const output = vi
		.spyOn(console, "info")
		.mockImplementationOnce(() => {
			throw new Error("log sink unavailable");
		})
		.mockImplementation(() => {});
	const worker = {
		reconcile: vi
			.fn()
			.mockRejectedValueOnce(new Error("private configuration"))
			.mockResolvedValue(undefined),
		dispatch: vi
			.fn()
			.mockRejectedValueOnce(new Error("message body"))
			.mockResolvedValue(false),
		close: vi.fn(async () => {}),
	};
	const running = startPlatformWecomPollingWorkerV1(worker, {
		intervalMs: 100,
	});
	try {
		await vi.advanceTimersByTimeAsync(100);
		expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
			{
				service: "platform-worker",
				status: "dependency_unavailable",
				code: "WECOM_RECONCILE_UNAVAILABLE",
			},
			{
				service: "platform-worker",
				status: "dependency_unavailable",
				code: "WECOM_DELIVERY_UNAVAILABLE",
			},
		]);
		expect(worker.reconcile).toHaveBeenCalledTimes(2);
		expect(worker.dispatch).toHaveBeenCalledTimes(2);
	} finally {
		await running.stop();
		output.mockRestore();
	}
});

it("closes resources returned by a malformed deployment factory", async () => {
	const closed = vi.fn();
	vi.stubGlobal("wecomDeploymentClosed", closed);
	try {
		await expect(
			startPlatformWecomWorkerFromDeploymentV1(
				"data:text/javascript,export function createPlatformWecomWorkerInstanceV1() { return { reconcile: async () => {}, close: async () => globalThis.wecomDeploymentClosed() }; }",
			),
		).rejects.toThrow("WeCom Worker deployment dependencies are unavailable");
		expect(closed).toHaveBeenCalledOnce();
	} finally {
		vi.unstubAllGlobals();
	}
});

it("loads a deployment worker and closes it through the process lifecycle", async () => {
	const closed = vi.fn();
	vi.stubGlobal("wecomDeploymentClosed", closed);
	try {
		const running = await startPlatformWecomWorkerFromDeploymentV1(
			"data:text/javascript,export function createPlatformWecomWorkerInstanceV1() { return { reconcile: async () => {}, dispatch: async () => false, close: async () => globalThis.wecomDeploymentClosed() }; }",
		);
		await running.stop();
		expect(closed).toHaveBeenCalledOnce();
	} finally {
		vi.unstubAllGlobals();
	}
});

it.each(["connections", "setup"])(
	"fails closed without %s required for Owner candidate activation",
	async (missing) => {
		const coordinator = createWecomDeploymentCoordinatorV1({
			databaseUrl: "postgres://fixture",
			configuration: {
				identity: {
					resolveSender: async () => null,
					activeUsers: async () => [],
				},
				observe: () => {},
				sender: { send: async () => "failed" },
				...(missing === "connections"
					? {}
					: {
							connections: {
								bindings: async () => [],
								protectReply: async () => "fixture",
								revealReply: async () => null,
							},
						}),
				...(missing === "setup"
					? {}
					: {
							setup: {
								decryptor: { decrypt: async () => null },
								directory: { resolveUser: async () => null },
							},
						}),
			},
		});
		const signal = new AbortController().signal;
		expect(() => coordinator.start(signal)).toThrow(
			"WeCom Worker deployment dependencies are unavailable",
		);
		const record = {
			boundary: {
				channelId: "wecom_bot:pending",
				principal: { kind: "user", id: "user" },
			},
		} as Parameters<typeof coordinator.channelAuthorizationCurrent>[0];
		expect(await coordinator.channelAuthorizationCurrent(record, signal)).toBe(
			false,
		);
	},
);

describe("channel authority for the deployed Worker (#2469)", () => {
	const signal = new AbortController().signal;
	// 没有启动 WeCom Worker 的装配，等同于未配置 WeCom 的部署。
	const coordinator = createWecomDeploymentCoordinatorV1({
		databaseUrl: "postgres://fixture",
		configuration: {},
	});
	const recordFor = (
		channelId: string,
		principal: { kind: "user" | "application"; id: string },
	) =>
		({
			boundary: { channelId, principal, agentId: "agent" },
		}) as unknown as Parameters<
			typeof coordinator.channelAuthorizationCurrent
		>[0];

	it.each([
		["api", { kind: "user", id: "user" }],
		["api:user", { kind: "user", id: "user" }],
		["api:application", { kind: "application", id: "application" }],
	] as const)(
		"does not veto the Platform API channel %s without WeCom",
		async (channelId, principal) => {
			expect(
				await coordinator.channelAuthorizationCurrent(
					recordFor(channelId, principal),
					signal,
				),
			).toBe(true);
		},
	);

	it.each([
		// 渠道和主体类型对不上的 API 渠道不是 Platform API 渠道。
		["api:application", { kind: "user", id: "user" }],
		["api:user", { kind: "application", id: "application" }],
		["api:other", { kind: "user", id: "user" }],
		["eval", { kind: "user", id: "user" }],
		["wecom", { kind: "user", id: "user" }],
		["wecom_bot:pending", { kind: "user", id: "user" }],
		["wecom_app:pending", { kind: "user", id: "user" }],
		["", { kind: "user", id: "user" }],
	] as const)(
		"keeps %s fail-closed when no WeCom Worker can vouch for it",
		async (channelId, principal) => {
			expect(
				await coordinator.channelAuthorizationCurrent(
					recordFor(channelId, principal),
					signal,
				),
			).toBe(false);
		},
	);

	it("still evaluates the platform channel for web instead of short-circuiting", async () => {
		// 缺少 Workload 的 web 记录由平台渠道检查判为不可用，说明 web 没有走 API 分支。
		await expect(
			coordinator.channelAuthorizationCurrent(
				recordFor("web", { kind: "user", id: "user" }),
				signal,
			),
		).rejects.toMatchObject({ code: "CHANNEL_AUTHORIZATION_UNAVAILABLE" });
	});
});
