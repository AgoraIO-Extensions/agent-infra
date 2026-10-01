import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import {
	expect,
	type Locator,
	type Page,
	type TestInfo,
	test,
} from "@playwright/test";

const baseAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const catalog = [
	AgentProjectionV2Schema.parse({
		...baseAgent,
		agentId: "search-template",
		name: "发布助理",
		description: "检查发布说明",
		serviceAvailability: "ready",
		configuration: {
			...baseAgent.configuration,
			channels: [{ kind: "web", status: "available" }],
		},
	}),
	AgentProjectionV2Schema.parse({
		...baseAgent,
		agentId: "search-channel",
		name: "团队助理",
		description: "整理团队文档",
		source: { kind: "standard", templateId: "opencode" },
		serviceAvailability: "ready",
		configuration: {
			...baseAgent.configuration,
			channels: [
				{ kind: "wecom_bot", status: "bound" },
				{ kind: "web", status: "failed" },
			],
		},
	}),
	AgentProjectionV2Schema.parse({
		...baseAgent,
		agentId: "search-self-managed",
		name: "独立入口",
		description: "使用自托管界面",
		serviceAvailability: "ready",
		source: {
			kind: "custom",
			imageReference: "registry.example/private-image-marker:v1",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
		},
		configuration: {
			...baseAgent.configuration,
			channels: [{ kind: "wecom_app", status: "not_configured" }],
		},
	}),
	...["starting", "stopped"].map((state) =>
		AgentProjectionV2Schema.parse({
			...baseAgent,
			agentId: `search-${state}`,
			name: state === "starting" ? "启动助手" : "暂停助手",
			description: "等待服务可用",
			source: { kind: "standard", templateId: "pi" },
			managementStatus: state === "stopped" ? "stopped" : "available",
			serviceAvailability: state === "stopped" ? null : "starting",
			configuration: { ...baseAgent.configuration, channels: [] },
		}),
	),
];

// HTTP/session fixtures only; all projections pass the production contract.
async function fixture(page: Page) {
	const current = { agents: catalog, denied: false };
	const commands: string[] = [];
	const unexpected: string[] = [];
	const server = createPilotAgentMockServerV2({
		getCurrentSession: {
			status: 200,
			body: {
				schemaVersion: 1,
				user: {
					userId: "user-catalog-search",
					displayName: "Controlled employee",
					roles: ["employee"],
				},
			},
		},
		listAgents: () =>
			current.denied
				? pilotFakeScenariosV2.unauthorized.response
				: { status: 200, body: { items: current.agents, nextCursor: null } },
		getAgent: (_request, agentId) => {
			const agent = current.agents.find((item) => item.agentId === agentId);
			return agent && !current.denied
				? { status: 200, body: agent }
				: pilotFakeScenariosV2.unauthorized.response;
		},
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() !== "GET") {
			commands.push(`${request.method()} ${url.pathname}`);
			return route.abort();
		}
		if (
			url.pathname !== "/api/v1/session" &&
			url.pathname !== "/api/v2/agents" &&
			!/^\/api\/v2\/agents\/[^/]+$/.test(url.pathname)
		) {
			unexpected.push(url.pathname);
			return route.abort();
		}
		const response = await server.fetch(new Request(request.url()));
		await route.fulfill({
			status: response.status,
			body: await response.text(),
			contentType: "application/json",
		});
	});
	return { current, commands, unexpected };
}

async function capture(page: Page, info: TestInfo, name: string) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	const path = info.outputPath(`${name}-${info.project.name}.png`);
	await page.screenshot({ path });
	await info.attach(`${name} (${info.config.metadata.head})`, {
		path,
		contentType: "image/png",
	});
}

async function expectFocusedAndUnobscured(control: Locator) {
	await expect(control).toBeFocused();
	const geometry = await control.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		const points = [
			[box.left + box.width / 2, box.top + 3],
			[box.left + box.width / 2, box.bottom - 3],
			[box.left + 3, box.top + box.height / 2],
			[box.right - 3, box.top + box.height / 2],
			[box.left + box.width / 2, box.top + box.height / 2],
		];
		return {
			focusVisible: element.matches(":focus-visible"),
			focusIndicator:
				style.boxShadow !== "none" || style.outlineStyle !== "none",
			unobscured: points.every(([x, y]) => {
				const hit = document.elementFromPoint(x ?? 0, y ?? 0);
				return hit !== null && element.contains(hit);
			}),
		};
	});
	expect(geometry).toEqual({
		focusVisible: true,
		focusIndicator: true,
		unobscured: true,
	});
}

test("visible template and channel searches restore across reload and keyboard detail/back", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents");
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	const cards = page.locator(".agent-list > li");
	await expect(cards).toHaveCount(5);
	const historyLength = await page.evaluate(() => window.history.length);
	await search.pressSequentially("CODEX");
	await expect(cards).toHaveCount(1);
	await expect(cards).toContainText("标准模板 · codex");
	await expect
		.poll(() => new URL(page.url()).searchParams.get("q"))
		.toBe("CODEX");
	expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
	for (const [query, name, label] of [
		["  CODEX  ", "发布助理", "标准模板 · codex"],
		["企微机器人", "团队助理", "企微机器人"],
	]) {
		await search.fill(query);
		await expect(cards).toHaveCount(1);
		await expect(cards).toContainText(label);
		await page.reload();
		await expect(search).toHaveValue(query);
		await search.focus();
		await search.press("Tab");
		const detail = page.getByRole("link", { name: `查看 ${name} 详情` });
		await expectFocusedAndUnobscured(detail);
		await capture(page, info, `catalog-${name}-keyboard`);
		await detail.press("Enter");
		await expect(
			page.getByRole("heading", { name, exact: true }),
		).toBeVisible();
		await page.goBack();
		await expect(search).toHaveValue(query);
		await expect(cards).toHaveCount(1);
	}
	await search.fill("没有匹配的中文");
	await expect(page.getByText("未找到匹配的 Agent。")).toBeVisible();
	await expect(cards).toHaveCount(0);
	await search.fill("");
	await expect(cards).toHaveCount(5);
	expect(new URL(page.url()).searchParams.has("q")).toBe(false);
	expect(api.commands).toEqual([]);
	expect(api.unexpected).toEqual([]);
});

test("label matches preserve conversation eligibility and exclude hidden DTO fields", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents?mode=conversation");
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	const cards = page.locator(".agent-list > li");
	await search.fill(" wEB ");
	await expect(cards).toHaveCount(1);
	await expect(page.getByRole("link", { name: "开始对话" })).toHaveAttribute(
		"href",
		"/chat/search-template",
	);
	for (const query of ["自定义 Agent", "自有交互入口"]) {
		await search.fill(query);
		await expect(cards).toHaveCount(1);
		await expect(cards).toContainText("独立入口");
		await expect(page.getByRole("link", { name: "开始对话" })).toHaveCount(0);
	}
	await page.reload();
	await expect(search).toHaveValue("自有交互入口");
	await page.getByRole("link", { name: "查看 独立入口 详情" }).click();
	await expect(page).toHaveURL(/\/agents\/search-self-managed$/);
	await page.goBack();
	await expect(search).toHaveValue("自有交互入口");
	expect(new URL(page.url()).searchParams.get("mode")).toBe("conversation");
	await search.fill("暂无可用渠道");
	await expect(cards).toHaveCount(2);
	await expect(page.getByRole("link", { name: "开始对话" })).toHaveCount(0);
	await capture(page, info, "catalog-fallback-ineligible");
	for (const query of [
		"企微应用",
		"private-image-marker",
		"user-owner-1",
		"MODEL_API_KEY",
		"gpt-5",
	]) {
		await search.fill(query);
		await expect(cards).toHaveCount(0);
		await expect(page.getByText("未找到匹配的 Agent。")).toBeVisible();
	}
	expect(api.commands).toEqual([]);
	expect(api.unexpected).toEqual([]);
});

test("search uses the current authorized collection and removes stale matches after denial", async ({
	page,
}, info) => {
	const api = await fixture(page);
	await page.goto("/agents?q=codex");
	await expect(page.locator(".agent-list > li")).toHaveCount(1);
	api.current.agents = catalog.filter(
		(agent) => agent.agentId === "search-channel",
	);
	await page.reload();
	await expect(page.getByRole("searchbox", { name: "搜索 Agent" })).toHaveValue(
		"codex",
	);
	await expect(page.getByText("1 个获授权 Agent，匹配 0 个")).toBeVisible();
	await expect(page.locator(".agent-list > li")).toHaveCount(0);
	api.current.denied = true;
	await page.reload();
	await expect(
		page.getByText("Agent 列表暂时无法访问，请联系管理员。"),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "发布助理", exact: true }),
	).toHaveCount(0);
	await capture(page, info, "catalog-current-collection-denial");
	api.current.denied = false;
	await page.reload();
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await search.fill("opencode");
	await expect(page.locator(".agent-list > li")).toHaveCount(1);
	await expect(
		page.getByRole("heading", { name: "团队助理", exact: true }),
	).toBeVisible();
	expect(api.commands).toEqual([]);
	expect(api.unexpected).toEqual([]);
});

test("template search and keyboard detail activation remain visible in short viewports", async ({
	page,
}, info) => {
	const api = await fixture(page);
	for (const width of [160, 390]) {
		await page.setViewportSize({ width, height: 370 });
		await page.goto("/agents");
		const search = page.getByRole("searchbox", { name: "搜索 Agent" });
		await search.click();
		await search.fill("codex");
		await expectFocusedAndUnobscured(search);
		await expect(page.locator(".agent-list > li")).toHaveCount(1);
		await search.press("Tab");
		const detail = page.getByRole("link", { name: "查看 发布助理 详情" });
		await expectFocusedAndUnobscured(detail);
		await capture(page, info, `catalog-template-short-${width}px`);
		await detail.press("Enter");
		await expect(page).toHaveURL(/\/agents\/search-template$/);
	}
	expect(api.commands).toEqual([]);
	expect(api.unexpected).toEqual([]);
});
