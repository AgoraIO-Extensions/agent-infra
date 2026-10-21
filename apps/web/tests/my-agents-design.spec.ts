import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import {
	deploymentConfiguration,
	pendingApplication,
} from "../src/features/my-agents/test-fixtures";
import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../src/pilot/generated-v2/types.gen";
import { expectNoDuplicateControls } from "./page-health";
import {
	computed,
	expectCleanPage,
	expectPageHeadTop,
	expectPointerButtons,
	expectSectionHeadTopAligned,
	resolved,
	textContrast,
	trackPageErrors,
} from "./primitive-styles";

// 我的 Agent、申请表单与申请详情按 OpenDesign #my-agents / #application-form /
// #application-detail 对齐后的浏览器回归（M-01~M-12、R4-11、F-09、N-03、N-11）。

const ownedAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);

const directoryRecords = [
	{
		kind: "user",
		canonicalId: "user-owner-1",
		displayName: "当前 Owner",
		email: "owner@example.test",
	},
	{
		kind: "user",
		canonicalId: "user-2",
		displayName: "验收用户二",
		email: "user.two@example.test",
		organizationPath: "平台工程",
	},
	{
		kind: "organization",
		canonicalId: "org-platform",
		displayName: "平台工程",
		organizationPath: "研发 / 平台工程",
	},
];

function application(
	overrides: Partial<AgentApplicationProjectionV2> = {},
): AgentApplicationProjectionV2 {
	return AgentApplicationProjectionV2Schema.parse({
		...pendingApplication,
		applicationId: "application-browser-1",
		...overrides,
	});
}

async function fixture(
	page: Page,
	input: {
		applications?: AgentApplicationProjectionV2[];
		agents?: AgentProjectionV2[];
	} = {},
) {
	const applications = input.applications ?? [application()];
	const agents = input.agents ?? [ownedAgent];
	const commands: string[] = [];
	const server = createPilotAgentMockServerV2({
		getCurrentSession: {
			status: 200,
			body: {
				schemaVersion: 1,
				user: {
					userId: "user-owner-1",
					displayName: "owner",
					roles: ["employee"],
				},
			},
		},
		getDeploymentConfiguration: { status: 200, body: deploymentConfiguration },
		listAgents: () => ({
			status: 200,
			body: { items: agents, nextCursor: null },
		}),
		getAgent: (request) => {
			const agentId = decodeURIComponent(
				new URL(request.url).pathname.split("/").at(-1) ?? "",
			);
			const found = agents.find((agent) => agent.agentId === agentId);
			return found
				? { status: 200, body: found }
				: {
						status: 404,
						body: {
							schemaVersion: 1,
							code: "RESOURCE_UNAVAILABLE",
							message: "Controlled unavailable Agent",
							retryable: false,
							traceId: "trace-agent-unavailable",
						},
					};
		},
		listAgentApplications: () => ({
			status: 200,
			body: { items: applications, nextCursor: null },
		}),
		getAgentApplication: (request) => {
			const applicationId = decodeURIComponent(
				new URL(request.url).pathname.split("/").at(-1) ?? "",
			);
			const found = applications.find(
				(item) => item.applicationId === applicationId,
			);
			return found
				? { status: 200, body: found }
				: {
						status: 404,
						body: {
							schemaVersion: 1,
							code: "RESOURCE_UNAVAILABLE",
							message: "Controlled unavailable application",
							retryable: false,
							traceId: "trace-application-unavailable",
						},
					};
		},
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() !== "GET") {
			commands.push(url.pathname);
			return route.fulfill({ status: 409, json: {} });
		}
		if (url.pathname === "/api/v1/connection/capability")
			return route.fulfill({
				json: ConnectionCapabilityProjectionV1Schema.parse({
					schemaVersion: 1,
					status: "unavailable",
					reason: "missing",
				}),
			});
		if (url.pathname === "/api/v2/me/conversations/recent")
			return route.fulfill({
				json: ConversationPageV1Schema.parse({ items: [], nextCursor: null }),
			});
		if (url.pathname === "/api/v2/directory/search") {
			const ids = url.searchParams.get("ids")?.split(",");
			const query = (url.searchParams.get("q") ?? "").toLowerCase();
			return route.fulfill({
				json: directorySearchResponse(
					url,
					directoryRecords.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							(!ids || ids.includes(item.canonicalId)) &&
							JSON.stringify(item).toLowerCase().includes(query),
					),
				),
			});
		}
		if (/\/wecom-(bot|app)$/.test(url.pathname))
			return route.fulfill({ json: { status: "not_configured" } });
		try {
			const response = await server.fetch(
				new Request(request.url(), {
					method: request.method(),
					headers: request.headers(),
				}),
			);
			await route.fulfill({
				status: response.status,
				contentType: "application/json",
				body: await response.text(),
			});
		} catch {
			// 本文件不覆盖的读取（如配置页的附属状态）一律按不可用处理。
			await route.fulfill({
				status: 404,
				json: {
					schemaVersion: 1,
					code: "RESOURCE_UNAVAILABLE",
					message: "Controlled unavailable resource",
					retryable: false,
					traceId: "trace-unavailable",
				},
			});
		}
	});
	return { commands };
}

async function noHorizontalOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
}

async function rect(locator: Locator) {
	const box = await locator.evaluate((element) => {
		const r = element.getBoundingClientRect();
		return {
			top: r.top + window.scrollY,
			bottom: r.bottom + window.scrollY,
			left: r.left,
			right: r.right,
		};
	});
	return box;
}

test("my Agent tabs keep the selected view in ?tab=owned across refresh, deep links and back (M-01)", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents");
	const applications = page.getByRole("tab", { name: "申请 1", exact: true });
	const owned = page.getByRole("tab", { name: "已创建", exact: true });
	await expect(applications).toHaveAttribute("aria-selected", "true");
	for (const tab of [applications, owned])
		expect(await computed(tab, ["fontSize", "fontWeight"])).toEqual({
			fontSize: "13px",
			fontWeight: "650",
		});
	const count = applications.locator('[data-slot="badge"]');
	await expect(count).toHaveText("1");
	await expect(count).toHaveAttribute("data-tone", "gray");
	await expect(count).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--muted-foreground)"),
	);
	// W-01：设计 .tab 内的 .chip 没有自己的字重，继承 Tab 的 650。
	await expect(count).toHaveCSS("font-weight", "650");

	await owned.click();
	await expect(page).toHaveURL(/\/my-agents\?tab=owned$/);
	await page.reload();
	await expect(owned).toHaveAttribute("aria-selected", "true");

	await page.goto("/my-agents?tab=foo");
	await expect(applications).toHaveAttribute("aria-selected", "true");

	await page.goto("/my-agents?tab=owned");
	await expect(owned).toHaveAttribute("aria-selected", "true");
	await page.getByRole("link", { name: /^配置与生命周期：/ }).click();
	await expect(page).toHaveURL(/\/agents\/agent-pilot-1\/configuration$/);
	await page.goBack();
	await expect(page).toHaveURL(/\/my-agents\?tab=owned$/);
	await expect(owned).toHaveAttribute("aria-selected", "true");

	// 方向键仍切换并激活 Tab，默认「申请」不写参数。
	await owned.focus();
	await page.keyboard.press("ArrowLeft");
	await expect(applications).toBeFocused();
	await expect(applications).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(/\/my-agents$/);
	await page.keyboard.press("ArrowRight");
	await expect(owned).toBeFocused();
	await expect(owned).toHaveAttribute("aria-selected", "true");
});

test("the approval-history notice follows the list inside the applications panel only (M-02 / NI-41)", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents");
	const panel = page.getByRole("tabpanel", { name: "申请 1" });
	const notice = panel.locator('[data-slot="alert"]', {
		hasText: "审批记录会保留",
	});
	await expect(notice).toBeVisible();
	const list = panel.getByRole("list", { name: "我的申请" });
	const gap = (await rect(notice)).top - (await rect(list)).bottom;
	expect(Math.abs(gap - 16)).toBeLessThanOrEqual(1);
	expect(
		await computed(notice, ["display", "columnGap", "padding", "fontSize"]),
	).toEqual({
		display: "flex",
		columnGap: "10px",
		padding: "13px 14px",
		fontSize: "13px",
	});
	const icon = notice.locator(":scope > svg");
	await expect(icon).toHaveAttribute("aria-hidden", "true");
	await expect(icon).toHaveCSS("width", "17px");
	const title = notice.locator("strong");
	await expect(title).toHaveText("审批记录会保留");
	await expect(title).toHaveCSS("font-weight", "650");
	await expect(notice).toContainText(
		"驳回后可以修改范围或模型，再次提交申请。",
	);
	// 静态说明：自身与祖先都没有 alert / status 角色。
	expect(
		await notice.evaluate(
			(element) => element.closest('[role="alert"], [role="status"]') === null,
		),
	).toBe(true);

	await page.getByRole("tab", { name: "已创建", exact: true }).click();
	await expect(page.getByText("审批记录会保留")).toHaveCount(0);
	await expect(
		page.getByRole("tabpanel").getByText("审批记录会保留"),
	).toHaveCount(0);
});

test("owned Agent cards use one status chip, 150px facts, 40px icon actions and hover (M-05 / M-04 / F-09)", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/my-agents?tab=owned");
	const card = page.locator(".owned-agent-card").first();
	await expect(card).toBeVisible();
	const chips = card.locator('.owned-card-heading [data-slot="badge"]');
	await expect(chips).toHaveCount(1);
	await expect(chips).toHaveText("启动中");
	await expect(chips).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--warning-ink)"),
	);
	await expect(page.locator("main")).not.toContainText("服务：");
	// W-03：设计 .card-head 里标识与标题组 align-items:center；状态 chip 仍在卡头顶部。
	const heading = card.locator(".owned-card-heading");
	const [mark, titleGroup, headingBox] = await Promise.all([
		rect(heading.locator('[data-slot="agent-mark"]')),
		rect(heading.locator(":scope > div").first()),
		rect(heading),
	]);
	expect(
		Math.abs(
			(mark.top + mark.bottom) / 2 - (titleGroup.top + titleGroup.bottom) / 2,
		),
	).toBeLessThanOrEqual(0.5);
	expect(
		Math.abs((await rect(chips)).top - headingBox.top),
	).toBeLessThanOrEqual(0.5);
	// W-04：设计 renderOwnedAgents 的渠道用「 · 」分隔。
	await expect(
		card.locator(".metadata-facts dt", { hasText: /^渠道$/ }).locator("+ dd"),
	).toHaveText("Web · 企微机器人");
	// M-04：可用范围按目录显示组织名，不出现内部 ID。
	await expect(card.locator(".metadata-facts")).toContainText("平台工程");
	await expect(page.locator("main")).not.toContainText("org-platform");
	const columns = (
		await computed(card.locator(".metadata-facts"), ["gridTemplateColumns"])
	).gridTemplateColumns.split(" ");
	if (info.project.name === "desktop") expect(columns[0]).toBe("150px");
	else expect(columns).toHaveLength(1);

	for (const name of ["配置与生命周期", "查看详情"]) {
		const action = card.getByRole("link", { name: new RegExp(`^${name}：`) });
		await expect(action).toHaveText(name);
		await expect(action).toHaveCSS("min-height", "40px");
		const icon = action.locator("svg");
		await expect(icon).toHaveCount(1);
		await expect(icon).toHaveCSS("width", "16px");
		await expect(icon).toHaveCSS("height", "16px");
	}
	await expect(page.getByText("配置与管理", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("tab", { name: "已创建 Agent" })).toHaveCount(0);

	if (info.project.name === "desktop") {
		const rest = await computed(card, ["borderTopColor", "boxShadow"]);
		await card.hover();
		await expect
			.poll(
				async () => (await computed(card, ["borderTopColor"])).borderTopColor,
			)
			.not.toBe(rest.borderTopColor);
		expect((await computed(card, ["boxShadow"])).boxShadow).not.toBe("none");
	}
	await noHorizontalOverflow(page);
});

test("long application lists render 20 rows and append the rest from the end (R4-11)", async ({
	page,
}) => {
	const many = Array.from({ length: 36 }, (_, index) =>
		application({
			applicationId: `application-bulk-${index + 1}`,
			name: `批量申请 ${index + 1}`,
		}),
	);
	await fixture(page, { applications: many });
	await page.goto("/my-agents");
	await expect(
		page.getByRole("tab", { name: "申请 36", exact: true }),
	).toBeVisible();
	const rows = page.locator(".application-row");
	await expect(rows).toHaveCount(20);
	const more = page.getByRole("button", { name: "显示更多申请（剩余 16）" });
	await more.click();
	await expect(rows).toHaveCount(36);
	await expect(page.getByRole("button", { name: /^显示更多申请/ })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("link", { name: "查看申请：批量申请 21", exact: true }),
	).toBeFocused();
});

test("application rows show a text title, one detail entrance and unique link names (R4-11 / M-03)", async ({
	page,
}) => {
	const second = AgentProjectionV2Schema.parse({
		...ownedAgent,
		agentId: "agent-pilot-second",
		name: "Second assistant",
	});
	await fixture(page, {
		applications: [
			application(),
			application({
				applicationId: "application-browser-2",
				agentId: "agent-pilot-1",
				name: "Created request",
				status: "available",
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: null },
			}),
			application({
				applicationId: "application-browser-3",
				name: "Rejected request",
				status: "rejected",
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: "范围过大" },
			}),
		],
		agents: [ownedAgent, second],
	});
	await page.goto("/my-agents");
	const rows = page.locator(".application-row");
	await expect(rows).toHaveCount(3);
	for (const row of await rows.all()) {
		await expect(row.locator("a h2")).toHaveCount(0);
		// 设计 .list-row strong：申请行标题 14px / 700。
		expect(
			await computed(row.locator("h2"), ["fontSize", "fontWeight"]),
		).toEqual({ fontSize: "14px", fontWeight: "700" });
		// F-02：模板 tag 为部署配置的显示名「Codex」，不显示原始 templateId。
		await expect(
			row.locator('[data-slot="badge"][data-variant="tag"]'),
		).toHaveText("Codex");
		const href = await row
			.getByRole("link", { name: /^查看申请：/ })
			.getAttribute("href");
		await expect(row.locator(`a[href="${href}"]`)).toHaveCount(1);
		const time = row.locator("time");
		await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
		await expect(time.locator("xpath=..")).toContainText(" · 更新于 ");
		// W-02：设计 .list-row 只有标题与「说明 · 更新于」两行，不再另起「申请人」行。
		const copy = row.locator(":scope > div").first();
		await expect(copy.locator(":scope > p")).toHaveCount(1);
		await expect(row).not.toContainText("申请人");
	}
	await expect(page.locator("main")).not.toContainText(
		/\d{4}-\d{2}-\d{2}T\d{2}:/,
	);
	const linkNames = async () =>
		page
			.locator("main a")
			.evaluateAll((links) =>
				links.map(
					(link) =>
						link.getAttribute("aria-label") ?? link.textContent?.trim() ?? "",
				),
			);
	const applicationsNames = await linkNames();
	expect(new Set(applicationsNames).size).toBe(applicationsNames.length);
	await page.getByRole("tab", { name: "已创建", exact: true }).click();
	await expect(page.locator(".owned-agent-card")).toHaveCount(2);
	const ownedNames = await linkNames();
	expect(new Set(ownedNames).size).toBe(ownedNames.length);
});

// M-08 / N-11 / NI-50：从「Agent 名称」逐次 Tab 到 footer 主按钮，焦点只向下（同一行从左到右）。
for (const expanded of [false, true]) {
	test(`application form tab order follows the visual order with advanced configuration ${expanded ? "expanded" : "collapsed"}`, async ({
		page,
	}) => {
		await fixture(page);
		await page.goto("/my-agents/new");
		const name = page.getByLabel("Agent 名称");
		await expect(name).toBeVisible();
		const toggle = page.getByRole("button", { name: /高级配置$/ });
		if (expanded) {
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		}
		// 分区的视觉顺序与 DOM 顺序一致，且不靠 CSS order。
		const sections = await page
			.locator(".application-form-fields > *")
			.evaluateAll((children) =>
				children.map((child) => ({
					order: getComputedStyle(child).order,
					title: child.matches(".form-footer")
						? "footer"
						: (child.querySelector("h2")?.textContent ?? child.tagName),
					top: child.getBoundingClientRect().top,
				})),
			);
		expect(sections.map((section) => section.title)).toEqual([
			"基本信息",
			"共同 Owner 与使用范围",
			"模型与推理",
			"高级配置",
			"footer",
		]);
		expect(new Set(sections.map((section) => section.order))).toEqual(
			new Set(["0"]),
		);
		for (let index = 1; index < sections.length; index++)
			expect(sections[index]?.top ?? 0).toBeGreaterThan(
				sections[index - 1]?.top ?? 0,
			);

		await name.focus();
		const steps: {
			label: string;
			top: number;
			left: number;
			inModel: boolean;
		}[] = [];
		for (let index = 0; index < 60; index++) {
			const step = await page.evaluate(() => {
				const element = document.activeElement as HTMLElement | null;
				if (!element) return null;
				const box = element.getBoundingClientRect();
				return {
					label:
						element.getAttribute("aria-label") ??
						(element.id
							? document.querySelector(`label[for="${element.id}"]`)
									?.textContent
							: null) ??
						element.textContent?.trim() ??
						element.tagName,
					top: Math.round(box.top + window.scrollY),
					left: Math.round(box.left),
					inModel: Boolean(element.closest(".application-model-section")),
				};
			});
			if (!step) break;
			steps.push(step);
			if (step.label === "提交审批") break;
			await page.keyboard.press("Tab");
		}
		expect(steps.at(-1)?.label).toBe("提交审批");
		for (let index = 1; index < steps.length; index++) {
			const previous = steps[index - 1];
			const current = steps[index];
			if (!previous || !current) continue;
			const sameRow = Math.abs(current.top - previous.top) <= 2;
			expect(
				sameRow ? current.left > previous.left : current.top > previous.top,
				`${previous.label} → ${current.label}`,
			).toBe(true);
		}
		const toggleIndex = steps.findIndex((step) =>
			step.label.endsWith("高级配置"),
		);
		expect(toggleIndex).toBeGreaterThan(0);
		expect(steps.some((step) => step.inModel)).toBe(true);
		expect(steps.slice(toggleIndex).some((step) => step.inModel)).toBe(false);
	});
}

test("application form footer, field errors, legends and option labels follow the design (M-06 / M-07 / M-09 / M-12)", async ({
	page,
}, info) => {
	await fixture(page);
	await page.goto("/my-agents/new");
	const footer = page.locator("main form .form-footer");
	expect(await computed(footer, ["paddingTop", "paddingBottom"])).toEqual({
		paddingTop: "20px",
		paddingBottom: "20px",
	});
	if (info.project.name === "mobile")
		expect(
			await computed(page.locator("main form .form-grid").first(), [
				"rowGap",
				"columnGap",
			]),
		).toEqual({ rowGap: "14px", columnGap: "14px" });
	// M-10：渠道分区与保存草稿待 PRD 决策（#2862）；主按钮按设计为「提交审批」，文字后带 16px 箭头。
	await expect(page.getByRole("heading", { name: "渠道" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /保存草稿/ })).toHaveCount(0);
	const submit = footer.getByRole("button", { name: "提交审批", exact: true });
	await expect(submit).toHaveText("提交审批");
	await expect(submit.locator("svg")).toHaveCSS("width", "16px");
	expect(
		await submit.evaluate(
			(button) => button.lastElementChild?.tagName.toLowerCase() ?? "",
		),
	).toBe("svg");
	await expect(footer.getByRole("button", { name: "提交申请" })).toHaveCount(0);

	await submit.click();
	const name = page.getByLabel("Agent 名称");
	await expect(name).toBeFocused();
	await expect(name).toHaveAttribute("aria-invalid", "true");
	const error = page.locator("#application-name-error");
	await expect(error).toHaveText("请输入 Agent 名称。");
	await expect(name).toHaveAttribute(
		"aria-describedby",
		"application-name-error",
	);
	await expect(error).toHaveAttribute("aria-live", "polite");
	expect(await computed(error, ["fontSize", "color", "marginTop"])).toEqual({
		fontSize: "12px",
		color: await resolved(page, "color", "var(--danger-ink)"),
		marginTop: "6px",
	});
	// 设计 .field gap 7px + .field-error margin-top 6px：错误顶边距输入框底边 13px。
	const errorGap = (await rect(error)).top - (await rect(name)).bottom;
	expect(Math.abs(errorGap - 13)).toBeLessThanOrEqual(1);

	// M-07：分区标题是 16px h2，字段组 legend 与字段标签同为 12px / 650 / muted。
	for (const title of ["基本信息", "共同 Owner 与使用范围", "模型与推理"])
		await expect(
			page.getByRole("heading", { level: 2, name: title, exact: true }),
		).toHaveCSS("font-size", "16px");
	await expect(
		page.getByRole("heading", { level: 2, name: "高级配置", exact: true }),
	).toHaveCSS("font-weight", "620");
	const muted = await resolved(page, "color", "var(--muted-foreground)");
	await page.getByRole("combobox", { name: "模型端点" }).click();
	await page.getByRole("option", { name: "Primary endpoint" }).click();
	await page.getByRole("combobox", { name: "模型", exact: true }).click();
	await page.getByRole("option", { name: "gpt-5" }).click();
	for (const legend of ["模型选项 1", "允许的推理档位"])
		expect(
			await computed(page.locator("legend", { hasText: legend }), [
				"fontSize",
				"fontWeight",
				"color",
			]),
		).toEqual({ fontSize: "12px", fontWeight: "650", color: muted });
	// 推理档位只显示中文（reasoningLevelLabel），原始枚举 medium / high 不进入页面。
	await expect(
		page.locator('.model-reasoning label[data-variant="option"]'),
	).toHaveText(["均衡", "高"]);
	// M-06：推理档位选项 13px / 400 / 前景色，至少 44px 高，复选框 18×18。
	const option = page.locator('label[data-variant="option"]', {
		hasText: "均衡",
	});
	expect(await computed(option, ["fontSize", "fontWeight", "color"])).toEqual({
		fontSize: "13px",
		fontWeight: "400",
		color: await resolved(page, "color", "var(--foreground)"),
	});
	expect((await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
	const box = await option.getByRole("checkbox").boundingBox();
	expect([box?.width, box?.height]).toEqual([18, 18]);
	expect(
		await computed(page.locator(".model-reasoning"), ["rowGap", "columnGap"]),
	).toEqual({ rowGap: "12px", columnGap: "22px" });

	await page.getByRole("button", { name: "展开高级配置" }).click();
	await page.getByRole("button", { name: "添加环境变量" }).click();
	await page.getByRole("button", { name: "添加 Secret" }).click();
	for (const legend of ["环境变量 1", "Secret 1"])
		expect(
			await computed(page.locator("legend", { hasText: legend }), [
				"fontSize",
				"fontWeight",
				"color",
			]),
		).toEqual({ fontSize: "12px", fontWeight: "650", color: muted });
	await noHorizontalOverflow(page);
});

// W-05 / W-07 / W-10：创建与修改申请共用的步骤条、分区说明与目录占位符按设计 #application-form。
for (const path of [
	"/my-agents/new",
	"/my-agents/application-browser-1/edit",
] as const) {
	test(`application form stepper, section copy and directory placeholders follow the design on ${path} (W-05 / W-07 / W-10)`, async ({
		page,
	}) => {
		await fixture(page);
		await page.goto(path);
		await expect(page.getByLabel("Agent 名称")).toBeVisible();
		const accentInk = await resolved(page, "color", "var(--accent-ink)");
		const active = page.locator(".form-stepper li.active");
		await expect(active).toHaveText("配置");
		await expect(active).toHaveCSS("color", accentInk);
		expect(
			await active.evaluate((element) => {
				const before = getComputedStyle(element, "::before");
				return [before.borderTopColor, before.color];
			}),
		).toEqual([accentInk, accentInk]);
		const description = (title: string) =>
			page
				.locator('section[data-slot="form-section"]', {
					has: page.getByRole("heading", { level: 2, name: title }),
				})
				.locator(':scope > [data-slot="form-section-description"]');
		await expect(description("基本信息")).toHaveText(
			"名称和描述会显示在 Agent 目录。",
		);
		await expect(description("共同 Owner 与使用范围")).toHaveText(
			"从目录选择人员和组织；提交时保存服务端 ID。",
		);
		await expect(description("模型与推理")).toHaveText(
			"这里只显示已部署且通过校验的模型。",
		);
		await expect(
			page.getByRole("combobox", { name: "可使用的用户" }),
		).toHaveAttribute("placeholder", "搜索姓名、邮箱或组织路径");
		await expect(
			page.getByRole("combobox", { name: "可使用的组织" }),
		).toHaveAttribute("placeholder", "搜索组织名称或路径");
		await noHorizontalOverflow(page);
	});
}

test("application detail puts actions in the heading, shows three progress rows and a next step (M-11 / M-12 / M-04)", async ({
	page,
}, info) => {
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [
			application({
				configuration: {
					...pendingApplication.configuration,
					availability: [
						{ kind: "user", userId: "user-2" },
						{ kind: "organization", organizationId: "org-platform" },
					],
				},
			}),
		],
	});
	await page.goto("/my-agents/application-browser-1");
	const heading = page.locator("main header.application-detail-heading");
	const h1 = heading.getByRole("heading", { level: 1 });
	await expect(h1).toHaveText(pendingApplication.name);
	// 可读编号待 #2861；在此之前 eyebrow 只写「申请详情」，不外露内部申请 ID。
	await expect(heading.locator(".page-eyebrow")).toHaveText("申请详情");
	await expect(page.locator("main")).not.toContainText("application-browser-1");
	const actions = heading.locator(":scope > .card-actions");
	const edit = actions.getByRole("link", { name: "修改申请" });
	const withdraw = actions.getByRole("button", { name: "撤回申请" });
	for (const action of [edit, withdraw])
		await expect(action).toHaveCSS("min-height", "40px");
	await expect(edit.locator("svg")).toHaveCSS("width", "16px");
	const [titleBox, actionsBox] = [await rect(h1), await rect(actions)];
	if (info.project.name === "desktop") {
		// 与 h1 同一 flex 行、位于右侧。
		expect(actionsBox.left).toBeGreaterThan(titleBox.right);
		expect(actionsBox.top).toBeLessThan(titleBox.bottom + 60);
	} else {
		expect(actionsBox.top).toBeGreaterThanOrEqual(titleBox.bottom);
	}
	const progress = page.getByRole("region", { name: "审批进度" });
	await expect(progress.getByRole("button")).toHaveCount(0);
	await expect(progress.getByRole("link")).toHaveCount(0);
	// #3037 X-05：窄屏审批进度标题区的状态 chip 与 h2 顶对齐（设计 ≤767px .section-head）。
	if (info.project.name === "mobile")
		await expectSectionHeadTopAligned(
			progress.getByRole("heading", { level: 2, name: "审批进度" }),
			progress.locator('.section-heading > [data-slot="badge"]'),
		);
	await expectCleanPage(page, pageErrors);
	const rows = progress.locator(".application-progress li");
	await expect(rows.locator("strong")).toHaveText([
		"申请已提交",
		"系统管理员审批",
		"创建 Agent",
	]);
	const first = rows.first().locator(':scope > [data-slot="badge"]');
	await expect(first).toHaveText("完成");
	await expect(first).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--success-ink)"),
	);
	// W-11：设计 .list-row:first-child 不命中进度首步（前面还有 .section-head），首步保留 15px 上内边距。
	await expect(rows.first()).toHaveCSS("padding-top", "15px");
	// W-12：设计 .list-row-main strong 为默认粗体 700。
	for (const title of await rows.locator("strong").all())
		await expect(title).toHaveCSS("font-weight", "700");
	// W-13：副标题与首步「提交时间 · 申请人」按设计 applicationProgress。
	await expect(progress.locator(".section-heading p")).toHaveText(
		"状态来自服务端事件",
	);
	await expect(rows.first().locator("small")).toHaveText(
		new RegExp(` · ${pendingApplication.applicant?.displayName}$`),
	);
	await expect(rows.first().locator("small time")).toHaveCount(1);

	const next = page.getByRole("region", { name: "下一步" });
	await expect(next).toContainText(
		"审批通过后，平台会创建长期运行实例并在完成健康检查后显示“就绪”。",
	);
	const directory = next.getByRole("link", { name: "查看 Agent 目录" });
	await expect(directory).toHaveAttribute("href", "/agents");
	await expect(directory).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(directory.locator("svg")).toHaveCSS("width", "16px");

	const facts = page.locator(".application-detail-aside .metadata-facts");
	const columns = (
		await computed(facts, ["gridTemplateColumns"])
	).gridTemplateColumns.split(" ");
	if (info.project.name === "desktop") expect(columns[0]).toBe("150px");
	else expect(columns).toHaveLength(1);
	// F-02 与设计 #application-detail：一行「来源 = 标准模板 · Codex」，不出现原始 templateId，
	// 也不再另列「标准模板」「入口模式」两行重复模板名。
	const source = facts.locator("dt", { hasText: /^来源$/ });
	await expect(source).toHaveCount(1);
	await expect(source.locator("+ dd")).toHaveText("标准模板 · Codex");
	await expect(facts.locator("dt", { hasText: /^入口模式$/ })).toHaveCount(0);
	await expect(facts.locator("dt", { hasText: /^标准模板$/ })).toHaveCount(0);
	await expect(facts).not.toContainText("codex");
	// M-04：使用范围按目录显示姓名、邮箱、组织名与路径，不出现内部 ID。
	await expect(facts).toContainText("验收用户二");
	await expect(facts).toContainText("user.two@example.test");
	await expect(facts).toContainText("研发 / 平台工程");
	await expect(page.locator("main")).not.toContainText(/user-2\b|org-platform/);
	await noHorizontalOverflow(page);
});

test("rejected application detail offers the resubmit action with an icon in the heading (M-11)", async ({
	page,
}) => {
	await fixture(page, {
		applications: [
			application({
				status: "rejected",
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: "范围过大" },
			}),
		],
	});
	await page.goto("/my-agents/application-browser-1");
	const resubmit = page
		.locator("main header.application-detail-heading")
		.getByRole("link", { name: "修改并重新提交" });
	await expect(resubmit).toHaveCSS("min-height", "40px");
	await expect(resubmit.locator("svg")).toHaveCount(1);
	await expect(resubmit.locator("svg")).toHaveCSS("width", "16px");
	const approval = page.locator(
		'.application-progress li[data-step="approval"] > [data-slot="badge"]',
	);
	await expect(approval).toHaveText("已驳回");
	await expect(approval).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--danger-ink)"),
	);
	await expect(
		page.locator(
			'.application-progress li[data-step="creation"] > [data-slot="badge"]',
		),
	).toHaveText("不再创建");
	await expect(page.getByRole("region", { name: "下一步" })).toContainText(
		"查看审批原因，修改后重新提交。",
	);
	// W-13：驳回提示标题按设计为「需要修改后重提」，原因仍取服务端投影。
	const reason = page.locator(".application-decision-reason");
	await expect(reason.locator('[data-slot="alert-title"]')).toHaveText(
		"需要修改后重提",
	);
	await expect(reason).toContainText("范围过大");
});

test("withdraw confirmation uses the design copy and keeps focus inside the dialog until it closes (W-16)", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/my-agents/application-browser-1");
	const withdraw = page.getByRole("button", { name: "撤回申请" });
	await withdraw.click();
	const dialog = page.getByRole("dialog", { name: "撤回这条申请？" });
	await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveText(
		"撤回后申请不会进入审批队列；你可以重新创建申请。",
	);
	await expect(dialog).not.toContainText(pendingApplication.name);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(withdraw).toBeFocused();
	await noHorizontalOverflow(page);
});

// N-21：每个页面只有一个导航链接是当前页；页内返回 / 取消链接不因前缀匹配被读成「当前页」。
test("my Agent routes mark only one navigation link as the current page (N-21)", async ({
	page,
}) => {
	await fixture(page);
	for (const [path, current] of [
		["/my-agents", "我的 Agent"],
		["/my-agents/new", "创建申请"],
		["/my-agents/application-browser-1", "我的 Agent"],
		["/my-agents/application-browser-1/edit", "我的 Agent"],
	] as const) {
		await page.goto(path);
		await expect(page.locator("main h1")).toBeVisible();
		await expect(page.locator("main a").first()).toBeVisible();
		await expect(page.locator('main a[aria-current="page"]')).toHaveCount(0);
		const links = page.locator('a[aria-current="page"]');
		await expect(links).toHaveCount(1);
		await expect(links).toHaveText(current);
	}
});

// 设计 .page-head-copy .eyebrow 上外边距为 0：我的 Agent 与创建申请页头的 h1 与设计同高（±1px）；
// 申请详情的 eyebrow 前面有返回链接，保留原有间距。
test("my Agent and application form page heads place the h1 at the design height", async ({
	page,
}, info) => {
	await fixture(page);
	const mobile = info.project.name === "mobile";
	await page.goto("/my-agents");
	await expect(
		page.getByRole("heading", { level: 1, name: "查看申请，管理名下 Agent。" }),
	).toBeVisible();
	await expectPageHeadTop(page, mobile);
	await page.goto("/my-agents/new");
	await expect(page.getByLabel("Agent 名称")).toBeVisible();
	// 设计 #application-form：h1「创建 Agent」；副标题为设计原文去掉「渠道」（随 #2862 M-10 决定）。
	const heading = page.locator("main .page-heading").first();
	await expect(heading.getByRole("heading", { level: 1 })).toHaveText(
		"创建 Agent",
	);
	await expect(heading.locator("h1 + p")).toHaveText(
		"填写使用场景，再配置 Owner、范围和模型。提交时会重新校验字段。",
	);
	await expectPageHeadTop(page, mobile);
	await page.goto("/my-agents/application-browser-1");
	const detail = page.locator("main header.application-detail-heading");
	await expect(detail.locator(".page-eyebrow")).toHaveText("申请详情");
	await expect(detail.locator(".page-eyebrow")).not.toHaveCSS(
		"margin-top",
		"0px",
	);
});

// #3040 AC-2：受影响页面在 1440×900 与 390×844 下没有横向溢出、控制台错误与同页同名控件。
test("my Agent pages have no overflow, console errors or duplicate controls at the acceptance viewports (#3040 AC-2)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [
			application(),
			application({
				applicationId: "application-browser-2",
				name: "Rejected request",
				status: "rejected",
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: "范围过大" },
			}),
		],
	});
	for (const [path, ready] of [
		["/my-agents", page.getByRole("list", { name: "我的申请" })],
		["/my-agents?tab=owned", page.locator(".owned-agent-card").first()],
		["/my-agents/new", page.getByLabel("Agent 名称")],
		["/my-agents/application-browser-1/edit", page.getByLabel("Agent 名称")],
		[
			"/my-agents/application-browser-1",
			page.getByRole("region", { name: "审批进度" }),
		],
		[
			"/my-agents/application-browser-2",
			page.locator(".application-decision-reason"),
		],
	] as const) {
		await page.goto(path);
		await expect(ready).toBeVisible();
		await expectCleanPage(page, pageErrors);
		await expectNoDuplicateControls(page, path);
	}
});

const createdApplication = () =>
	application({
		applicationId: "application-browser-2",
		agentId: "agent-pilot-1",
		name: "Created request",
		status: "available",
		decision: { decidedAt: "2026-09-03T10:00:00Z", reason: null },
	});

// #3128 B2-01：申请行「查看 Agent」与同列的「修改申请」同为 outline 按钮（设计按钮体系没有 link 变体）：
// --fg 文字、--border 描边、无下划线，13px / 650 文字对比度满足 WCAG AA 4.5:1（原 link 变体为 4.2:1）。
test("the application row's 查看 Agent is an outline action with AA contrast (B2-01)", async ({
	page,
}) => {
	await fixture(page, { applications: [application(), createdApplication()] });
	await page.goto("/my-agents");
	const view = page.getByRole("link", {
		name: "查看 Agent：Created request",
		exact: true,
	});
	await expect(view).toHaveAttribute("href", "/agents/agent-pilot-1");
	const edit = page.getByRole("link", { name: /^修改申请：/ });
	await expect(edit).toBeVisible();
	const properties = [
		"color",
		"borderTopColor",
		"borderTopWidth",
		"backgroundColor",
		"textDecorationLine",
		"fontSize",
		"fontWeight",
		"minHeight",
	] as const;
	const viewStyle = await computed(view, properties);
	expect(viewStyle).toEqual(await computed(edit, properties));
	expect(viewStyle).toMatchObject({
		color: await resolved(page, "color", "var(--foreground)"),
		borderTopColor: await resolved(page, "color", "var(--border)"),
		borderTopWidth: "1px",
		textDecorationLine: "none",
		fontSize: "13px",
		fontWeight: "650",
	});
	expect(await textContrast(view)).toBeGreaterThanOrEqual(4.5);
	// 悬停后仍满足 AA（outline 悬停为 --muted 背景、--fg 文字）。
	await view.hover();
	expect(await textContrast(view)).toBeGreaterThanOrEqual(4.5);
});

// #3128 B2-03：同一人员同时选入「共同 Owner 用户」与「可使用的用户」时，两个移除按钮的名称带各自的
// 选择器标签，同页没有同名控件；从一个选择器移除不影响另一个，焦点回到该选择器的输入框。
test("one person picked in two directory pickers gets distinct remove buttons (B2-03)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/my-agents/new");
	for (const label of ["共同 Owner 用户", "可使用的用户"]) {
		const picker = page.getByRole("combobox", { name: label, exact: true });
		await picker.fill("user.two");
		await expect(
			page.getByRole("option", { name: /验收用户二/ }),
		).toBeVisible();
		await picker.press("Enter");
		await expect(
			page.getByRole("button", {
				name: `从${label}移除 验收用户二`,
				exact: true,
			}),
		).toBeVisible();
		await picker.press("Escape");
		await expect(picker).toHaveAttribute("aria-expanded", "false");
	}
	await expect(
		page.getByRole("button", { name: /移除 验收用户二$/ }),
	).toHaveCount(2);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/new（同一人员在两个选择器）",
	);
	await page
		.getByRole("button", {
			name: "从共同 Owner 用户移除 验收用户二",
			exact: true,
		})
		.click();
	await expect(
		page.getByRole("combobox", { name: "共同 Owner 用户", exact: true }),
	).toBeFocused();
	await expect(
		page.getByRole("button", { name: /移除 验收用户二$/ }),
	).toHaveCount(1);
	await expect(
		page.getByRole("button", {
			name: "从可使用的用户移除 验收用户二",
			exact: true,
		}),
	).toBeVisible();
	await expectCleanPage(page, pageErrors);
});

// #3128 B2-11：设计稿全局 button{cursor:pointer}。我的 Agent 各页与撤回弹窗的按钮悬停为指针，
// 禁用按钮不是指针。
test("buttons on my Agent pages use the pointer cursor (B2-11)", async ({
	page,
}) => {
	await fixture(page, { applications: [application(), createdApplication()] });
	for (const [path, ready] of [
		["/my-agents", page.getByRole("list", { name: "我的申请" })],
		["/my-agents?tab=owned", page.locator(".owned-agent-card").first()],
		["/my-agents/new", page.getByLabel("Agent 名称")],
		["/my-agents/application-browser-1/edit", page.getByLabel("Agent 名称")],
		[
			"/my-agents/application-browser-1",
			page.getByRole("region", { name: "审批进度" }),
		],
	] as const) {
		await page.goto(path);
		await expect(ready).toBeVisible();
		await expectPointerButtons(page.locator("body"), path);
	}
	await page.getByRole("button", { name: "撤回申请" }).click();
	const dialog = page.getByRole("dialog", { name: "撤回这条申请？" });
	await expect(dialog).toBeVisible();
	await expectPointerButtons(dialog, "撤回弹窗");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
});
