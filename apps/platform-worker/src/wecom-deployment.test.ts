import { afterEach, expect, it, vi } from "vitest";
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

it("fails closed for a bot deployment without authenticated connection inputs", async () => {
	const coordinator = createWecomDeploymentCoordinatorV1({
		databaseUrl: "postgres://fixture",
		configuration: {
			mode: "bot",
			identity: {
				resolveSender: async () => null,
				activeUsers: async () => [],
			},
			observe: () => {},
			sender: { send: async () => "failed" },
		},
	});
	const signal = new AbortController().signal;
	expect(() => coordinator.start(signal)).toThrow(
		"WeCom Worker deployment dependencies are unavailable",
	);
	const record = {
		boundary: { channelId: "wecom_bot:pending" },
	} as Parameters<typeof coordinator.channelAuthorizationCurrent>[0];
	expect(await coordinator.channelAuthorizationCurrent(record, signal)).toBe(
		false,
	);
});
