import { PassThrough } from "node:stream";
import { startObservability } from "@agent-infra/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPlatformResourceSampling } from "./resource-sampler.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function observer() {
	const output = new PassThrough();
	let logs = "";
	output.on("data", (chunk) => {
		logs += String(chunk);
	});
	const telemetry = startObservability({ service: "platform-api", output });
	const observe = vi.spyOn(telemetry, "observeResource");
	return { telemetry, observe, logs: () => logs };
}

describe("Platform API resource sampling lifecycle", () => {
	it("samples automatically without overlapping a slow read and stops while idle", async () => {
		const { telemetry, observe } = observer();
		let complete: (value: {
			taskWaiting: number;
			outboxPending: number;
		}) => void = () => {};
		const read = vi.fn(
			() =>
				new Promise<{ taskWaiting: number; outboxPending: number }>(
					(resolve) => {
						complete = resolve;
					},
				),
		);
		const sampling = startPlatformResourceSampling(read, telemetry, 1000);
		expect(read).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1500);
		expect(read).toHaveBeenCalledOnce();
		complete({ taskWaiting: 3, outboxPending: 7 });
		await vi.advanceTimersByTimeAsync(0);
		expect(observe.mock.calls).toEqual([
			[{ kind: "task_waiting", value: 3 }],
			[{ kind: "outbox_pending", value: 7 }],
		]);
		await sampling.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledOnce();
		await telemetry.close();
	});

	it("records redacted read failures and invalid counts without zero or partial snapshots", async () => {
		const { telemetry, observe, logs } = observer();
		const read = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("postgres://secret sentinel body cursor credential"),
			)
			.mockResolvedValueOnce({ taskWaiting: 3, outboxPending: Number.NaN })
			.mockResolvedValue({ taskWaiting: 2, outboxPending: 4 });
		const sampling = startPlatformResourceSampling(read, telemetry, 1000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(observe).not.toHaveBeenCalled();
		expect(logs()).toContain('"code":"DEPENDENCY_UNAVAILABLE"');
		expect(logs()).not.toMatch(
			/secret|sentinel|body|cursor|credential|postgres/,
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(observe.mock.calls).toEqual([
			[{ kind: "task_waiting", value: 2 }],
			[{ kind: "outbox_pending", value: 4 }],
		]);
		await sampling.stop();
		await telemetry.close();
	});

	it("rejects missing snapshots without partial values and recovers on the next complete read", async () => {
		const { telemetry, observe, logs } = observer();
		const read = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({ taskWaiting: 3 })
			.mockResolvedValue({ taskWaiting: 2, outboxPending: 4 });
		const sampling = startPlatformResourceSampling(read, telemetry, 1000);
		try {
			await vi.advanceTimersByTimeAsync(1000);
			expect(read).toHaveBeenCalledTimes(2);
			expect(observe).not.toHaveBeenCalled();
			expect(logs()).toContain('"code":"DEPENDENCY_UNAVAILABLE"');
			await vi.advanceTimersByTimeAsync(1000);
			expect(read).toHaveBeenCalledTimes(3);
			expect(observe.mock.calls).toEqual([
				[{ kind: "task_waiting", value: 2 }],
				[{ kind: "outbox_pending", value: 4 }],
			]);
		} finally {
			await sampling.stop();
			await telemetry.close();
		}
	});

	it("aborts a timed out read and rejects its late sample without overlapping", async () => {
		const { telemetry, observe } = observer();
		let signal: AbortSignal | undefined;
		let complete: (value: {
			taskWaiting: number;
			outboxPending: number;
		}) => void = () => {};
		const read = vi.fn((input: AbortSignal) => {
			signal = input;
			return new Promise<{ taskWaiting: number; outboxPending: number }>(
				(resolve) => {
					complete = resolve;
				},
			);
		});
		const sampling = startPlatformResourceSampling(read, telemetry, 1000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(signal?.aborted).toBe(true);
		expect(read).toHaveBeenCalledOnce();
		complete({ taskWaiting: 0, outboxPending: 0 });
		await vi.advanceTimersByTimeAsync(0);
		expect(observe).not.toHaveBeenCalled();
		await sampling.stop();
		await telemetry.close();
	});

	it("stops idempotently, aborts a hung read within the bound and discards its tail", async () => {
		const { telemetry, observe } = observer();
		let signal: AbortSignal | undefined;
		let complete: (value: {
			taskWaiting: number;
			outboxPending: number;
		}) => void = () => {};
		const read = vi.fn((input: AbortSignal) => {
			signal = input;
			return new Promise<{ taskWaiting: number; outboxPending: number }>(
				(resolve) => {
					complete = resolve;
				},
			);
		});
		const sampling = startPlatformResourceSampling(read, telemetry, 1000);
		const stopped = sampling.stop();
		expect(sampling.stop()).toBe(stopped);
		expect(signal?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(2000);
		await stopped;
		complete({ taskWaiting: 99, outboxPending: 99 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(read).toHaveBeenCalledOnce();
		expect(observe).not.toHaveBeenCalled();
		await telemetry.close();
	});

	it("contains telemetry capture exceptions and permits a fresh sampler after restart", async () => {
		const { telemetry, observe } = observer();
		observe.mockImplementationOnce(() => {
			throw new Error("private exporter failure");
		});
		const read = vi
			.fn()
			.mockResolvedValue({ taskWaiting: 1, outboxPending: 2 });
		const first = startPlatformResourceSampling(read, telemetry, 1000);
		await vi.advanceTimersByTimeAsync(0);
		await first.stop();
		observe.mockClear();
		const next = startPlatformResourceSampling(read, telemetry, 1000);
		await vi.advanceTimersByTimeAsync(0);
		expect(observe.mock.calls).toEqual([
			[{ kind: "task_waiting", value: 1 }],
			[{ kind: "outbox_pending", value: 2 }],
		]);
		await next.stop();
		await telemetry.close();
	});
});
