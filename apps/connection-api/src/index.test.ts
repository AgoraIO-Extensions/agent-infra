import { afterEach, describe, expect, it, vi } from "vitest";

import { startConnectionApi } from "./index";

describe("connection-api recovery lifecycle", () => {
	afterEach(() => vi.useRealTimers());

	it("runs one bounded recovery job per interval and stops with the server", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const server = startConnectionApi({
			app: { fetch: () => new Response("ok") },
			log: () => undefined,
			port: 0,
			recovery: {
				runOnce: async () => {
					attempts += 1;
					return true;
				},
			},
			recoveryIntervalMs: 100,
		});

		await vi.advanceTimersByTimeAsync(300);
		expect(attempts).toBe(3);
		server.close();
		await vi.advanceTimersByTimeAsync(300);
		expect(attempts).toBe(3);
	});

	it("does not overlap slow recovery attempts", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		let finish: (() => void) | undefined;
		const server = startConnectionApi({
			app: { fetch: () => new Response("ok") },
			log: () => undefined,
			port: 0,
			recovery: {
				runOnce: () => {
					attempts += 1;
					return new Promise<boolean>((resolve) => {
						finish = () => resolve(true);
					});
				},
			},
			recoveryIntervalMs: 100,
		});

		await vi.advanceTimersByTimeAsync(300);
		expect(attempts).toBe(1);
		finish?.();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(100);
		expect(attempts).toBe(2);
		server.close();
	});

	it("runs approval expiry maintenance sequentially and stops with the server", async () => {
		vi.useFakeTimers();
		const calls: string[] = [];
		let finish: (() => void) | undefined;
		const server = startConnectionApi({
			app: { fetch: () => new Response("ok") },
			approvalMaintenance: {
				expireDueAuthorizations: () => {
					calls.push("authorization");
					return new Promise<number>((resolve) => {
						finish = () => resolve(1);
					});
				},
				expireDueRequests: async () => {
					calls.push("request");
					return 1;
				},
			},
			approvalMaintenanceIntervalMs: 100,
			log: () => undefined,
			port: 0,
		});
		await vi.advanceTimersByTimeAsync(300);
		expect(calls).toEqual(["authorization"]);
		finish?.();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(100);
		expect(calls).toEqual(["authorization", "request", "authorization"]);
		server.close();
		finish?.();
		await vi.advanceTimersByTimeAsync(200);
		expect(calls).toEqual([
			"authorization",
			"request",
			"authorization",
			"request",
		]);
	});

	it("runs a bounded notification dispatcher independently of recovery", async () => {
		vi.useFakeTimers();
		let deliveries = 0;
		const server = startConnectionApi({
			app: { fetch: () => new Response("ok") },
			log: () => undefined,
			notificationDispatcher: {
				runOnce: async () => {
					deliveries++;
					return true;
				},
			},
			notificationDispatchIntervalMs: 100,
			port: 0,
		});
		await vi.advanceTimersByTimeAsync(300);
		expect(deliveries).toBe(3);
		server.close();
		await vi.advanceTimersByTimeAsync(200);
		expect(deliveries).toBe(3);
	});
});
