import {
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	DeploymentConfigurationProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
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
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import { backgroundReread } from "./background-reread";
import {
	expectFocusableBusy,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import {
	expectCleanPage,
	expectEmptyRows,
	expectFieldControl,
	expectFieldLabel,
	expectNativeSelectArrow,
	expectSearchInput,
	trackPageErrors,
} from "./primitive-styles";

const baseAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
// 部署配置登记的模板显示名：页面只显示显示名，不显示原始 templateId（F-02）。
const deploymentConfiguration = DeploymentConfigurationProjectionV2Schema.parse(
	{
		schemaVersion: 2,
		status: "populated",
		templates: [
			["codex", "Codex"],
			["opencode", "OpenCode"],
			["pi", "Pi"],
		].map(([templateId, displayName]) => ({
			templateId,
			displayName,
			connectionEnabled: false,
			allowedEnvironmentKeys: [],
			allowedSecretKeys: [],
		})),
		modelCatalog: {
			status: "populated",
			revision: "catalog-search",
			endpoints: [],
		},
	},
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
	const current = {
		agents: catalog,
		denied: false,
		/** 目录读取的失败状态（401/404/503 等）；invalid 表示 200 但结构不符。 */
		failure: undefined as number | "invalid" | undefined,
		sessionExpired: false,
	};
	const commands: string[] = [];
	const unexpected: string[] = [];
	/** 每个 API 请求的路径，按发出顺序。 */
	const requests: string[] = [];
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
		getDeploymentConfiguration: { status: 200, body: deploymentConfiguration },
		listAgents: () =>
			current.denied
				? pilotFakeScenariosV2.unauthorized.response
				: current.failure && current.failure !== "invalid"
					? {
							status: current.failure,
							body: {
								schemaVersion: 1,
								code:
									current.failure === 401
										? "AUTHENTICATION_REQUIRED"
										: current.failure >= 500
											? "DEPENDENCY_UNAVAILABLE"
											: "RESOURCE_UNAVAILABLE",
								message: "Controlled directory failure",
								retryable: current.failure >= 500,
								traceId: "controlled-directory-failure",
							},
						}
					: {
							status: 200,
							body: { items: current.agents, nextCursor: null },
						},
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
		requests.push(url.pathname);
		if (
			request.method() === "GET" &&
			url.pathname === "/api/v1/connection/capability"
		)
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (
			request.method() === "GET" &&
			url.pathname === "/api/v2/directory/search"
		) {
			// Agent 详情侧栏按 Owner 的 ID 读取用户目录取组织路径（D-04）；其余只读组织名称。
			if (url.searchParams.get("kind") === "user") {
				expect(url.searchParams.get("ids")).toBe("user-owner-1");
				return route.fulfill({
					json: directorySearchResponse(url, [
						{
							kind: "user",
							canonicalId: "user-owner-1",
							displayName: "Owner",
							organizationPath: "研发 / 发布",
						},
					]),
				});
			}
			expect(url.searchParams.get("kind")).toBe("organization");
			expect(url.searchParams.get("ids")).toBe("org-platform");
			return route.fulfill({
				json: directorySearchResponse(url, [
					{
						kind: "organization",
						canonicalId: "org-platform",
						displayName: "平台工程",
						organizationPath: "研发 / 平台工程",
					},
				]),
			});
		}
		if (request.method() !== "GET") {
			commands.push(`${request.method()} ${url.pathname}`);
			return route.abort();
		}
		// 结构不符的成功响应绕过 Mock Server 自身的契约校验，直接交给页面。
		if (url.pathname === "/api/v2/agents" && current.failure === "invalid")
			return route.fulfill({
				json: { items: [{ agentId: 1 }], nextCursor: null },
			});
		if (url.pathname === "/api/v1/session" && current.sessionExpired)
			return route.fulfill({
				status: 401,
				json: {
					schemaVersion: 1,
					code: "AUTHENTICATION_REQUIRED",
					message: "Controlled session expired",
					retryable: false,
					traceId: "controlled-session-expired",
				},
			});
		if (
			url.pathname !== "/api/v1/session" &&
			url.pathname !== "/api/v2/deployment/configuration" &&
			url.pathname !== "/api/v2/agents" &&
			!/^\/api\/v2\/agents\/[^/]+(?:\/detail)?$/.test(url.pathname)
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
	return { current, commands, unexpected, requests };
}

async function capture(page: Page, info: TestInfo, name: string) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	const path = info.outputPath(`${name}-${info.project.name}.png`);
	await page.screenshot({ path, animations: "disabled" });
	await info.attach(`${name} (${info.config.metadata.head})`, {
		path,
		contentType: "image/png",
	});
}

async function expectFocusedAndUnobscured(control: Locator) {
	await expect(control).toBeFocused();
	// Inspect the painted focus state after the existing CSS transition settles.
	await expect
		.poll(() => control.evaluate((element) => element.getAnimations().length))
		.toBe(0);
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
	await expect(cards).toContainText("标准模板 · Codex");
	await expect(cards).not.toContainText("codex");
	await expect
		.poll(() => new URL(page.url()).searchParams.get("q"))
		.toBe("CODEX");
	expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
	for (const [query, name, label] of [
		["  CODEX  ", "发布助理", "标准模板 · Codex"],
		["企微机器人", "团队助理", "企微机器人"],
	]) {
		await search.fill(query);
		await expect(cards).toHaveCount(1);
		await expect(cards).toContainText(label);
		await page.reload();
		await expect(search).toHaveValue(query);
		await search.focus();
		await search.press("Tab");
		await expect(
			page.getByRole("combobox", { name: "状态", exact: true }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("combobox", { name: "模板", exact: true }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("combobox", { name: "模型", exact: true }),
		).toBeFocused();
		await page.keyboard.press("Tab");
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
	await expect(
		page.getByText("没有匹配的 Agent", { exact: true }),
	).toBeVisible();
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
		await expect(
			page.getByText("没有匹配的 Agent", { exact: true }),
		).toBeVisible();
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
	await expect(
		page.getByRole("status").filter({ hasText: "个结果" }),
	).toHaveText("0 个结果");
	await expect(page.locator(".agent-list > li")).toHaveCount(0);
	api.current.denied = true;
	await page.reload();
	// A-03：403 显示「未授权」状态卡，不再是统一的「请联系管理员」。
	await expect(
		page.getByRole("heading", { level: 2, name: "未授权", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("Agent 列表暂时无法访问，请联系管理员。"),
	).toHaveCount(0);
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
		await expect(
			page.getByRole("combobox", { name: "状态", exact: true }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("combobox", { name: "模板", exact: true }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(
			page.getByRole("combobox", { name: "模型", exact: true }),
		).toBeFocused();
		await page.keyboard.press("Tab");
		const detail = page.getByRole("link", { name: "查看 发布助理 详情" });
		await expectFocusedAndUnobscured(detail);
		await capture(page, info, `catalog-template-short-${width}px`);
		await detail.press("Enter");
		await expect(page).toHaveURL(/\/agents\/search-template$/);
	}
	expect(api.commands).toEqual([]);
	expect(api.unexpected).toEqual([]);
});

test("directory search and filters use the shared search box and field styles", async ({
	page,
}) => {
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/agents");
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await expect(search).toBeVisible();
	await expectSearchInput(search);
	await expectFieldLabel(page, page.locator("label", { hasText: "状态" }));
	await expectFieldControl(page, page.getByLabel("状态", { exact: true }));
	// #3037 X-01：筛选下拉的箭头是设计 .select 的背景小三角。
	for (const name of ["状态", "模板", "模型"])
		await expectNativeSelectArrow(page, page.getByLabel(name, { exact: true }));
	await expectCleanPage(page, pageErrors);
});

async function resolvedColor(page: Page, value: string) {
	return page.evaluate((color) => {
		const probe = document.createElement("span");
		probe.style.color = color;
		document.body.append(probe);
		const resolved = getComputedStyle(probe).color;
		probe.remove();
		return resolved;
	}, value);
}

const statusMatrix = [
	["available", "ready", "就绪", "green"],
	["available", "starting", "启动中", "amber"],
	["available", "updating", "更新中", "amber"],
	["available", "unavailable", "暂时不可用", "gray"],
	["stopped", null, "已停止", "gray"],
	// E3-05：创建失败按设计为 red（与 Owner 配置页头、申请详情「失败」一致）。
	["creation_failed", null, "创建失败", "red"],
] as const;

test.describe("Agent directory design alignment", () => {
	test("directory and detail show template display names and mark only the navigation as current (F-02 / N-21)", async ({
		page,
	}) => {
		const api = await fixture(page);
		await page.goto("/agents");
		const card = page
			.locator(".agent-list > li")
			.filter({ hasText: "发布助理" });
		await expect(
			card.locator('[data-slot="badge"][data-variant="tag"]').first(),
		).toHaveText("标准模板 · Codex");
		const templates = await page
			.getByRole("combobox", { name: "模板", exact: true })
			.locator("option")
			.allTextContents();
		expect(templates).toEqual(expect.arrayContaining(["Codex", "OpenCode"]));
		for (const raw of ["codex", "opencode", "pi"])
			expect(templates).not.toContain(raw);
		// 「模型」筛选项写模型显示名，不外露 modelId（value 仍为 modelId）。
		const model = page.getByRole("combobox", { name: "模型", exact: true });
		expect(await model.locator("option").allTextContents()).toEqual([
			"全部模型",
			"Primary model",
		]);
		await expect(model.locator("option").nth(1)).toHaveAttribute(
			"value",
			"gpt-5",
		);
		await card.getByRole("link", { name: "查看 发布助理 详情" }).click();
		await expect(
			page.getByRole("heading", { level: 1, name: "发布助理" }),
		).toBeVisible();
		await expect(page.locator("main .page-eyebrow")).toHaveText(
			"Agent 详情 · Codex",
		);
		await expect(page.locator("main")).toContainText("标准模板 · Codex");
		// 设计 #agent-detail：「模板 / 入口 = 标准模板 · Codex · 平台交互入口」，入口方式不单独占行。
		await expect(
			page.locator("main dt", { hasText: "模板 / 入口" }).locator("+ dd"),
		).toHaveText("标准模板 · Codex · 平台交互入口");
		await expect(page.locator("main dt", { hasText: "入口状态" })).toHaveCount(
			0,
		);
		// F-07：标准模板由平台校验身份，设计 dl 不列「入口身份责任」。
		await expect(
			page.locator("main dt", { hasText: "入口身份责任" }),
		).toHaveCount(0);
		await expect(page.locator("main")).not.toContainText("codex");
		// 页内「返回 Agent 目录」不是当前页；全页只有导航「Agent 目录」带 aria-current。
		const back = page.getByRole("link", { name: "返回 Agent 目录" });
		await expect(back).not.toHaveAttribute("aria-current", /.*/);
		await expect(page.locator('main a[aria-current="page"]')).toHaveCount(0);
		await expect(page.locator('a[aria-current="page"]')).toHaveText([
			"Agent 目录",
		]);
		expect(api.unexpected).toEqual([]);
	});

	test("the page-head eyebrow keeps the designed 0 0 9px margin so the h1 is not pushed down", async ({
		page,
	}, info) => {
		const api = await fixture(page);
		await page.goto("/agents");
		const heading = page.locator("main .page-heading").first();
		const eyebrow = heading.locator(".page-eyebrow");
		const h1 = heading.getByRole("heading", { level: 1 });
		await expect(h1).toHaveText("选择要使用的 Agent。");
		await expect(eyebrow).toHaveCSS("margin", "0px 0px 9px");
		const [eyebrowBox, h1Box, copyBox] = await Promise.all([
			eyebrow.boundingBox(),
			h1.boundingBox(),
			eyebrow.locator("xpath=..").boundingBox(),
		]);
		if (!eyebrowBox || !h1Box || !copyBox)
			throw new Error("Expected page head geometry");
		// 设计 #agents：eyebrow 贴页头顶部，h1 在其下 9px（1440 下 y=130.4，390 下 y=121.4）。
		expect(Math.abs(eyebrowBox.y - copyBox.y)).toBeLessThanOrEqual(0.5);
		expect(
			Math.abs(h1Box.y - (eyebrowBox.y + eyebrowBox.height + 9)),
		).toBeLessThanOrEqual(0.5);
		expect(
			Math.abs(h1Box.y - (info.project.name === "mobile" ? 121.4 : 130.4)),
		).toBeLessThanOrEqual(1);
		expect(api.unexpected).toEqual([]);
	});

	test("result head shows the available-scope heading and a filtered result chip", async ({
		page,
	}, info) => {
		const api = await fixture(page);
		api.current.agents = catalog.slice(0, 4);
		await page.goto("/agents");
		const head = page.locator(".directory-section-head");
		await expect(
			head.getByRole("heading", { level: 2, name: "可用范围", exact: true }),
		).toBeVisible();
		await expect(head.getByText("已授权的 Agent", { exact: true })).toHaveCSS(
			"font-size",
			"13px",
		);
		const status = head.getByRole("status");
		const chip = status.locator('[data-slot="badge"]');
		await expect(chip).toHaveText("4 个结果");
		await expect(chip).toHaveAttribute("data-tone", "gray");
		await expect(chip).toHaveCSS("font-size", "11px");
		await expect(chip).toHaveCSS("border-radius", "999px");
		expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(24);
		await expect(head).toHaveCSS(
			"align-items",
			info.project.name === "mobile" ? "flex-start" : "end",
		);
		for (const removed of ["可发现", "我的可用 Agent", "获授权 Agent"])
			await expect(page.getByText(removed)).toHaveCount(0);
		await page.getByRole("searchbox", { name: "搜索 Agent" }).fill("助理");
		await expect(chip).toHaveText("2 个结果");
		expect(api.unexpected).toEqual([]);
	});

	test("each card shows one derived availability chip and the Owner and model foot", async ({
		page,
	}, info) => {
		const api = await fixture(page);
		api.current.agents = statusMatrix.map(
			([managementStatus, serviceAvailability, label]) =>
				AgentProjectionV2Schema.parse({
					...baseAgent,
					agentId: `status-${label}`,
					name: `状态 ${label}`,
					managementStatus,
					serviceAvailability,
				}),
		);
		await page.goto("/agents");
		const cards = page.locator(".agent-list > li");
		await expect(cards).toHaveCount(statusMatrix.length);
		const tones = {
			green: await resolvedColor(page, "var(--success-ink)"),
			amber: await resolvedColor(page, "var(--warning-ink)"),
			gray: await resolvedColor(page, "var(--muted-foreground)"),
			red: await resolvedColor(page, "var(--danger-ink)"),
		};
		for (const [index, [, , label, tone]] of statusMatrix.entries()) {
			const card = cards.nth(index);
			const chips = card.locator('[data-slot="badge"][data-variant="chip"]');
			await expect(chips).toHaveText([label]);
			await expect(chips).toHaveAttribute("data-tone", tone);
			await expect(chips).toHaveCSS("color", tones[tone]);
			await expect(card.locator('[class*="bg-secondary"]')).toHaveCount(0);
		}
		const card = cards.first();
		await expect(card.getByRole("heading", { level: 3 })).toHaveCSS(
			"font-weight",
			"650",
		);
		const foot = card.locator(".directory-card-foot");
		await expect(foot).toHaveCSS("border-top-width", "0px");
		await expect(foot).toHaveCSS("padding-top", "14px");
		const lines = foot.locator(".directory-card-foot-main small");
		await expect(lines).toHaveText([
			`Owner · ${baseAgent.configuration.owners.map((owner) => owner.displayName).join("、")}`,
			baseAgent.configuration.modelOptions
				.map((option) => option.displayName)
				.join(" · "),
		]);
		for (const line of await lines.all())
			await expect(line).toHaveCSS("font-size", "12px");
		const detail = card.getByRole("link", { name: "查看 状态 就绪 详情" });
		const detailBox = await detail.boundingBox();
		const footBox = await foot.boundingBox();
		if (!detailBox || !footBox) throw new Error("Expected card foot geometry");
		if (info.project.name === "desktop")
			expect(
				Math.abs(detailBox.x + detailBox.width - (footBox.x + footBox.width)),
			).toBeLessThanOrEqual(1);
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 320, height: 640 },
		]) {
			await page.setViewportSize(viewport);
			await capture(page, info, `directory-cards-${viewport.width}`);
			for (const element of [
				card.locator('[data-slot="badge"][data-variant="chip"]'),
				lines.last(),
				detail,
			]) {
				const box = await element.boundingBox();
				const cardBox = await card.boundingBox();
				if (!box || !cardBox) throw new Error("Expected card geometry");
				expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1);
				expect(box.x + box.width).toBeLessThanOrEqual(
					cardBox.x + cardBox.width + 1,
				);
			}
		}
		// E3-05：详情页状态行与「服务状态」行的 chip 与目录卡同一派生规则，创建失败为 red。
		await cards
			.last()
			.getByRole("link", { name: "查看 状态 创建失败 详情" })
			.click();
		await expect(
			page.getByRole("heading", { level: 1, name: "状态 创建失败" }),
		).toBeVisible();
		const detailChips = page.locator(
			'main [data-slot="badge"][data-variant="chip"]',
			{ hasText: /^创建失败$/ },
		);
		await expect(detailChips).toHaveCount(2);
		for (const detailChip of await detailChips.all()) {
			await expect(detailChip).toHaveAttribute("data-tone", "red");
			await expect(detailChip).toHaveCSS("color", tones.red);
		}
		expect(api.unexpected).toEqual([]);
	});

	test("search empty state clears every filter and an empty directory has no clear action", async ({
		page,
	}) => {
		const pageErrors = trackPageErrors(page);
		const api = await fixture(page);
		await page.goto("/agents");
		const cards = page.locator(".agent-list > li");
		await expect(cards).toHaveCount(5);
		await page
			.getByRole("combobox", { name: "状态", exact: true })
			.selectOption("ready");
		await page.getByRole("searchbox", { name: "搜索 Agent" }).fill("不存在");
		const empty = page.locator('[data-slot="empty"]');
		await expect(empty).toHaveCSS("border-top-style", "dashed");
		expect((await empty.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
			220,
		);
		const icon = empty.locator('svg[aria-hidden="true"]');
		await expect(icon).toHaveCSS("width", "28px");
		await expect(icon).toHaveCSS("height", "28px");
		const title = empty.getByText("没有匹配的 Agent", { exact: true });
		await expect(title).toHaveCSS("font-size", "15px");
		expect(await title.evaluate((node) => node.tagName)).toBe("STRONG");
		// #3037 X-02：图标、标题与说明、操作三行均分，取导出稿 agent-directory-empty 的测量值。
		await expectEmptyRows(empty, {
			icon: 34.47,
			title: 84.41,
			description: 109.16,
			action: 141.53,
		});
		await expectCleanPage(page, pageErrors);
		await empty.getByRole("button", { name: "清除筛选" }).click();
		await expect(
			page.getByRole("searchbox", { name: "搜索 Agent" }),
		).toHaveValue("");
		for (const name of ["状态", "模板", "模型"])
			await expect(
				page.getByRole("combobox", { name, exact: true }),
			).toHaveValue("all");
		await expect(cards).toHaveCount(5);
		api.current.agents = [];
		await page.reload();
		await expect(
			empty.getByText("暂无你有权访问的 Agent", { exact: true }),
		).toBeVisible();
		await expect(empty.locator('svg[aria-hidden="true"]')).toHaveCount(1);
		await expect(empty.getByRole("button")).toHaveCount(0);
		expect(api.unexpected).toEqual([]);
	});

	test("read failures render distinct state cards and only 503 offers reload", async ({
		page,
	}) => {
		const api = await fixture(page);
		const titles: string[] = [];
		for (const failure of [401, 403, 404, "invalid", 503] as const) {
			if (failure === 403) api.current.denied = true;
			else {
				api.current.denied = false;
				api.current.failure = failure;
			}
			await page.goto("/agents");
			// A-03：目录用公共状态卡（设计 .state-card）。
			const card = page.locator('#main-content [data-slot="state-card"]');
			await expect(card).toBeVisible();
			await expect(card).toHaveCSS("border-radius", "14px");
			await expect(card).toHaveCSS("padding", "18px");
			expect((await card.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
				190,
			);
			titles.push(
				(await card.getByRole("heading", { level: 2 }).textContent()) ?? "",
			);
			await expect(
				page.getByText("Agent 列表暂时无法访问，请联系管理员。"),
			).toHaveCount(0);
			await expect(page.getByRole("button", { name: /重新加载/ })).toHaveCount(
				failure === 503 ? 1 : 0,
			);
			if (failure === 401)
				await expect(card.getByRole("button", { name: "重新登录" })).toHaveCSS(
					"background-color",
					await resolvedColor(page, "var(--accent-ink)"),
				);
			if (failure === 403)
				await expect(
					card.getByRole("link", { name: "返回工作台" }),
				).toHaveAttribute("href", "/");
			if (failure === 503) {
				api.current.failure = undefined;
				await card.getByRole("button", { name: "重新加载 Agent" }).click();
				await expect(page.locator(".agent-list > li")).toHaveCount(5);
			}
		}
		expect(new Set(titles).size).toBe(5);
		expect(api.commands).toEqual([]);
		expect(api.unexpected).toEqual([]);
	});

	test("401 re-login with a still-valid session re-reads the directory (W-03)", async ({
		page,
	}) => {
		const api = await fixture(page);
		api.current.failure = 401;
		await page.goto("/agents");
		const relogin = page.getByRole("button", { name: "重新登录", exact: true });
		await expect(relogin).toHaveCount(1);
		const reads = () =>
			api.requests.filter((path) => path === "/api/v2/agents").length;
		const before = reads();
		// 会话仍有效、目录恢复：「重新登录」越过不可重试的 401，重读一次目录并显示结果。
		api.current.failure = undefined;
		await relogin.click();
		await expect(page.locator(".agent-list > li")).toHaveCount(5);
		await expect(
			page.locator('#main-content [data-slot="state-card"]'),
		).toHaveCount(0);
		expect(reads()).toBe(before + 1);
		expect(
			await page.evaluate(
				() => performance.getEntriesByType("navigation").length,
			),
		).toBe(1);
		expect(api.commands).toEqual([]);
		expect(api.unexpected).toEqual([]);
	});

	test("keyboard recovery from 401 re-login and 503 reload moves focus to the page h1, not body", async ({
		page,
	}) => {
		const api = await fixture(page);
		const heading = page.getByRole("heading", {
			level: 1,
			name: "选择要使用的 Agent。",
		});
		for (const [failure, name] of [
			[401, "重新登录"],
			[503, "重新加载 Agent"],
		] as const) {
			api.current.failure = failure;
			await page.goto("/agents");
			const action = page.getByRole("button", { name, exact: true });
			await action.focus();
			await expect(action).toBeFocused();
			api.current.failure = undefined;
			await page.keyboard.press("Enter");
			await expect(page.locator(".agent-list > li")).toHaveCount(5);
			await expect(action).toHaveCount(0);
			// 恢复后按钮卸载：焦点移到页面 h1（tabIndex=-1），读屏与 Tab 从标题继续。
			await expect(heading).toBeFocused();
			await expect(heading).toHaveAttribute("tabindex", "-1");
			expect(
				await page.evaluate(() => document.activeElement === document.body),
			).toBe(false);
		}
		expect(api.commands).toEqual([]);
		expect(api.unexpected).toEqual([]);
	});

	test("a failed keyboard 401 re-login or 503 reload keeps focus on the button, not body (FIX3-6)", async ({
		page,
	}) => {
		const api = await fixture(page);
		for (const [failure, name] of [
			// 401：会话仍有效，重置查询重读目录仍返回 401（期间先显示读取中）。
			[401, "重新登录"],
			[503, "重新加载 Agent"],
		] as const) {
			api.current.failure = failure;
			await page.goto("/agents");
			const action = page.getByRole("button", { name, exact: true });
			await action.focus();
			await expect(action).toBeFocused();
			const reread = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/v2/agents" &&
					response.status() === failure,
			);
			await page.keyboard.press("Enter");
			await reread;
			// 仍然失败：按钮回到可用状态，焦点仍在（或回到）这个按钮上。
			await expect(action).toHaveAttribute("aria-disabled", "false");
			await expect(action).toBeFocused();
			expect(
				await page.evaluate(() => document.activeElement === document.body),
			).toBe(false);
		}
		expect(api.commands).toEqual([]);
		expect(api.unexpected).toEqual([]);
	});

	test("401 re-login rechecks the session through the shell without reloading", async ({
		page,
	}) => {
		const api = await fixture(page);
		api.current.failure = 401;
		await page.goto("/agents");
		await page.evaluate(() => {
			Object.assign(window, { controlledNoReload: "kept" });
		});
		const relogin = page.getByRole("button", { name: "重新登录", exact: true });
		await expect(relogin).toHaveCount(1);
		api.current.sessionExpired = true;
		await relogin.click();
		await expect(
			page.getByRole("heading", { level: 1, name: "登录工作区" }),
		).toBeVisible();
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { controlledNoReload?: string })
						.controlledNoReload,
			),
		).toBe("kept");
		expect(api.commands).toEqual([]);
	});

	// #3327 N10-1-01：确认会话已失效、整页换成登录页后，焦点同主动退出交给登录页（本构建未配置登录入口，
	// 到「登录工作区」标题），确认中留在可聚焦的「重新登录」上，30 / 150 / 400 / 1200ms 都不落到 body。
	// N10-1-04：目录 401 卡的「重新登录」与 Agent 管理、设计 #states 代表卡相同，带 16px LogIn 图标。
	test("a 401 re-login that finds the session expired hands focus to the login page, not body (#3327 N10-1-01, N10-1-04)", async ({
		page,
	}, info) => {
		const mobile = info.project.name === "mobile";
		if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
		const errors = trackPageErrors(page);
		const api = await fixture(page);
		api.current.failure = 401;
		await page.goto("/agents");
		const card = page.locator('#main-content [data-slot="state-card"]');
		await expect(card).toHaveAttribute("data-kind", "login");
		const relogin = await pinElement(
			card.getByRole("button", { name: "重新登录", exact: true }),
			"directory-relogin",
		);
		await expect(relogin).toHaveText("重新登录");
		const icon = relogin.locator(":scope > svg");
		await expect(icon).toHaveCount(1);
		await expect(icon).toHaveAttribute("aria-hidden", "true");
		await expect(icon).toHaveAttribute("data-icon", "inline-start");
		await expect(icon).toHaveClass(/lucide-log-in/);
		expect(await icon.boundingBox()).toMatchObject({ width: 16, height: 16 });
		await info.attach(`n10-1-04-agents-401-${mobile ? 390 : 1440}`, {
			body: await card.screenshot(),
			contentType: "image/png",
		});
		api.current.sessionExpired = true;
		const hold = await holdRequests(page, "GET", "/api/v1/session");
		await relogin.focus();
		await page.keyboard.press("Enter");
		await expect.poll(() => hold.held()).toBeGreaterThanOrEqual(1);
		await expectFocusableBusy(relogin, "Agent 目录确认会话中", [30, 150]);
		hold.release();
		const title = page.getByRole("heading", { level: 1, name: "登录工作区" });
		await expect(title).toBeVisible();
		await expect(page.locator(".login-expired")).toHaveAttribute(
			"role",
			"status",
		);
		await expectFocusSettled(
			title,
			"Agent 目录确认会话已失效后",
			[30, 150, 400, 1200],
		);
		await expectCleanPage(page, errors);
		expect(api.commands).toEqual([]);
	});
});

// #3269 N8-3-02：Agent 目录无匹配空态「清除筛选」清除后空态随之卸载，焦点回到「搜索 Agent」搜索框
// （同 Skill Hub），30 / 150 / 400 / 1000ms 采样都不落到 body。
test("clearing directory filters returns focus to the search box (N8-3-02)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/agents");
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await search.fill("不存在");
	const empty = page.locator('[data-slot="empty"]');
	const clear = empty.getByRole("button", { name: "清除筛选" });
	await clear.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".agent-list > li")).toHaveCount(5);
	await expect(search).toHaveValue("");
	await expectFocusSettled(
		search,
		"Agent 目录清除筛选后",
		[30, 150, 400, 1000],
	);
	await expectNoDuplicateControls(page, "Agent 目录（N8-3-02）");
	await expectCleanPage(page, pageErrors);
});

// #3388 N13-03：/agents?mode=conversation 读取 401，侧栏「Agent 目录」到 /agents（同一张失败卡），按「重新登录」
// （会话确认挂起，按钮可聚焦地禁用）后浏览器后退到 ?mode=conversation：只改了查询串、按钮仍在，代管继续。
// 确认完成、目录读到后焦点到 h1，仍 401 时留在「重新登录」上，都不落到 body。两视口一致。
for (const outcome of ["recovers", "fails again"] as const)
	test(`going back to ?mode=conversation while re-login is confirming keeps the same-page handoff (${outcome}, #3388 N13-03)`, async ({
		page,
	}, info) => {
		const mobile = info.project.name === "mobile";
		if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
		const errors = trackPageErrors(page);
		const api = await fixture(page);
		api.current.failure = 401;
		await page.goto("/agents?mode=conversation");
		const main = page.locator("#main-content");
		const card = main.locator('[data-slot="state-card"]');
		await expect(card).toHaveAttribute("data-kind", "login");
		if (mobile)
			await page.getByRole("button", { name: "打开导航", exact: true }).click();
		await page
			.getByRole("navigation")
			.getByRole("link", { name: "Agent 目录" })
			.first()
			.click();
		await expect(page).toHaveURL(/\/agents$/);
		await expect(card).toHaveAttribute("data-kind", "login");
		const relogin = card.getByRole("button", { name: "重新登录", exact: true });
		if (outcome === "recovers") api.current.failure = undefined;
		const hold = await holdRequests(page, "GET", "/api/v1/session");
		await relogin.focus();
		await page.keyboard.press("Enter");
		await expect.poll(() => hold.held()).toBeGreaterThanOrEqual(1);
		await expectFocusableBusy(relogin, "重新登录确认会话中", [30, 150]);
		await page.goBack();
		await expect(page).toHaveURL(/\/agents\?mode=conversation$/);
		await expectFocusableBusy(relogin, "后退只改查询串后", [30, 150]);
		hold.release();
		if (outcome === "recovers") {
			await expect(page.locator(".agent-list > li").first()).toBeVisible();
			await expect(card).toHaveCount(0);
			await expectFocusSettled(
				main.getByRole("heading", { level: 1, name: "选择 Agent 开始对话" }),
				"后退后重新登录恢复",
				[50, 300, 1000, 2000],
			);
		} else {
			await expect(relogin).toHaveAttribute("aria-disabled", "false");
			await expectFocusSettled(
				relogin,
				"后退后重新登录仍失败",
				[50, 300, 1000, 2000],
			);
		}
		await expectNoDuplicateControls(page, `Agent 目录（后退，${outcome}）`);
		await expectCleanPage(page, errors);
		expect(api.commands).toEqual([]);
	});

// #3388 N13-05：目录读取 503 后焦点在未按下的「重新加载 Agent」上（Tab 到它），回到标签页的后台重读：成功、
// 失败卡卸载后焦点交给 h1，不滚动页面；仍失败时失败卡与按钮重新出现，焦点回到按钮上；都不落到 body。
// 对照：按下按钮的恢复同样到 h1（既有行为）。两视口一致。
for (const outcome of ["recovers", "fails again"] as const)
	test(`a background reread of a failed directory with focus on the unpressed reload ${outcome === "recovers" ? "hands focus to the h1" : "keeps it on the reload"} (#3388 N13-05)`, async ({
		page,
	}, info) => {
		const mobile = info.project.name === "mobile";
		if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
		const errors = trackPageErrors(page);
		const api = await fixture(page);
		api.current.failure = 503;
		await page.goto("/agents");
		const main = page.locator("#main-content");
		const card = main.locator('[data-slot="state-card"]');
		await expect(card).toHaveAttribute("data-kind", "unavailable");
		const reload = card.getByRole("button", {
			name: "重新加载 Agent",
			exact: true,
		});
		const heading = main.getByRole("heading", {
			level: 1,
			name: "选择要使用的 Agent。",
		});
		// 用户 Tab 到按钮但不按下（这里直接聚焦，等同键盘到达）。
		await reload.focus();
		await expect(reload).toBeFocused();
		if (outcome === "recovers") api.current.failure = undefined;
		const scrolled = await page.evaluate(() => window.scrollY);
		const reading = await holdRequests(page, "GET", "/api/v2/agents");
		await backgroundReread(page);
		await expect.poll(() => reading.held()).toBeGreaterThanOrEqual(1);
		// 没有数据的查询重读回到读取中：失败卡与按钮卸载，焦点先到 h1（D2-59），不落到 body。
		await expectFocusSettled(heading, "后台重读挂起", [30, 150, 400]);
		reading.release();
		if (outcome === "recovers") {
			await expect(page.locator(".agent-list > li")).toHaveCount(5);
			await expectFocusSettled(
				heading,
				"后台重读成功后",
				[50, 300, 1000, 2000],
			);
		} else {
			await expect(card).toHaveAttribute("data-kind", "unavailable");
			await expectFocusSettled(
				reload,
				"后台重读仍失败后",
				[50, 300, 1000, 2000],
			);
		}
		expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
		await expectNoDuplicateControls(page, `Agent 目录（后台重读，${outcome}）`);
		await expectCleanPage(page, errors);
		expect(api.commands).toEqual([]);
	});

// #3388 N13-04：目录读取 401，「重新登录」恢复后焦点交给 h1；用户之后只滚动、不按键不点击。回到标签页的后台
// 重读又读到 401（不可重试，仍整页换成「登录已过期」卡，#3387）、同一个「重新登录」再次出现时不取回焦点、
// 不滚动页面：「仍失败回到按钮」只指本次恢复请求本身失败（对照：本次请求仍 401 时回到按钮，见上方用例）。
// 后台重读挂起时焦点同样留在 h1。两视口一致。
test("a re-login handoff is not taken back when a later background reread is 401 again (#3388 N13-04)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	const errors = trackPageErrors(page);
	const api = await fixture(page);
	api.current.failure = 401;
	await page.goto("/agents");
	const main = page.locator("#main-content");
	const card = main.locator('[data-slot="state-card"]');
	const heading = main.getByRole("heading", {
		level: 1,
		name: "选择要使用的 Agent。",
	});
	const relogin = card.getByRole("button", { name: "重新登录", exact: true });
	await expect(card).toHaveAttribute("data-kind", "login");
	api.current.failure = undefined;
	await relogin.focus();
	await page.keyboard.press("Enter");
	await expect(page.locator(".agent-list > li")).toHaveCount(5);
	await expectFocusSettled(heading, "重新登录恢复后", [50, 300, 1000]);
	await page.evaluate(() =>
		window.scrollTo(0, document.documentElement.scrollHeight),
	);
	const scrolled = await page.evaluate(() => window.scrollY);

	api.current.failure = 401;
	const reading = await holdRequests(page, "GET", "/api/v2/agents");
	await backgroundReread(page);
	await expect.poll(() => reading.held()).toBeGreaterThanOrEqual(1);
	await expectFocusSettled(heading, "后台重读挂起", [50, 300]);
	reading.release();
	await expect(card).toHaveAttribute("data-kind", "login");
	await expect(relogin).toBeVisible();
	await expectFocusSettled(
		heading,
		"后台重读又读到 401 后",
		[50, 300, 1000, 2000],
	);
	expect(await page.evaluate(() => window.scrollY)).toBeLessThanOrEqual(
		scrolled,
	);
	await expectNoDuplicateControls(page, "Agent 目录（交接后后台 401）");
	await expectCleanPage(page, errors);
	expect(api.commands).toEqual([]);
});
