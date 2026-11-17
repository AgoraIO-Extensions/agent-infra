import type { OperationsResourcesV2 } from "@agent-infra/contracts/pilot";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithAgentRouter } from "../agent-discovery/test-router.js";
import { ResourceDashboard } from "./resource-dashboard.js";

const missing = {
	cpuCores: null,
	memoryBytes: null,
	storageBytes: null,
	ephemeralStorageBytes: null,
};
const data: OperationsResourcesV2 = {
	schemaVersion: 2,
	scope: { clusterId: "cluster-1", namespace: "platform-1" },
	generatedAt: "2026-11-17T08:00:00Z",
	refreshSeconds: 30,
	sources: [
		{
			kind: "pod-metrics",
			state: "available",
			observedAt: "2026-11-17T08:00:00Z",
			windowSeconds: 30,
			reason: null,
		},
		{
			kind: "image-cache",
			state: "unavailable",
			observedAt: null,
			windowSeconds: null,
			reason: "QUERY_FAILED",
		},
	],
	nodes: [],
	resources: [],
	quotas: [],
	budget: null,
	imageCaches: [],
	cacheEvidence: [],
	events: [],
	alerts: [],
	agents: [
		{
			agentId: "agent-1",
			name: "分析助手",
			sessions: 1,
			pods: 1,
			volumes: 1,
			usage: { ...missing, cpuCores: 0 },
			requests: { ...missing, cpuCores: 1 },
			limits: { ...missing, cpuCores: 2 },
		},
	],
	database: null,
	queue: { waiting: 0, outboxPending: 0, oldestWaitingAt: null },
	retention: {
		target: {
			detailDays: 7,
			aggregateDays: 30,
			aggregateStepSeconds: 300,
			logDays: 7,
			traceDays: 7,
		},
		effective: null,
		configured: {
			detailDays: 5,
			aggregateDays: 20,
			aggregateStepSeconds: 300,
			logDays: null,
			traceDays: null,
		},
	},
	errorRates: [
		{
			stage: "http",
			ratio: 0.3,
			observedAt: "2026-11-17T08:00:00Z",
			windowSeconds: 300,
		},
		{ stage: "model", ratio: null, observedAt: null, windowSeconds: 300 },
	],
	links: [],
	truncated: false,
};

describe("resource dashboard", () => {
	it("keeps Agent observations visible when ImageCache is unavailable and distinguishes zero from unknown", async () => {
		const onSelectAgent = vi.fn();
		await renderWithAgentRouter(
			<ResourceDashboard
				data={data}
				refreshing={false}
				onRefresh={() => undefined}
				onSelectAgent={onSelectAgent}
				agentId=""
				sessionId=""
				onSelectSession={() => undefined}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "资源与运行状态" }),
		).toBeTruthy();
		expect(screen.getByText("0 核")).toBeTruthy();
		expect(screen.getByText("30.0%")).toBeTruthy();
		expect(screen.getByText("无有效采样")).toBeTruthy();
		expect(screen.getByText(/部署声明：细粒度 5 天/)).toBeTruthy();
		expect(screen.getByText(/声明不代表后端已验证/)).toBeTruthy();
		expect(screen.getAllByText("未知").length).toBeGreaterThan(0);
		fireEvent.click(screen.getByRole("button", { name: "分析助手" }));
		expect(onSelectAgent).toHaveBeenCalledWith("agent-1");
		expect(screen.getAllByText(/镜像缓存/).length).toBeGreaterThan(0);
		expect(screen.getAllByText("暂不可用").length).toBeGreaterThan(0);
	});
});
