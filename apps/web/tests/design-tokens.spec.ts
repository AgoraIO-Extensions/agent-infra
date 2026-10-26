import {
	ScopedPlatformAuditPageV2Schema,
	ScopedPlatformAuditProjectionV2Schema,
	SkillHubVersionDetailV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Page, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import { pendingApplication } from "../src/features/my-agents/test-fixtures";
import type { DeploymentConfigurationProjectionV2 } from "../src/pilot/generated-v2/types.gen";

// 设计 index.html（SHA-256 e4e074e5…6447）:root 的原始写法；颜色由浏览器解析后与实现比较。
const designColors = {
	"--bg": "oklch(0.975 0.008 95)",
	"--surface": "oklch(0.995 0.005 90)",
	"--surface-raised":
		"color-mix(in oklch, oklch(0.995 0.005 90) 90%, oklch(0.975 0.008 95))",
	"--fg": "oklch(0.23 0.02 255)",
	"--border": "oklch(0.88 0.018 95)",
	"--accent": "oklch(0.58 0.16 248)",
	"--accent-ink": "oklch(0.46 0.15 248)",
	"--muted-ink": "oklch(0.42 0.03 255)",
	"--accent-soft":
		"color-mix(in oklch, oklch(0.58 0.16 248) 11%, oklch(0.995 0.005 90))",
	"--success-ink": "oklch(0.45 0.12 145)",
	"--warning-ink": "oklch(0.49 0.11 82)",
	"--danger": "oklch(0.58 0.17 27)",
	"--danger-ink": "oklch(0.46 0.14 27)",
	// 设计 --muted 是文字色，main 对应 --muted-foreground。
	"--muted-foreground": "oklch(0.52 0.03 255)",
	"--secondary-foreground": "oklch(0.23 0.02 255)",
} as const;
const designFonts = {
	"--font-body":
		'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
	"--font-mono": 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
} as const;
const designShadow =
	"0 16px 40px color-mix(in oklch, oklch(0.23 0.02 255) 8%, transparent)";

const deploymentConfiguration: DeploymentConfigurationProjectionV2 = {
	modelCatalog: {
		endpoints: [
			{
				displayName: "Primary endpoint",
				endpointId: "endpoint-primary",
				models: [{ modelId: "gpt-5", reasoningLevels: ["medium", "high"] }],
			},
		],
		revision: "catalog-tokens",
		status: "populated",
	},
	schemaVersion: 2,
	status: "populated",
	templates: [
		{
			allowedEnvironmentKeys: ["LOG_LEVEL"],
			allowedSecretKeys: ["MODEL_API_KEY"],
			connectionEnabled: false,
			displayName: "Codex",
			templateId: "codex",
		},
	],
};
const skillVersion = SkillHubVersionMetadataV1Schema.parse({
	schemaVersion: 1,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	provider: "my_library",
	version: "1.2.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	name: "release-notes",
	visibility: "PRIVATE",
	state: "published",
});
const directory = [
	{
		kind: "user",
		canonicalId: "user-owner-1",
		displayName: "当前 Owner",
		email: "owner@example.test",
	},
	{
		kind: "organization",
		canonicalId: "org-platform",
		displayName: "平台工程",
		organizationPath: "研发 / 平台工程",
	},
];

async function tokenFixture(page: Page, role: "owner" | "admin" = "owner") {
	const userId = role === "owner" ? "user-owner-1" : "user-admin";
	const session = {
		schemaVersion: 1,
		user: {
			userId,
			displayName: role,
			roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
		},
	};
	const agent = pilotFakeScenariosV2.starting.response.body;
	const application = { ...pendingApplication, applicationId: "application-1" };
	const server = createPilotAgentMockServerV2({
		getCurrentSession: { status: 200, body: session },
		getDeploymentConfiguration: { status: 200, body: deploymentConfiguration },
		listAgents: { status: 200, body: { items: [agent], nextCursor: null } },
		getAgent: (_request, agentId) =>
			agentId === agent.agentId
				? { status: 200, body: agent }
				: {
						status: 404,
						body: {
							schemaVersion: 1,
							code: "RESOURCE_UNAVAILABLE",
							message: "Controlled unavailable Agent",
							retryable: false,
							traceId: "trace-tokens-agent",
						},
					},
		listAgentApplications: {
			status: 200,
			body: { items: [application], nextCursor: null },
		},
		getAgentApplication: { status: 200, body: application },
		listPendingAgentApplications: {
			status: 200,
			body: { items: [application], nextCursor: null },
		},
	});
	let releaseDirectory: (() => void) | undefined;
	let directoryGate: Promise<void> | undefined;
	await page.route(/\/api\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: { schemaVersion: 1, status: "unavailable", reason: "missing" },
			});
		if (path === "/api/v2/me/conversations/recent")
			return route.fulfill({ json: { items: [], nextCursor: null } });
		if (path === "/api/v2/directory/search") {
			await directoryGate;
			const ids = url.searchParams.get("ids")?.split(",");
			return route.fulfill({
				json: directorySearchResponse(
					url,
					directory.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							(!ids || ids.includes(item.canonicalId)),
					),
				),
			});
		}
		if (path.endsWith("/wecom-bot") || path.endsWith("/wecom-app"))
			return route.fulfill({ json: { status: "not_configured" } });
		// #2909：审计页读取带显示名的 V2 入口。
		if (path === "/api/v2/audit")
			return route.fulfill({
				json: ScopedPlatformAuditPageV2Schema.parse({
					items: [
						ScopedPlatformAuditProjectionV2Schema.parse({
							schemaVersion: 2,
							auditId: "audit-tokens",
							action: "task.api.access",
							actor: { kind: "user", actorId: userId, displayName: null },
							subject: {
								kind: "agent",
								subjectId: "agent-tokens",
								displayName: "编程助手",
							},
							result: "accepted",
							summary: "任务 API 访问获准",
							taskApi: {
								operation: "submit",
								phase: "access",
								reason: "request_accepted",
							},
							occurredAt: "2026-09-28T00:00:00.000Z",
							traceId: "trace-tokens",
							requestId: "request-tokens",
							agentId: "agent-tokens",
							conversationId: null,
							executionId: null,
							authorizationRecordId: null,
							originalPrincipal: null,
							executor: null,
							operation: null,
							agentDisplayName: "编程助手",
						}),
					],
					nextCursor: null,
				}),
			});
		if (
			path === `/api/v2/skills/versions/${skillVersion.skillVersionId}/detail`
		)
			// K-02：详情页读取版本详情投影（发布者、本人安装状态与有界正文）。
			return route.fulfill({
				json: SkillHubVersionDetailV1Schema.parse({
					...skillVersion,
					ownerId: "user-owner-1",
					installation: { state: "not_installed" },
					content: {
						state: "available",
						body: "# release-notes\n",
						bodyTruncated: false,
						resources: [
							{ path: "references/guide.md", kind: "reference", sizeBytes: 5 },
						],
					},
				}),
			});
		try {
			const response = await server.fetch(
				new Request(request.url(), {
					method: request.method(),
					headers: request.headers(),
					body: request.postData(),
				}),
			);
			return route.fulfill({
				status: response.status,
				contentType: "application/json",
				body: await response.text(),
			});
		} catch {
			// 样式用例不关心的旁路读取统一返回可重试失败，不影响被测元素。
			return route.fulfill({
				status: 503,
				json: {
					schemaVersion: 1,
					code: "DEPENDENCY_UNAVAILABLE",
					message: "Controlled token fixture gap",
					retryable: true,
					traceId: "trace-tokens-gap",
				},
			});
		}
	});
	return {
		holdDirectory() {
			directoryGate = new Promise((resolve) => {
				releaseDirectory = resolve;
			});
		},
		releaseDirectory() {
			releaseDirectory?.();
			directoryGate = undefined;
		},
	};
}

type TokenReport = Awaited<ReturnType<typeof measureTokens>>;

// 在页面内解析计算样式：颜色经 canvas 转成 sRGB 后计算 WCAG 对比度。
function measureTokens(page: Page) {
	return page.evaluate(
		({ colors, fonts, shadow }) => {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (!context) throw new Error("Missing canvas context");
			const rgba = (color: string) => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = "#000";
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(
					0,
					0,
					1,
					1,
				).data;
				return [r, g, b, a / 255] as const;
			};
			const resolveColor = (value: string) => {
				const probe = document.createElement("span");
				probe.style.color = value;
				document.body.append(probe);
				const resolved = getComputedStyle(probe).color;
				probe.remove();
				return resolved;
			};
			const oklch = (value: string) => {
				const parts = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+|none)\)$/.exec(value);
				if (!parts) throw new Error(`Unexpected color: ${value}`);
				return [
					Number(parts[1]),
					Number(parts[2]),
					parts[3] === "none" ? 0 : Number(parts[3]),
				];
			};
			const luminance = ([r, g, b]: readonly number[]) => {
				const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((channel = 0) => {
					const value = channel / 255;
					return value <= 0.03928
						? value / 12.92
						: ((value + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
			};
			const backgroundOf = (element: Element) => {
				const layers: (readonly [number, number, number, number])[] = [];
				for (
					let node: Element | null = element;
					node;
					node = node.parentElement
				) {
					const layer = rgba(getComputedStyle(node).backgroundColor);
					if (layer[3] > 0) layers.push(layer);
					if (layer[3] >= 1) break;
				}
				let result = [255, 255, 255];
				for (const [r, g, b, a] of layers.toReversed())
					result = [r, g, b].map(
						(channel, index) => channel * a + (result[index] ?? 0) * (1 - a),
					);
				return result;
			};
			const contrast = (color: string, element: Element) => {
				const [r, g, b, a] = rgba(color);
				const background = backgroundOf(element);
				const foreground = [r, g, b].map(
					(channel, index) => channel * a + (background[index] ?? 0) * (1 - a),
				);
				const [light, dark] = [luminance(foreground), luminance(background)]
					.toSorted((left, right) => right - left)
					.map((value) => value + 0.05);
				return (light ?? 1) / (dark ?? 1);
			};
			const visible = (selector: string) =>
				[...document.querySelectorAll(selector)].filter((node) => {
					const box = node.getBoundingClientRect();
					return (
						box.width > 0 &&
						box.height > 0 &&
						getComputedStyle(node).visibility !== "hidden"
					);
				});
			const root = getComputedStyle(document.documentElement);
			const fontProbe = document.createElement("span");
			fontProbe.style.fontFamily = "var(--font-mono)";
			document.body.append(fontProbe);
			const monoFamily = getComputedStyle(fontProbe).fontFamily;
			fontProbe.style.fontFamily = fonts["--font-mono"];
			const designMonoFamily = getComputedStyle(fontProbe).fontFamily;
			fontProbe.style.boxShadow = "var(--shadow)";
			const shadowValue = getComputedStyle(fontProbe).boxShadow;
			fontProbe.style.boxShadow = shadow;
			const designShadowValue = getComputedStyle(fontProbe).boxShadow;
			fontProbe.remove();
			const accentInk = resolveColor("var(--accent-ink)");
			const mutedInk = resolveColor("var(--muted-ink)");
			const textSample = (node: Element, color: string) => ({
				text: node.textContent?.trim().slice(0, 40) ?? "",
				color,
				contrast: contrast(color, node),
			});
			const h1 = visible("main h1").at(0);
			return {
				tokens: Object.fromEntries(
					Object.entries(colors).map(([name, design]) => [
						name,
						{
							actual: oklch(resolveColor(`var(${name})`)),
							design: oklch(resolveColor(design)),
						},
					]),
				),
				fonts: Object.fromEntries(
					Object.keys(fonts).map((name) => [
						name,
						root.getPropertyValue(name).trim(),
					]),
				),
				shadow: { actual: shadowValue, design: designShadowValue },
				monoFamily,
				designMonoFamily,
				accentInk,
				mutedInk,
				foreground: resolveColor("var(--foreground)"),
				danger: resolveColor("var(--danger-ink)"),
				h1: h1
					? {
							fontSize: getComputedStyle(h1).fontSize,
							letterSpacing: getComputedStyle(h1).letterSpacing,
							textWrapStyle: getComputedStyle(h1).textWrapStyle,
						}
					: null,
				monospaced: [
					...visible(
						".platform-nav-label, main :is(.page-eyebrow, .workbench-eyebrow, .directory-eyebrow, .conversation-eyebrow, [data-slot='table-head'], .font-mono)",
					).map((node) => ({
						selector:
							node.getAttribute("data-slot") ??
							node.className.toString().slice(0, 60),
						fontFamily: getComputedStyle(node).fontFamily,
					})),
					...visible("main .form-stepper li").map((node) => ({
						selector: "form-stepper li::before",
						fontFamily: getComputedStyle(node, "::before").fontFamily,
					})),
				],
				eyebrows: visible(
					"main :is(.page-eyebrow, .workbench-eyebrow, .directory-eyebrow, .conversation-eyebrow)",
				).map((node) => textSample(node, getComputedStyle(node).color)),
				// 目录 chip 移除钮复用 Button 但按设计为透明图标按钮，不属于主操作。
				primaryButtons: visible(
					"main :is([data-slot='button'], a[class~='group/button']).bg-accent-ink:not(.directory-chip-remove)",
				).map((node) => ({
					...textSample(node, getComputedStyle(node).color),
					background: getComputedStyle(node).backgroundColor,
					border: getComputedStyle(node).borderTopColor,
				})),
				destructiveButtons: visible("main .bg-danger-ink").map(
					(node) => getComputedStyle(node).backgroundColor,
				),
				placeholders: visible(
					"main :is(input, textarea)[placeholder]:placeholder-shown",
				).map((node) =>
					textSample(node, getComputedStyle(node, "::placeholder").color),
				),
				selectPlaceholders: visible(
					"main [data-slot='select-trigger'][data-placeholder]",
				).map((node) => textSample(node, getComputedStyle(node).color)),
				helpTexts: visible(
					"main :is(.directory-help, .directory-help span, .application-form .field-help)",
				).map((node) => textSample(node, getComputedStyle(node).color)),
				// 带 data-status / data-result 的 Badge 由状态 chip 规则着色（chip tone 不属于本用例）。
				secondaryTexts: visible(
					"main .text-secondary-foreground:not([data-status], [data-result])",
				).map((node) => getComputedStyle(node).color),
				neutralGrayTexts: visible("body *")
					.filter(
						(node) =>
							[...node.childNodes].some(
								(child) =>
									child.nodeType === Node.TEXT_NODE &&
									child.textContent?.trim(),
							) && getComputedStyle(node).color === "oklch(0.205 0 0)",
					)
					.map((node) => node.textContent?.trim().slice(0, 40)),
			};
		},
		{ colors: designColors, fonts: designFonts, shadow: designShadow },
	);
}

function expectInk(report: TokenReport) {
	for (const [name, { actual, design }] of Object.entries(report.tokens)) {
		actual.forEach((value, index) => {
			expect(value, `${name}[${index}]`).toBeCloseTo(design[index] ?? 0, 2);
		});
	}
	expect(report.fonts).toEqual(designFonts);
	expect(report.shadow.actual).toBe(report.shadow.design);
	expect(report.monoFamily).toBe(report.designMonoFamily);
	for (const item of report.monospaced)
		expect(item.fontFamily, item.selector).toBe(report.monoFamily);
	expect(report.eyebrows.length).toBeGreaterThan(0);
	for (const item of [...report.eyebrows, ...report.primaryButtons])
		expect(item.contrast, item.text).toBeGreaterThanOrEqual(4.5);
	for (const item of report.eyebrows)
		expect(item.color, item.text).toBe(report.accentInk);
	for (const item of report.primaryButtons) {
		expect(item.background, item.text).toBe(report.accentInk);
		expect(item.border, item.text).toBe(report.accentInk);
	}
	for (const background of report.destructiveButtons)
		expect(background).toBe(report.danger);
	for (const item of [
		...report.placeholders,
		...report.selectPlaceholders,
		...report.helpTexts,
	]) {
		expect(item.color, item.text).toBe(report.mutedInk);
		expect(item.contrast, item.text).toBeGreaterThanOrEqual(4.5);
	}
	for (const color of report.secondaryTexts)
		expect(color).toBe(report.foreground);
	expect(report.neutralGrayTexts).toEqual([]);
}

async function renderedFontFamilies(page: Page, selector: string) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("DOM.enable");
	await cdp.send("CSS.enable");
	const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
	const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
		nodeId: root.nodeId,
		selector,
	});
	const families: string[] = [];
	for (const nodeId of nodeIds) {
		const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", {
			nodeId,
		});
		families.push(...fonts.map((font) => font.familyName));
	}
	await cdp.detach();
	return families;
}

// primary 为设计点名、必须落在 --accent-ink 上的主操作；skill 页按设计 .skill-page h1 例外不收紧字距。
const pages = [
	{
		route: "/",
		role: "owner",
		ready: ["link", "新建对话"],
		primary: "新建对话",
	},
	{
		route: "/agents/agent-pilot-1",
		role: "owner",
		ready: ["link", "Owner 配置"],
	},
	{
		route: "/agents/agent-pilot-1/configuration",
		role: "owner",
		// 页脚唯一的 primary 按设计改为「保存配置」（RK2-08）。
		ready: ["button", "保存配置"],
		primary: "保存配置",
	},
	{ route: "/admin/approvals", role: "admin", ready: ["button", /^审阅：/] },
	{ route: "/audit", role: "owner", ready: ["button", /^详情：/] },
	{
		route: "/my-agents/new",
		role: "owner",
		ready: ["button", "提交审批"],
		primary: "提交审批",
	},
	// K-02：详情不再列出摘要卡，以 Tab 出现作为就绪信号。
	{
		route: "/skills/release-notes-v1",
		role: "owner",
		ready: ["tab", "用途与内容"],
		skill: true,
	},
] as const;

for (const entry of pages) {
	const { route, role, ready } = entry;
	const primary = "primary" in entry ? entry.primary : undefined;
	const skill = "skill" in entry;
	test(`design tokens, ink colors and monospace stack on ${route}`, async ({
		page,
	}, info) => {
		test.skip(
			info.project.name !== "desktop",
			"The token matrix sets both design viewports itself.",
		);
		await tokenFixture(page, role);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto(route);
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
		if (ready)
			await expect(
				page.getByRole(ready[0], { name: ready[1] }).first(),
			).toBeVisible();
		else await expect(page.locator("main dd.font-mono").first()).toBeVisible();
		for (const [viewport, fontSize] of [
			[{ width: 1440, height: 900 }, 38],
			[{ width: 390, height: 844 }, 30],
		] as const) {
			await page.setViewportSize(viewport);
			const report = await measureTokens(page);
			await info.attach(`tokens-${route}-${viewport.width}`, {
				body: JSON.stringify(report, null, 2),
				contentType: "application/json",
			});
			if (skill)
				// Chromium 把 letter-spacing: 0 的计算值序列化为 normal；Skill 页字号不属于本用例。
				expect(report.h1).toMatchObject({
					letterSpacing: "normal",
					textWrapStyle: "pretty",
				});
			else
				expect(report.h1).toEqual({
					fontSize: `${fontSize}px`,
					letterSpacing: `${-fontSize / 100}px`,
					textWrapStyle: "pretty",
				});
			expectInk(report);
			if (primary)
				expect(report.primaryButtons.map((item) => item.text)).toContain(
					primary,
				);
			if (viewport.width >= 1024)
				expect(
					report.monospaced.some((item) =>
						item.selector.includes("platform-nav-label"),
					),
				).toBe(true);
			const families = await renderedFontFamilies(
				page,
				".platform-nav-label, main :is(.page-eyebrow, .workbench-eyebrow, [data-slot='table-head'], dd.font-mono)",
			);
			expect(families.length).toBeGreaterThan(0);
			expect(families.filter((family) => /courier/i.test(family))).toEqual([]);
		}
	});
}

test("primary actions, steppers, directory help and table heads use the expected tokens", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop design viewport only.");
	await tokenFixture(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/my-agents/new");
	await expect(page.getByLabel("Agent 名称", { exact: true })).toBeVisible();
	const report = await measureTokens(page);
	expect(report.primaryButtons.map((item) => item.text)).toContain("提交审批");
	expect(
		report.monospaced.filter(
			(item) => item.selector === "form-stepper li::before",
		),
	).toHaveLength(4);
	expect(report.helpTexts.map((item) => item.text)).toEqual(
		expect.arrayContaining([
			"已选 0 项 · Enter 添加",
			// W-07：「使用场景」帮助文字，main 与导出稿（#3107 回写）一致。
			"不填写模型内部思考或外部凭证。",
		]),
	);
	expect(report.placeholders.length).toBeGreaterThan(0);

	await page.goto("/audit");
	await expect(
		page.locator("main [data-slot='table-head']").first(),
	).toBeVisible();
	const audit = await measureTokens(page);
	expect(
		audit.monospaced.filter((item) => item.selector.includes("table-head")),
	).not.toHaveLength(0);
	expectInk(audit);
});

test("conversation heading keeps zero tracking while its eyebrow uses ink and mono", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop design viewport only.");
	await tokenFixture(page);
	await page.goto("/chat/agent-missing");
	const heading = page.locator(".conversation-header h1");
	await expect(heading).toHaveText("对话");
	// Chromium 把 letter-spacing: 0 的计算值序列化为 normal。
	expect(
		await heading.evaluate((node) => getComputedStyle(node).letterSpacing),
	).toBe("normal");
	const report = await measureTokens(page);
	expect(report.eyebrows.map((item) => item.text)).toEqual(["工作区 / 对话"]);
	expectInk(report);
});

test("select option highlight keeps the muted background after the accent remap", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop design viewport only.");
	await tokenFixture(page);
	await page.goto("/my-agents/new");
	await page.getByRole("combobox", { name: "Agent 来源" }).click();
	const option = page.locator('[data-slot="select-item"]:focus');
	await expect(option).toHaveCount(1);
	const colors = await option.evaluate((node) => {
		const probe = document.createElement("span");
		probe.style.backgroundColor = "var(--muted)";
		probe.style.color = "var(--foreground)";
		document.body.append(probe);
		const expected = getComputedStyle(probe);
		const result = {
			background: getComputedStyle(node).backgroundColor,
			color: getComputedStyle(node).color,
			expectedBackground: expected.backgroundColor,
			expectedColor: expected.color,
		};
		probe.remove();
		return result;
	});
	expect(colors.background).toBe(colors.expectedBackground);
	expect(colors.color).toBe(colors.expectedColor);
});

test("reduced motion compresses every transition and animation duration", async ({
	page,
}, info) => {
	test.skip(info.project.name !== "desktop", "Desktop design viewport only.");
	const api = await tokenFixture(page);
	await page.goto("/agents/agent-pilot-1/configuration");
	await expect(
		page.getByRole("button", { name: "保存配置", exact: true }),
	).toBeVisible();
	const durations = () =>
		page.evaluate(() => ({
			nav: getComputedStyle(
				document.querySelector(".platform-nav-item") ?? document.body,
			).transitionDuration,
			buttons: [...document.querySelectorAll("main [data-slot='button']")].map(
				(node) => getComputedStyle(node).transitionDuration,
			),
			scroll: getComputedStyle(document.documentElement).scrollBehavior,
		}));
	const normal = await durations();
	expect(normal.nav).not.toBe("1e-06s");
	// 按钮过渡：背景 / 边框 / 文字 .18s，按下位移 .06s（primitives B-15 按设计稿拆分）。
	expect(normal.buttons).toContain("0.18s, 0.18s, 0.18s, 0.06s");
	// 目录读取挂起时，加载指示器是页面上真实存在的动画元素。
	api.holdDirectory();
	await page.getByRole("combobox", { name: "共同 Owner 用户" }).click();
	// format 流把读取中 / 无结果等状态移出 listbox（listbox 只承载结果），这里等待读取中状态出现。
	await expect(
		page
			.locator("#main-content")
			.getByRole("status")
			.filter({ hasText: "正在读取目录" }),
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					[...document.querySelectorAll("*")].filter(
						(node) => getComputedStyle(node).animationName !== "none",
					).length,
			),
		)
		.toBeGreaterThan(0);

	await page.emulateMedia({ reducedMotion: "reduce" });
	const reduced = await durations();
	expect(reduced.nav.split(", ").every((value) => value === "1e-06s")).toBe(
		true,
	);
	expect(reduced.buttons.length).toBeGreaterThan(0);
	expect(
		reduced.buttons.every((value) =>
			value.split(", ").every((item) => item === "1e-06s"),
		),
	).toBe(true);
	expect(reduced.scroll).toBe("auto");
	// 所有元素与伪元素（含带 transition-* / animate-* 工具类的组件）的时长都被压缩；
	// 无限加载指示器是否停转由 Spinner 组件决定，这里不断言动画名。
	const uncompressed = await page.evaluate(() =>
		[...document.querySelectorAll("*")].flatMap((node) =>
			[null, "::before", "::after"].flatMap((pseudo) => {
				const style = getComputedStyle(node, pseudo);
				return [style.animationDuration, style.transitionDuration]
					.flatMap((value) => value.split(", "))
					.filter((value) => value !== "1e-06s")
					.map(
						(value) =>
							`${node.tagName.toLowerCase()}.${node.getAttribute("class") ?? ""}${pseudo ?? ""}: ${value}`,
					);
			}),
		),
	);
	expect(uncompressed).toEqual([]);
	api.releaseDirectory();
});
