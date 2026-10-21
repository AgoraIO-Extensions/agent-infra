import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as generatedClient } from "../../pilot/generated/client.gen.js";
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
	const fetch = vi.fn().mockReturnValue(Promise.resolve(response));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

/** 契约声明 application/json；生成 Client 按 Content-Type 解析正文。 */
function json(body: string) {
	return new Response(body, {
		headers: { "content-type": "application/json" },
	});
}

describe("operations query", () => {
	// 生成 Client 默认使用相对地址；jsdom 下的 Request 需要绝对地址。
	beforeEach(() => {
		generatedClient.setConfig({ baseUrl: "https://platform.test" });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("reads only through the generated V1 client (#3058)", async () => {
		const fetch = respond(Response.json(activeProjection));
		await fetchOperationsStatus();
		expect(fetch).toHaveBeenCalledTimes(1);
		const [request] = fetch.mock.calls[0] as [Request];
		expect(request).toBeInstanceOf(Request);
		expect(request.method).toBe("GET");
		const url = new URL(request.url);
		expect(url.pathname).toBe("/api/v1/ops/observability");
		// 身份与角色只由服务端按会话解析：请求不带查询参数或正文。
		expect(url.search).toBe("");
		expect(request.body).toBeNull();
	});

	it("maps a healthy projection", async () => {
		respond(Response.json(activeProjection));
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
			Response.json({
				...activeProjection,
				exportFailures: 1,
				lastExportFailureAt: "2026-10-13T00:00:00.000Z",
			}),
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

	it("maps the contract error bodies by status (#3058)", async () => {
		const error = (code: string, retryable: boolean) => ({
			schemaVersion: 1,
			code,
			message: "Controlled observability error",
			retryable,
			traceId: "trace-ops-query",
		});
		// 非系统管理员与停用账号都是 403，页面一律显示无权限卡。
		for (const code of ["RESOURCE_UNAVAILABLE", "AUTHORIZATION_REVOKED"]) {
			respond(Response.json(error(code, false), { status: 403 }));
			expect(await fetchOperationsStatus()).toEqual({ kind: "denied" });
		}
		// 观测未装配：契约 503，页面为不可用并可重试。
		respond(
			Response.json(error("DEPENDENCY_UNAVAILABLE", true), { status: 503 }),
		);
		expect(await fetchOperationsStatus()).toEqual({
			kind: "unavailable",
			message: "观测服务当前不可用。",
		});
		// 部署没有提供查询：404 没有协议正文，仍是未接入。
		respond(new Response("404 Not Found", { status: 404 }));
		expect(await fetchOperationsStatus()).toEqual({ kind: "not-connected" });
		// 会话失效：契约 401，按其他失败状态处理，不显示观测事实。
		respond(
			Response.json(error("AUTHENTICATION_REQUIRED", false), { status: 401 }),
		);
		expect(await fetchOperationsStatus()).toEqual({
			kind: "unavailable",
			message: "暂时无法读取观测状态，请稍后重试。",
		});
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
			respond(Response.json(inactive));
			expect(await fetchOperationsStatus()).toEqual({
				kind: "unavailable",
				message: "观测服务当前不可用。",
			});
		}
		for (const response of [
			json("not json"),
			// 不是契约声明的 application/json，同样不当作观测事实。
			new Response(JSON.stringify(activeProjection), {
				headers: { "content-type": "text/plain" },
			}),
			Response.json({ ...activeProjection, exportFailures: -1 }),
			Response.json({ ...activeProjection, lastExportFailureAt: "昨天" }),
			// strict 契约：多出的字段同样拒绝，不把未知数据显示为事实。
			Response.json({ ...activeProjection, cpuPercent: 12 }),
		]) {
			respond(response);
			expect(await fetchOperationsStatus()).toEqual({
				kind: "unavailable",
				message: "观测状态响应无法识别，请稍后重试。",
			});
		}
	});
});
