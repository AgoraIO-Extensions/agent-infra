import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplicationCredentialProcessDeliveryV1 } from "./application-api-credential-routes.js";

const attempt = {
	applicationId: "app-1",
	credentialId: "credential-1",
	attemptId: "attempt-1",
	recipient: { principalType: "user" as const, principalId: "recipient" },
	expiresAt: "2026-10-04T00:00:30Z",
};
afterEach(() => vi.useRealTimers());
describe("actual in-process delivery adapter fencing", () => {
	function setup() {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
		let acceptCount = 0;
		const port = createApplicationCredentialProcessDeliveryV1({
			principalType: "user",
			principalId: "recipient",
			accept: () => {
				acceptCount++;
				return true;
			},
		});
		return {
			port,
			count: () => acceptCount,
			signal: new AbortController().signal,
		};
	}
	it("accepts once and destroys the prepared copy", async () => {
		const { port, count, signal } = setup();
		await port.prepare(attempt, "controlled-test-material", signal);
		expect(await port.commit(attempt, signal)).toBe("accepted");
		await expect(port.commit(attempt, signal)).rejects.toThrow(
			"Delivery unavailable",
		);
		expect(count()).toBe(1);
	});
	it("rejects different typed recipient even when bare ID matches", async () => {
		const { port, count, signal } = setup();
		await expect(
			port.prepare(
				{
					...attempt,
					recipient: { principalType: "application", principalId: "recipient" },
				},
				"controlled-test-material",
				signal,
			),
		).rejects.toThrow("Delivery unavailable");
		expect(count()).toBe(0);
	});
	it("rejects changed attempt binding and discards its material", async () => {
		const { port, count, signal } = setup();
		await port.prepare(attempt, "controlled-test-material", signal);
		await expect(
			port.commit({ ...attempt, applicationId: "other" }, signal),
		).rejects.toThrow("Delivery unavailable");
		await expect(port.commit(attempt, signal)).rejects.toThrow(
			"Delivery unavailable",
		);
		expect(count()).toBe(0);
	});
	it("fences deadline expiry and explicit abort at actual acceptance", async () => {
		const { port, count, signal } = setup();
		await port.prepare(attempt, "controlled-test-material", signal);
		await vi.advanceTimersByTimeAsync(30_000);
		await expect(port.commit(attempt, signal)).rejects.toThrow(
			"Delivery unavailable",
		);
		const next = {
			...attempt,
			attemptId: "next",
			expiresAt: "2026-10-04T00:01:00Z",
		};
		await port.prepare(next, "controlled-test-material", signal);
		port.abort(next);
		await expect(port.commit(next, signal)).rejects.toThrow(
			"Delivery unavailable",
		);
		expect(count()).toBe(0);
	});
	it("rejects an aborted signal even before the deadline", async () => {
		const { port, count, signal } = setup();
		await port.prepare(attempt, "controlled-test-material", signal);
		const controller = new AbortController();
		controller.abort();
		await expect(port.commit(attempt, controller.signal)).rejects.toThrow();
		port.abort(attempt);
		expect(count()).toBe(0);
	});
});
