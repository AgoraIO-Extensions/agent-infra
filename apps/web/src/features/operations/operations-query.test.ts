import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOperationsStatus } from "./operations-query.js";

const activeProjection = {
	schemaVersion: 1,
	service: "platform-api",
	enabled: true,
	state: "active",
	captureFailures: 0,
	exportFailures: 0,
	droppedLogs: 0,
	invalidRecords: 0,
};

function respond(response: Response | Promise<Response>) {
	vi.stubGlobal("fetch", vi.fn().mockReturnValue(Promise.resolve(response)));
}

describe("operations query", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("maps a healthy projection", async () => {
		respond(new Response(JSON.stringify(activeProjection)));
		expect(await fetchOperationsStatus()).toEqual({
			kind: "ready",
			statuses: {
				health: "unknown",
				agents: "unknown",
				dependencies: "unknown",
				alerts: "unknown",
			},
			collection: {
				captureFailures: 0,
				exportFailures: 0,
				droppedLogs: 0,
				invalidRecords: 0,
			},
		});
	});

	it("keeps backend failure and exporter degradation explicit", async () => {
		respond(new Response(null, { status: 503 }));
		expect(await fetchOperationsStatus()).toEqual({
			kind: "unavailable",
			message: "观测服务当前不可用。",
		});
		respond(
			new Response(
				JSON.stringify({
					...activeProjection,
					exportFailures: 1,
					lastExportFailureAt: "2026-10-13T00:00:00.000Z",
				}),
			),
		);
		const result = await fetchOperationsStatus();
		expect(result.kind).toBe("ready");
		if (result.kind === "ready") {
			expect(result.statuses.alerts).toBe("degraded");
			// 计数与时间原样来自正式查询，其余三块仍是未接入。
			expect(result.collection).toEqual({
				captureFailures: 0,
				exportFailures: 1,
				droppedLogs: 0,
				invalidRecords: 0,
				lastExportFailureAt: "2026-10-13T00:00:00.000Z",
			});
			expect([
				result.statuses.health,
				result.statuses.agents,
				result.statuses.dependencies,
			]).toEqual(["unknown", "unknown", "unknown"]);
		}
	});

	it("maps server denial and a missing query entry to their own states", async () => {
		respond(new Response(null, { status: 403 }));
		expect(await fetchOperationsStatus()).toEqual({ kind: "denied" });
		respond(new Response(null, { status: 404 }));
		expect(await fetchOperationsStatus()).toEqual({ kind: "not-connected" });
	});

	it("treats network, other failures, inactive collection and invalid projections as unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("network down")),
		);
		expect(await fetchOperationsStatus()).toEqual({
			kind: "unavailable",
			message: "观测服务当前不可用。",
		});
		respond(new Response(null, { status: 500 }));
		expect(await fetchOperationsStatus()).toEqual({
			kind: "unavailable",
			message: "暂时无法读取观测状态，请稍后重试。",
		});
		for (const inactive of [
			{ ...activeProjection, enabled: false },
			{ ...activeProjection, state: "closing" },
		]) {
			respond(new Response(JSON.stringify(inactive)));
			expect(await fetchOperationsStatus()).toEqual({
				kind: "unavailable",
				message: "观测服务当前不可用。",
			});
		}
		for (const body of [
			"not json",
			JSON.stringify({ ...activeProjection, exportFailures: -1 }),
			JSON.stringify({ ...activeProjection, lastExportFailureAt: "昨天" }),
			// strict 契约：多出的字段同样拒绝，不把未知数据显示为事实。
			JSON.stringify({ ...activeProjection, cpuPercent: 12 }),
		]) {
			respond(new Response(body));
			expect(await fetchOperationsStatus()).toEqual({
				kind: "unavailable",
				message: "观测状态响应无法识别，请稍后重试。",
			});
		}
	});
});
