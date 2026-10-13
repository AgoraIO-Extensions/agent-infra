import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOperationsStatus } from "./operations-query.js";

describe("operations query", () => {
	afterEach(() => vi.restoreAllMocks());

	it("maps a healthy projection", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						schemaVersion: 1,
						service: "platform-api",
						enabled: true,
						state: "active",
						captureFailures: 0,
						exportFailures: 0,
						droppedLogs: 0,
						invalidRecords: 0,
					}),
				),
			),
		);
		expect(await fetchOperationsStatus()).toEqual({
			kind: "ready",
			statuses: {
				health: "unknown",
				agents: "unknown",
				delivery: "unknown",
				alerts: "unknown",
			},
		});
	});

	it("keeps backend failure and exporter degradation explicit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
		);
		expect(await fetchOperationsStatus()).toEqual({
			kind: "unavailable",
			message: "观测服务当前不可用。",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						schemaVersion: 1,
						service: "platform-api",
						enabled: true,
						state: "active",
						captureFailures: 0,
						exportFailures: 1,
						droppedLogs: 0,
						invalidRecords: 0,
					}),
				),
			),
		);
		const result = await fetchOperationsStatus();
		expect(result.kind).toBe("ready");
		if (result.kind === "ready")
			expect(result.statuses.alerts).toBe("degraded");
	});
});
