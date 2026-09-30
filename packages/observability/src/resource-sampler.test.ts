import { expect, it, vi } from "vitest";
import {
	type PlatformResourceSamplerOptions,
	startPlatformResourceSampler,
} from "./resource-sampler.js";

function capture(enabled = true) {
	const observeResource = vi.fn();
	const record = vi.fn();
	const telemetry = {
		status: () => ({ enabled }),
		observeResource,
		record,
	} as unknown as PlatformResourceSamplerOptions["telemetry"];
	return { telemetry, observeResource, record };
}

it("samples only authoritative queue and current pool values with fixed kinds", async () => {
	const { telemetry, observeResource, record } = capture();
	const sampler = startPlatformResourceSampler({
		telemetry,
		readQueue: async () => ({ taskWaiting: 2, outboxPending: 3 }),
		readPool: async () => ({ active: 1, idle: 4, waiting: 0 }),
	});
	try {
		await vi.waitFor(() => expect(observeResource).toHaveBeenCalledTimes(5));
		expect(observeResource.mock.calls.map(([snapshot]) => snapshot)).toEqual([
			{ kind: "task_waiting", value: 2 },
			{ kind: "outbox_pending", value: 3 },
			{ kind: "postgres_pool_active", value: 1 },
			{ kind: "postgres_pool_idle", value: 4 },
			{ kind: "postgres_pool_waiting", value: 0 },
		]);
		expect(record).not.toHaveBeenCalled();
	} finally {
		sampler.stop();
	}
});

it("reports unavailable snapshots and never turns missing data into zero", async () => {
	const { telemetry, observeResource, record } = capture();
	let attempts = 0;
	const sampler = startPlatformResourceSampler({
		telemetry,
		intervalMs: 1000,
		readQueue: async () => {
			attempts++;
			if (attempts === 1) throw new Error("private database failure");
			return { taskWaiting: 0, outboxPending: 1 };
		},
	});
	try {
		await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
		expect(observeResource).not.toHaveBeenCalled();
		expect(record).toHaveBeenCalledWith({
			stage: "dependency",
			outcome: "failed",
			code: "DEPENDENCY_UNAVAILABLE",
		});
		await vi.waitFor(() => expect(observeResource).toHaveBeenCalledTimes(2), {
			timeout: 2000,
		});
		expect(observeResource.mock.calls.map(([snapshot]) => snapshot)).toEqual([
			{ kind: "task_waiting", value: 0 },
			{ kind: "outbox_pending", value: 1 },
		]);
	} finally {
		sampler.stop();
	}
});

it("stops a pending read without observing stale values or scheduling another read", async () => {
	const { telemetry, observeResource, record } = capture();
	let signal: AbortSignal | undefined;
	const sampler = startPlatformResourceSampler({
		telemetry,
		readQueue: async (received) => {
			signal = received;
			return new Promise((_, reject) =>
				received.addEventListener("abort", () => reject(new Error("stopped")), {
					once: true,
				}),
			);
		},
	});
	await vi.waitFor(() => expect(signal).toBeDefined());
	sampler.stop();
	expect(signal?.aborted).toBe(true);
	await vi.waitFor(() => expect(observeResource).not.toHaveBeenCalled());
	expect(record).not.toHaveBeenCalled();
});

it("never overlaps a slow resource read with a new polling lap", async () => {
	const { telemetry } = capture();
	const readQueue = vi.fn(
		(signal: AbortSignal) =>
			new Promise<never>((_, reject) =>
				signal.addEventListener("abort", () => reject(new Error("stopped")), {
					once: true,
				}),
			),
	);
	const sampler = startPlatformResourceSampler({
		telemetry,
		intervalMs: 1000,
		readQueue,
	});
	try {
		await vi.waitFor(() => expect(readQueue).toHaveBeenCalledOnce());
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(readQueue).toHaveBeenCalledOnce();
	} finally {
		sampler.stop();
	}
});

it("does not query resources when OTLP metrics are disabled", () => {
	const { telemetry, observeResource } = capture(false);
	const readQueue = vi.fn();
	startPlatformResourceSampler({ telemetry, readQueue }).stop();
	expect(readQueue).not.toHaveBeenCalled();
	expect(observeResource).not.toHaveBeenCalled();
});
