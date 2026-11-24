import {
	type OperationsResourcesV2,
	OperationsResourcesV2Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";
import { recordApiRequests } from "./generated-client-paths";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

const resourcePath = "/api/v2/ops/resources";
const empty = {
	cpuCores: null,
	memoryBytes: null,
	storageBytes: null,
	ephemeralStorageBytes: null,
};
function sample(): OperationsResourcesV2 {
	const now = new Date().toISOString();
	return OperationsResourcesV2Schema.parse({
		schemaVersion: 2,
		scope: { clusterId: "cluster-fixture", namespace: "platform-fixture" },
		generatedAt: now,
		refreshSeconds: 30,
		sources: [
			{
				kind: "platform",
				state: "available",
				observedAt: now,
				windowSeconds: null,
				reason: null,
			},
			{
				kind: "pod-metrics",
				state: "available",
				observedAt: now,
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
			{
				kind: "prometheus",
				state: "available",
				observedAt: now,
				windowSeconds: 30,
				reason: null,
			},
		],
		nodes: [
			{
				uid: "node-uid",
				name: "worker-node",
				virtual: false,
				ready: true,
				pressures: [],
				observedAt: now,
				capacity: { ...empty, cpuCores: 4, memoryBytes: 8589934592 },
				allocatable: { ...empty, cpuCores: 4, memoryBytes: 8589934592 },
				usage: { ...empty, cpuCores: 1, memoryBytes: 8246337208 },
				requests: empty,
			},
		],
		resources: [
			{
				kind: "Pod",
				uid: "pod-uid",
				name: "sandbox-fixture",
				namespace: "platform-fixture",
				resourceVersion: "1",
				ownerUid: null,
				ownerGeneration: null,
				agentId: "agent-fixture",
				agentName: "分析助手",
				sessionId: "session-fixture",
				sandboxId: "sandbox-fixture",
				generation: 1,
				revision: 1,
				resourceFence: 1,
				ownership: "agent",
				role: "sandbox",
				nodeName: "worker-node",
				phase: "Running",
				ready: true,
				restarts: 0,
				reason: null,
				observedAt: now,
				usage: { ...empty, cpuCores: 0, memoryBytes: 1048576 },
				requests: { ...empty, cpuCores: 0.5, memoryBytes: 268435456 },
				limits: { ...empty, cpuCores: 1, memoryBytes: 536870912 },
				containers: [],
				images: [],
				retainedStorage: false,
			},
		],
		agents: [
			{
				agentId: "agent-fixture",
				name: "分析助手",
				sessions: 1,
				pods: 1,
				volumes: 0,
				usage: { ...empty, cpuCores: 0, memoryBytes: 1048576 },
				requests: empty,
				limits: empty,
			},
		],
		quotas: [],
		budget: null,
		imageCaches: [],
		cacheEvidence: [
			{
				podUid: "pod-uid",
				podName: "sandbox-fixture",
				images: [],
				cacheId: null,
				coverage: "unknown",
				hit: "unknown",
				observedAt: now,
			},
		],
		events: [],
		alerts: [
			{
				id: "MEMORY_PRESSURE:node-uid",
				objectUid: "node-uid",
				objectName: "worker-node",
				code: "MEMORY_PRESSURE",
				severity: "critical",
				state: "firing",
				firstAt: now,
				lastAt: now,
				resolvedAt: null,
				value: 0.96,
				threshold: 0.9,
			},
		],
		queue: { waiting: 0, outboxPending: 0 },
		retention: {
			target: {
				detailDays: 7,
				aggregateDays: 30,
				aggregateStepSeconds: 300,
				logDays: 7,
				traceDays: 7,
			},
			effective: null,
		},
		links: [
			{
				kind: "logs",
				url: "https://observability.example.test/logs?namespace=platform-fixture",
			},
		],
		truncated: false,
	});
}
async function fixture(page: Page, admin = true) {
	let status = 200;
	let historyStatus = 200;
	let body: unknown = sample();
	const requests: string[] = [];
	const generated = recordApiRequests(page);
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		requests.push(`${route.request().method()} ${url.pathname}`);
		if (url.pathname === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "ops-browser",
						displayName: "运维验收账号",
						roles: admin ? ["employee", "system_admin"] : ["employee"],
					},
				},
			});
		if (url.pathname === resourcePath)
			return route.fulfill({
				status,
				json:
					status === 200
						? body
						: {
								schemaVersion: 1,
								code:
									status === 403
										? "RESOURCE_UNAVAILABLE"
										: "DEPENDENCY_UNAVAILABLE",
								message: "Controlled fixture",
								retryable: status === 503,
								traceId: "ops-fixture",
							},
			});
		if (url.pathname === "/api/v2/ops/history" && historyStatus !== 200)
			return route.fulfill({
				status: historyStatus,
				json: {
					schemaVersion: 1,
					code:
						historyStatus === 403
							? "RESOURCE_UNAVAILABLE"
							: "DEPENDENCY_UNAVAILABLE",
					message: "Controlled history failure",
					retryable: historyStatus === 503,
					traceId: "ops-history-fixture",
				},
			});
		if (url.pathname === "/api/v2/ops/history")
			return route.fulfill({
				json: {
					schemaVersion: 2,
					scope: {
						clusterId: "cluster-fixture",
						namespace: "platform-fixture",
					},
					metric: url.searchParams.get("metric"),
					state: "available",
					start: url.searchParams.get("start"),
					end: url.searchParams.get("end"),
					stepSeconds: 30,
					statistic: url.searchParams.get("statistic"),
					series: [
						{
							name: "sandbox-fixture",
							resourceUid:
								url.searchParams.get("metric") === "cpu" ? "old-pod-uid" : null,
							points: [
								{ at: url.searchParams.get("start"), value: 0 },
								{ at: url.searchParams.get("end"), value: 0.5 },
							],
						},
						...(url.searchParams.get("metric") === "cpu"
							? [
									{
										name: "sandbox-fixture",
										resourceUid: "pod-uid",
										points: [{ at: url.searchParams.get("end"), value: null }],
									},
								]
							: []),
					],
					truncated: false,
				},
			});
		return route.fulfill({
			status: 404,
			json: {
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Outside fixture",
				retryable: false,
				traceId: "ops-fixture",
			},
		});
	});
	return {
		requests,
		expectGenerated: generated.expectGenerated,
		historyReply(next: number) {
			historyStatus = next;
		},
		reply(nextStatus: number, nextBody?: unknown) {
			status = nextStatus;
			if (nextBody !== undefined) body = nextBody;
		},
	};
}
async function noOverflow(page: Page) {
	expect(
		await page.evaluate(
			() =>
				Math.max(
					document.body.scrollWidth,
					document.documentElement.scrollWidth,
				) - innerWidth,
		),
	).toBeLessThanOrEqual(0);
}

test("resource data survives a missing cache source and supports Agent/session deep links", async ({
	page,
}, info) => {
	const errors = trackPageErrors(page);
	const api = await fixture(page);
	await page.goto("/ops");
	await expect(
		page.getByRole("heading", { name: "资源与运行状态" }),
	).toBeVisible();
	await expect(page.locator("#ops-sources")).toContainText("暂不可用");
	await expect(page.locator("#ops-agents")).toContainText("0 核");
	await expect(page.locator("#ops-agents")).toContainText("未知");
	await page.getByRole("button", { name: "分析助手", exact: true }).click();
	await expect(page).toHaveURL(/agentId=agent-fixture/);
	await page
		.getByLabel("会话", { exact: true })
		.selectOption("session-fixture");
	await expect(page).toHaveURL(/sessionId=session-fixture/);
	await page.reload();
	await expect(page.getByLabel("会话", { exact: true })).toHaveValue(
		"session-fixture",
	);
	await page
		.locator("#ops-resources")
		.getByRole("button", { name: /sandbox-fixture/ })
		.click();
	await expect(page.locator("#ops-resources")).toContainText("pod-uid");
	await noOverflow(page);
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
	await page.screenshot({
		path: info.outputPath(`ops-${info.project.name}.png`),
		fullPage: true,
		animations: "disabled",
	});
	expect(api.requests.every((request) => request.startsWith("GET "))).toBe(
		true,
	);
	api.expectGenerated("运维资源观测");
	await expectCleanPage(page, errors);
});

test("history preserves the chosen scope and shows real zero points", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto("/ops?agentId=agent-fixture&sessionId=session-fixture");
	await page.getByRole("button", { name: "查询历史", exact: true }).click();
	await expect(page.locator("#ops-history")).toContainText("已有历史样本");
	await expect(page.locator("#ops-history").getByRole("img")).toHaveCount(1);
	await expect(page.locator("#ops-history")).toContainText("最低 0 核");
	await expect(
		page.locator("#ops-history").getByRole("link", { name: /打开日志/ }),
	).toHaveAttribute("href", /from=.*to=/);
	const captions = page.locator("#ops-history figcaption");
	await expect(captions).toHaveText([
		"sandbox-fixture · UID old-pod-uid",
		"sandbox-fixture · UID pod-uid",
	]);
	await expect(
		page.locator("#ops-history figure").filter({ hasText: "UID pod-uid" }),
	).toContainText("数值未知");
	await page.getByLabel("指标", { exact: true }).selectOption("http-requests");
	await page.getByRole("button", { name: "查询历史", exact: true }).click();
	await expect(captions).toHaveText(["sandbox-fixture · UID 未知"]);
	api.expectGenerated("资源历史查询");
});

test("failed refresh preserves visible data but marks it stale", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto("/ops");
	await expect(
		page.getByRole("button", { name: "分析助手", exact: true }),
	).toBeVisible();
	api.reply(503);
	await page.getByRole("button", { name: "刷新", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("刷新失败");
	await expect(page.locator("#ops-sources")).toContainText("数据过期");
	await expect(
		page.getByRole("button", { name: "分析助手", exact: true }),
	).toBeVisible();
});

for (const denied of [401, 403]) {
	test(`dashboard stays reachable on resource failure and clears on access ${denied}`, async ({
		page,
	}) => {
		const api = await fixture(page);
		api.reply(503);
		const url = "https://grafana.example.test/d/impact";
		let status = 204;
		await page.route("**/api/v1/ops/dashboard-access", (route) =>
			route.fulfill({ status, headers: { "X-Operations-Dashboard-Url": url } }),
		);
		await page.goto("/ops");
		const link = page.getByRole("link", { name: "打开运维看板" });
		await expect(link).toHaveAttribute("href", url);
		await expect(page.getByRole("alert")).toContainText("资源观测查询");
		status = denied;
		await page.getByRole("button", { name: "重新读取观测状态" }).click();
		await expect(page.locator('[data-slot="state-card"]')).toHaveAttribute(
			"data-kind",
			"unauthorized",
		);
		await expect(link).toHaveCount(0);
	});
}

test("switching principals clears the previous administrator dashboard link", async ({
	page,
}) => {
	const api = await fixture(page);
	api.reply(503);
	await page.route("**/api/v1/ops/dashboard-access", (route) =>
		route.fulfill({
			status: 204,
			headers: {
				"X-Operations-Dashboard-Url": "https://grafana.example.test/d/impact",
			},
		}),
	);
	await page.goto("/ops");
	const link = page.getByRole("link", { name: "打开运维看板" });
	await expect(link).toBeVisible();
	await page.route("**/api/v1/session", (route) =>
		route.fulfill({
			json: {
				schemaVersion: 1,
				user: {
					userId: "second-user",
					displayName: "普通用户",
					roles: ["employee"],
				},
			},
		}),
	);
	await page.evaluate(() =>
		window.dispatchEvent(new Event("visibilitychange")),
	);
	await expect(page.locator('[data-slot="state-card"]')).toHaveAttribute(
		"data-kind",
		"unauthorized",
	);
	await expect(link).toHaveCount(0);
});

test("server revocation removes previous administrator observations", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto("/ops");
	await expect(
		page.getByRole("heading", { name: "资源与运行状态" }),
	).toBeVisible();
	api.reply(403);
	await page.getByRole("button", { name: "刷新", exact: true }).click();
	await expect(page.locator('[data-slot="state-card"]')).toHaveAttribute(
		"data-kind",
		"unauthorized",
	);
	await expect(page.getByRole("button", { name: "分析助手" })).toHaveCount(0);
	await expect(page.locator("#ops-sources")).toHaveCount(0);
});

test("ordinary users never request resource observations", async ({ page }) => {
	const api = await fixture(page, false);
	await page.goto("/ops");
	await expect(page.locator('[data-slot="state-card"]')).toHaveAttribute(
		"data-kind",
		"unauthorized",
	);
	expect(api.requests.some((request) => request.includes("/ops/"))).toBe(false);
	await noOverflow(page);
});

test("malformed data never renders arbitrary fields and can recover", async ({
	page,
}) => {
	const api = await fixture(page);
	api.reply(200, { ...sample(), credential: "fixture-private-sentinel" });
	await page.goto("/ops");
	await expect(page.locator('[data-slot="state-card"]')).toHaveAttribute(
		"data-kind",
		"unavailable",
	);
	await expect(page.locator("main")).not.toContainText(
		"fixture-private-sentinel",
	);
	api.reply(200, sample());
	await page.getByRole("button", { name: "重新读取观测状态" }).click();
	await expect(
		page.getByRole("heading", { name: "资源与运行状态" }),
	).toBeVisible();
});

test("320px layout preserves long identifiers and keyboard disclosure", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Narrow viewport checked once");
	await page.setViewportSize({ width: 320, height: 740 });
	const api = await fixture(page);
	const data = sample();
	data.resources[0].name = `sandbox-${"a".repeat(120)}`;
	api.reply(200, data);
	await page.goto("/ops");
	const trigger = page
		.locator("#ops-resources")
		.getByRole("button", { name: /sandbox-/ });
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await noOverflow(page);
	await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
	await page.screenshot({
		path: info.outputPath("ops-narrow.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("resource dashboard preserves the established viewport matrix", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Viewport matrix checked once");
	await fixture(page);
	await page.goto("/ops");
	for (const viewport of [
		{ width: 360, height: 800 },
		{ width: 390, height: 844 },
		{ width: 430, height: 932 },
		{ width: 600, height: 960 },
		{ width: 820, height: 1180 },
		{ width: 1024, height: 768 },
		{ width: 1366, height: 768 },
		{ width: 1440, height: 900 },
		{ width: 1920, height: 1080 },
	]) {
		await page.setViewportSize(viewport);
		await expect(
			page.getByRole("heading", { name: "资源与运行状态" }),
		).toBeVisible();
		await noOverflow(page);
	}
});

test("the same history query can retry and a history authorization denial clears the page", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto("/ops");
	await page.getByRole("button", { name: "查询历史", exact: true }).click();
	await expect(page.locator("#ops-history").getByRole("img")).toHaveCount(1);
	api.historyReply(503);
	await page.getByRole("button", { name: "查询历史", exact: true }).click();
	await expect(page.locator("#ops-history").getByRole("alert")).toBeVisible();
	api.historyReply(403);
	await page.getByRole("button", { name: "查询历史", exact: true }).click();
	await expect(page.locator('[data-slot="state-card"]')).toHaveAttribute(
		"data-kind",
		"unauthorized",
	);
	await expect(page.locator("#ops-agents")).toHaveCount(0);
	await expect(page.locator("#ops-history")).toHaveCount(0);
});
