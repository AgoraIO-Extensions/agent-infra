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
import {
	expectFieldControl,
	expectFieldLabel,
	expectSearchInput,
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
					json: {
						items: [
							{
								kind: "user",
								canonicalId: "user-owner-1",
								displayName: "Owner",
								organizationPath: "研发 / 发布",
							},
						],
					},
				});
			}
			expect(url.searchParams.get("kind")).toBe("organization");
			expect(url.searchParams.get("ids")).toBe("org-platform");
			return route.fulfill({
				json: {
					items: [
						{
							kind: "organization",
							canonicalId: "org-platform",
							displayName: "平台工程",
							organizationPath: "研发 / 平台工程",
						},
					],
				},
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
	await fixture(page);
	await page.goto("/agents");
	const search = page.getByRole("searchbox", { name: "搜索 Agent" });
	await expect(search).toBeVisible();
	await expectSearchInput(search);
	await expectFieldLabel(page, page.locator("label", { hasText: "状态" }));
	await expectFieldControl(page, page.getByLabel("状态", { exact: true }));
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
		await expect(cards).toHaveCount(5);
		const tones = {
			green: await resolvedColor(page, "var(--success-ink)"),
			amber: await resolvedColor(page, "var(--warning-ink)"),
			gray: await resolvedColor(page, "var(--muted-foreground)"),
		};
		for (const [index, [, , label, tone]] of statusMatrix.entries()) {
			const card = cards.nth(index);
			const chips = card.locator('[data-slot="badge"][data-variant="chip"]');
			await expect(chips).toHaveText([label]);
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
		expect(api.unexpected).toEqual([]);
	});

	test("search empty state clears every filter and an empty directory has no clear action", async ({
		page,
	}) => {
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
});
