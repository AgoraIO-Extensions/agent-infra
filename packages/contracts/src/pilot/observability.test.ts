import { describe, expect, it } from "vitest";
import {
	ObservabilityStatusProjectionV1Schema,
	observabilityOpenApiPathsV1,
} from "./observability.ts";

const operation = observabilityOpenApiPathsV1["/api/v1/ops/observability"].get;
const projection = {
	schemaVersion: 1,
	service: "platform-api",
	enabled: true,
	state: "active",
	captureFailures: 0,
	exportFailures: 2,
	droppedLogs: 1,
	invalidRecords: 0,
	lastExportFailureAt: "2026-10-13T00:00:00.000Z",
};

describe("observability status V1 contract (#3058)", () => {
	it("keeps the existing projection strict and bounded", () => {
		expect(ObservabilityStatusProjectionV1Schema.parse(projection)).toEqual(
			projection,
		);
		const { lastExportFailureAt: _omitted, ...withoutFailure } = projection;
		expect(
			ObservabilityStatusProjectionV1Schema.safeParse(withoutFailure).success,
		).toBe(true);
		for (const invalid of [
			{ ...projection, schemaVersion: 2 },
			{ ...projection, service: "platform-worker" },
			{ ...projection, state: "unknown" },
			{ ...projection, exportFailures: -1 },
			{ ...projection, droppedLogs: 1.5 },
			{ ...projection, lastExportFailureAt: "昨天" },
			{ ...withoutFailure, invalidRecords: undefined },
			// 只报告采集与导出健康，不带出未声明的指标、日志正文或凭证。
			{ ...projection, cpuPercent: 12 },
			{ ...projection, lastError: "PRIVATE_EXPORTER_DETAIL" },
		])
			expect(
				ObservabilityStatusProjectionV1Schema.safeParse(invalid).success,
			).toBe(false);
	});

	it("declares only platform-session access and stable error responses", () => {
		expect(operation.operationId).toBe("getObservabilityStatus");
		expect(operation.security).toEqual([{ PlatformSession: [] }]);
		// 没有请求参数：身份与角色只由服务端按当前会话解析。
		expect(operation).not.toHaveProperty("requestParams");
		// 依赖异常只返回契约内的 503，不声明 500。
		expect(Object.keys(operation.responses)).toEqual([
			"200",
			"401",
			"403",
			"404",
			"503",
		]);
		expect(operation.responses["404"]).not.toHaveProperty("content");
	});
});
