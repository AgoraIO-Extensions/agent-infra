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
});
