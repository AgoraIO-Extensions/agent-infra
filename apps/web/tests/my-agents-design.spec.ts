import {
	AgentApplicationProjectionV2Schema,
	AgentDefaultRelayKeyDisplayCandidatesV2Schema,
	AgentProjectionV2Schema,
	ConnectionCapabilityProjectionV1Schema,
	ConversationPageV1Schema,
	DeploymentConfigurationProjectionV2Schema,
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
	AgentCreationFailureCategoryV1,
	AgentProjectionV2,
	DeploymentConfigurationProjectionV2,
} from "../src/pilot/generated-v2/types.gen";
import {
	expectFocusableBusy,
	expectFocusSettled,
	expectFocusUnobscured,
	expectNoDuplicateControls,
	expectStickyTopbarClearance,
	holdRequests,
	pinElement,
	scrollTopTo,
	topbarClearance,
} from "./page-health";
import {
	computed,
	expectCleanPage,
	expectPageHeadTop,
	expectPointerButtons,
	expectPublicFieldError,
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
		/** 服务端给出的创建失败类别（#3034）；未设置时接口按不可读处理。 */
		creationFailure?: AgentCreationFailureCategoryV1;
		/** 部署选项；未设置时用单端点、单模型的 test-fixtures 投影。 */
		deployment?: DeploymentConfigurationProjectionV2;
		/** 设置时 Agent 已有默认 Relay Key，「检查可用模型」返回这些候选（#2421）。 */
		defaultRelayKeyCandidates?: {
			endpointId: string;
			modelId: string;
			displayName: string;
			reasoningLevels: string[];
		}[];
	} = {},
) {
	const applications = input.applications ?? [application()];
	const agents = input.agents ?? [ownedAgent];
	const { creationFailure, defaultRelayKeyCandidates } = input;
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
		getDeploymentConfiguration: {
			status: 200,
			body: input.deployment ?? deploymentConfiguration,
		},
		...(defaultRelayKeyCandidates
			? {
					getAgentDefaultRelayKey: {
						status: 200,
						body: {
							schemaVersion: 1,
							isSet: true,
							keyVersion: 2,
							configurationRevision: 7,
						},
					},
				}
			: {}),
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
		getAgentCreationFailure: (_request, agentId) =>
			creationFailure
				? {
						status: 200,
						body: { schemaVersion: 1, agentId, category: creationFailure },
					}
				: {
						status: 404,
						body: {
							schemaVersion: 1,
							code: "RESOURCE_UNAVAILABLE",
							message: "Controlled unavailable creation failure",
							retryable: false,
							traceId: "trace-creation-failure-unavailable",
						},
					},
	});
	await page.route(/\/api\/v[12]\//, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (
			defaultRelayKeyCandidates &&
			request.method() === "POST" &&
			url.pathname.endsWith("/default-relay-key/display-candidates")
		)
			return route.fulfill({
				json: AgentDefaultRelayKeyDisplayCandidatesV2Schema.parse({
					schemaVersion: 2,
					configurationRevision: 7,
					candidates: defaultRelayKeyCandidates,
				}),
			});
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
		// 分区的视觉顺序与 DOM 顺序一致，且不靠 CSS order。#3242 K7-02：页脚移到 fieldset 之后
		// （提交进行中字段由 fieldset 禁用，提交按钮仍可聚焦），仍紧跟在高级配置之后。
		const sections = await page
			.locator(
				".application-form-fields > *, .application-form-fields + .form-footer",
			)
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
	await page
		.getByRole("combobox", { name: "模型：模型选项 1", exact: true })
		.click();
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

// #3329 N10-3-02：申请表单整表校验失败后，焦点从页底「提交审批」到页顶「Agent 名称」。「Agent 名称」原本
// 整框在 72px 吸顶顶栏之下时，浏览器把它当作可见、不再滚动，焦点目标被顶栏盖住；根样式 scroll-padding-top
// 让出顶栏后它停在顶栏之下。从下一个控件 Shift+Tab 回到被顶栏遮住的「Agent 名称」同样如此。两档视口都
// 覆盖（WCAG 2.2 SC 2.4.11）。
test("application form field errors and Shift+Tab keep Agent 名称 below the sticky topbar (N10-3-02)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/my-agents/new");
	const name = page.getByLabel("Agent 名称");
	const submit = page
		.locator("main form .form-footer")
		.getByRole("button", { name: "提交审批", exact: true });
	await expect(name).toBeVisible();
	// 前置状态：「Agent 名称」整框在顶栏之下（与 Skill「创建项目」证据相同，视口内但被顶栏盖住），焦点在
	// 页底「提交审批」上（不滚动页面）。
	const before = await scrollTopTo(name, 0);
	expect(before.top, "「Agent 名称」先在顶栏之下").toBeGreaterThanOrEqual(-1);
	expect(before.bottom, "「Agent 名称」先在顶栏之下").toBeLessThanOrEqual(
		before.barBottom,
	);
	await submit.evaluate((element) =>
		(element as HTMLElement).focus({ preventScroll: true }),
	);
	await page.keyboard.press("Enter");
	await expect(name).toHaveAttribute("aria-invalid", "true");
	await expectFocusUnobscured(name, "提交审批校验失败后");
	await info.attach("n10-3-02-application-form", {
		body: await page.screenshot(),
		contentType: "image/png",
	});

	// 键盘：焦点移到下一个控件后把「Agent 名称」滚到顶栏之下（被盖住 30px），再 Shift+Tab 回来。
	await page.keyboard.press("Tab");
	await expect(name).not.toBeFocused();
	const bar = await topbarClearance(name);
	const at = await scrollTopTo(name, bar.barBottom - 30);
	expect(at.top, "「Agent 名称」被顶栏遮住").toBeLessThan(at.barBottom);
	await page.keyboard.press("Shift+Tab");
	await expectFocusUnobscured(name, "Shift+Tab 回到 Agent 名称");
	await expectStickyTopbarClearance(page);
	await expectCleanPage(page, errors);
});

// #3329 N10-3-02：「跳至主要内容」（页内锚点）同样让出吸顶顶栏：激活后 #main-content 获得焦点、页面 h1 整行在
// 顶栏之下（原先 #main-content 贴视口顶边，h1 被顶栏盖住）。顶栏里的控件随顶栏吸顶、始终可见，页面滚动后
// 聚焦窄屏「打开导航」不滚动页面（让位规则不把它当作被顶栏挡住）。
test("the skip link and topbar controls stay clear of the sticky topbar without moving the page (N10-3-02)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await viewportFor(page, mobile);
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/my-agents/new");
	const main = page.locator("#main-content");
	const heading = main.getByRole("heading", { level: 1 });
	const skip = page.locator(".platform-skip-link");
	await expect(heading).toBeVisible();
	const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
	for (const scrolled of [0, 600]) {
		await page.evaluate((top) => window.scrollTo(0, top), scrolled);
		await expect.poll(scrollY).toBe(scrolled);
		// 跳转链接是 fixed 定位，聚焦它不滚动页面。
		await skip.focus();
		await expect(skip).toBeFocused();
		expect(await scrollY()).toBe(scrolled);
		await page.keyboard.press("Enter");
		await expect(main).toBeFocused();
		await heading.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(resolve)),
		);
		const box = await topbarClearance(heading);
		expect(box.barTop, `滚动 ${scrolled}px 后跳转：顶栏位置`).toBe(0);
		expect(
			box.top,
			`滚动 ${scrolled}px 后跳转：h1 在顶栏之下`,
		).toBeGreaterThanOrEqual(box.barBottom);
		// #main-content 紧接顶栏，让出顶栏后就是页顶。
		expect(await scrollY(), `滚动 ${scrolled}px 后跳转：回到页顶`).toBe(0);
	}
	if (mobile) {
		const menu = page.getByRole("button", { name: "打开导航" });
		for (const scrolled of [600, 1000]) {
			await page.evaluate((top) => window.scrollTo(0, top), scrolled);
			await expect.poll(scrollY).toBe(scrolled);
			await menu.focus();
			await expect(menu).toBeFocused();
			await menu.evaluate(
				() => new Promise((resolve) => requestAnimationFrame(resolve)),
			);
			expect(await scrollY(), `滚动 ${scrolled}px 后聚焦「打开导航」`).toBe(
				scrolled,
			);
			const box = await topbarClearance(menu);
			expect(box.top).toBeGreaterThanOrEqual(box.barTop);
			expect(box.bottom).toBeLessThanOrEqual(box.barBottom);
		}
	}
	await expectCleanPage(page, errors);
});

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
	// M-04：使用范围按目录显示名称，不出现内部 ID。G4-16：与 Owner 行一样只写名称（「、」分隔），
	// 不再附邮箱与组织路径（导出稿 #application-detail 只写「支持中心」）。
	await expect(facts).toContainText("验收用户二");
	await expect(
		facts.locator("dt", { hasText: /^使用范围$/ }).locator("+ dd"),
	).toHaveText("验收用户二、平台工程");
	await expect(facts).not.toContainText("user.two@example.test");
	await expect(facts).not.toContainText("研发 / 平台工程");
	await expect(page.locator("main")).not.toContainText(/user-2\b|org-platform/);
	// E3-03：「资源预设」卡按设计 .application-resource p{margin:12px 0 0}，末段到卡底只有
	// 20px 内边距 + 1px 边框；`.form-aside p` 的 12px 下外边距不再叠加。
	const resource = page.locator(
		".application-detail-aside .application-resource",
	);
	await expect(resource.locator("h2")).toHaveText("资源预设");
	const resourceParagraphs = resource.locator("p");
	await expect(resourceParagraphs).toHaveCount(3);
	for (const paragraph of await resourceParagraphs.all())
		await expect(paragraph).toHaveCSS("margin", "12px 0px 0px");
	const [lastParagraph, resourceBox] = [
		await rect(resourceParagraphs.last()),
		await rect(resource),
	];
	expect(resourceBox.bottom - lastParagraph.bottom).toBeCloseTo(21, 1);
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
	// E3-04：全站 Alert danger 默认图标为设计 icon('alert') 三角形，尺寸与颜色不变（17px、--danger）。
	const icon = reason.locator(":scope > svg");
	await expect(icon).toHaveClass(/lucide-triangle-alert/);
	await expect(icon).toHaveCSS("width", "17px");
	await expect(icon).toHaveCSS("height", "17px");
	await expect(icon).toHaveCSS(
		"color",
		await resolved(page, "color", "var(--danger)"),
	);
});

// #3152 AC-1：创建失败提示与驳回原因同是审批进度卡片内的提示，上边框距最后一个进度步骤 18px
// （设计 #application-detail 两处提示都是 margin-top:18px），1440×900 与 390×844 一致。
test("a failed creation notice sits 18px below the last progress step like the rejection reason (#3152 AC-1)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	await fixture(page, {
		applications: [
			application({
				agentId: ownedAgent.agentId,
				status: "creation_failed",
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: null },
			}),
			application({
				applicationId: "application-browser-2",
				status: "rejected",
				decision: { decidedAt: "2026-09-03T10:00:00Z", reason: "范围过大" },
			}),
		],
		creationFailure: "health_check_failed",
	});
	const progress = page.getByRole("region", { name: "审批进度" });
	const lastStep = progress.locator(".application-progress li").last();
	const gapBelowLastStep = async (notice: Locator) => {
		await expect(notice).toBeVisible();
		const [step, box] = [await rect(lastStep), await rect(notice)];
		return box.top - step.bottom;
	};

	await page.goto("/my-agents/application-browser-1");
	const failure = progress.locator(
		'[data-creation-failure="health_check_failed"]',
	);
	await expect(failure).toContainText("失败原因：健康检查未通过");
	await expect(lastStep).toHaveAttribute("data-step", "creation");
	expect(await gapBelowLastStep(failure)).toBeCloseTo(18, 1);

	await page.goto("/my-agents/application-browser-2");
	expect(
		await gapBelowLastStep(progress.locator(".application-decision-reason")),
	).toBeCloseTo(18, 1);
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

type HeldFrames = { hold: boolean; release: () => void };

// #3154：选中后的焦点交还在下一帧执行。帧回调被推迟（高负载或节流）、焦点已移到别的控件时，
// 原选择器不能把焦点和结果层抢回去；这里在页面内接管 rAF，把推迟的帧放到焦点移走之后执行。
test("a deferred focus frame does not pull focus back from the next directory picker (#3154)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	await page.addInitScript(() => {
		const request = window.requestAnimationFrame.bind(window);
		const cancel = window.cancelAnimationFrame.bind(window);
		const held = new Map<number, FrameRequestCallback>();
		let lastHeldId = 0;
		const frames: HeldFrames = {
			hold: false,
			release() {
				frames.hold = false;
				const callbacks = [...held.values()];
				held.clear();
				for (const callback of callbacks) callback(performance.now());
			},
		};
		Object.assign(window, { __heldFrames: frames });
		window.requestAnimationFrame = (callback) => {
			if (!frames.hold) return request(callback);
			// 推迟的帧用负数 ID，与浏览器分配的 ID 区分。
			lastHeldId -= 1;
			held.set(lastHeldId, callback);
			return lastHeldId;
		};
		window.cancelAnimationFrame = (frameId) => {
			if (!held.delete(frameId)) cancel(frameId);
		};
	});
	const frames = (action: "hold" | "release") =>
		page.evaluate((next) => {
			const control = (window as unknown as { __heldFrames: HeldFrames })
				.__heldFrames;
			if (next === "hold") control.hold = true;
			else control.release();
		}, action);
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/my-agents/new");
	const owners = page.getByRole("combobox", {
		name: "共同 Owner 用户",
		exact: true,
	});
	const users = page.getByRole("combobox", {
		name: "可使用的用户",
		exact: true,
	});
	const candidate = page.getByRole("option", { name: /验收用户二/ });
	const removeFromOwners = page.getByRole("button", {
		name: "从共同 Owner 用户移除 验收用户二",
		exact: true,
	});
	// Issue 中的时序：选中后 Esc 收起，再去填第二个选择器，推迟的帧最后才执行。
	await owners.fill("user.two");
	await expect(candidate).toBeVisible();
	await frames("hold");
	await owners.press("Enter");
	await expect(removeFromOwners).toBeVisible();
	await owners.press("Escape");
	await expect(owners).toHaveAttribute("aria-expanded", "false");
	await users.fill("user.two");
	await expect(candidate).toBeVisible();
	await frames("release");
	await expect(users).toBeFocused();
	await expect(users).toHaveAttribute("aria-expanded", "true");
	await expect(owners).toHaveAttribute("aria-expanded", "false");
	await expect(candidate).toBeVisible();
	await users.press("Enter");
	await expect(
		page.getByRole("button", {
			name: "从可使用的用户移除 验收用户二",
			exact: true,
		}),
	).toBeVisible();
	await users.press("Escape");
	// 焦点在另一个选择器时点移除钮（按下不抢焦点）：原选择器收不到 focusout、不会取消帧，
	// 只能在帧执行时发现焦点已移到别的控件，放弃聚焦并收起。
	await frames("hold");
	await removeFromOwners.click();
	await expect(removeFromOwners).toHaveCount(0);
	await expect(owners).toHaveAttribute("aria-expanded", "true");
	const agentName = page.getByLabel("Agent 名称");
	await agentName.focus();
	await frames("release");
	await expect(agentName).toBeFocused();
	await expect(owners).toHaveAttribute("aria-expanded", "false");
	await expect(users).toHaveAttribute("aria-expanded", "false");
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

async function viewportFor(page: Page, mobile: boolean) {
	await page.setViewportSize(
		mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
	);
}

// #3179 G4-09 / G4-10 / G4-11：公共 Tab 同行等高，选中下划线贴在 1px 分隔线上，「申请」与计数 chip
// 相距一个空格宽（0.25em）；已创建卡「配置与生命周期」为齿轮图标，可用范围用「 · 」分隔（同 W-04）。
test("my Agent tabs share one height and a space-wide count gap; owned cards use the gear and a middle-dot scope (G4-09 / G4-10 / G4-11)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	const agent = AgentProjectionV2Schema.parse({
		...ownedAgent,
		configuration: {
			...ownedAgent.configuration,
			availability: [
				{ kind: "organization", organizationId: "org-platform" },
				{ kind: "user", userId: "user-2" },
			],
		},
	});
	await fixture(page, { agents: [agent] });
	for (const path of ["/my-agents", "/my-agents?tab=owned"]) {
		await page.goto(path);
		const list = page.getByRole("tablist", { name: "我的 Agent 视图" });
		const tabs = list.getByRole("tab");
		await expect(tabs.first().locator('[data-slot="badge"]')).toHaveText("1");
		const [listBox, first, second, selected] = await Promise.all([
			list.boundingBox(),
			tabs.nth(0).boundingBox(),
			tabs.nth(1).boundingBox(),
			list.locator('[role="tab"][aria-selected="true"]').boundingBox(),
		]);
		if (!listBox || !first || !second || !selected)
			throw new Error("Missing tab geometry");
		expect(Math.abs(first.height - second.height)).toBeLessThanOrEqual(0.5);
		// 选中 Tab 的 2px 下划线底边贴在分隔线（列表 1px 下边框）上，没有缝。
		expect(
			Math.abs(selected.y + selected.height - (listBox.y + listBox.height - 1)),
		).toBeLessThanOrEqual(0.5);
	}
	const applications = page.getByRole("tab", { name: /^申请/ });
	await expect(applications).toHaveCSS("column-gap", "3.25px");
	const gap = await applications.evaluate((tab) => {
		const text = [...tab.childNodes].find(
			(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
		);
		const chip = tab.querySelector('[data-slot="badge"]');
		if (!text || !chip) return Number.NaN;
		const range = document.createRange();
		range.selectNodeContents(text);
		return (
			chip.getBoundingClientRect().left - range.getBoundingClientRect().right
		);
	});
	expect(Math.abs(gap - 3.25)).toBeLessThanOrEqual(0.5);

	const card = page.locator(".owned-agent-card").first();
	const configure = card.getByRole("link", { name: /^配置与生命周期：/ });
	const icon =
		(await configure.locator("svg").getAttribute("class"))?.split(/\s+/) ?? [];
	expect(icon).toContain("lucide-settings");
	expect(icon).not.toContain("lucide-settings-2");
	await expect(
		card
			.locator(".metadata-facts dt", { hasText: /^可用范围$/ })
			.locator("+ dd"),
	).toHaveText("平台工程 · 验收用户二");
	await expectNoDuplicateControls(
		page,
		"/my-agents?tab=owned（G4-09 ~ G4-11）",
	);
	await expectCleanPage(page, pageErrors);
	await noHorizontalOverflow(page);
});

// #3179 G4-12 / G4-13：多服务来源的文件输入帮助按公共字段帮助（11px / 1.65 / --muted-ink），与 YAML
// 文本框同在一个字段内、相距 7px；目录选择器结果项的「人 / 组」标记顶对齐，邮箱与组织路径 400。
test("multi-service YAML help and directory results follow the design field styles (G4-12 / G4-13)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/my-agents/new");
	await page.getByRole("combobox", { name: "Agent 来源" }).click();
	await page
		.getByRole("option", { name: "多服务 Agent · 自有交互入口" })
		.click();
	const help = page.getByText(
		"上传受限 Kubernetes 资源清单，或直接粘贴 YAML；最多 262,144 bytes。",
		{ exact: true },
	);
	expect(await computed(help, ["fontSize", "lineHeight", "color"])).toEqual({
		fontSize: "11px",
		lineHeight: "18.15px",
		color: await resolved(page, "color", "var(--muted-ink)"),
	});
	const manifest = page.getByRole("textbox", { name: "多服务资源 YAML 内容" });
	const [helpBox, manifestBox] = await Promise.all([
		help.boundingBox(),
		manifest.boundingBox(),
	]);
	if (!helpBox || !manifestBox) throw new Error("Missing field geometry");
	expect(
		Math.abs(manifestBox.y - (helpBox.y + helpBox.height) - 7),
	).toBeLessThanOrEqual(0.5);

	const picker = page.getByRole("combobox", {
		name: "共同 Owner 用户",
		exact: true,
	});
	await picker.fill("user.two");
	const option = page.getByRole("option", { name: /验收用户二/ });
	await expect(option).toBeVisible();
	const [optionBox, markBox] = await Promise.all([
		option.boundingBox(),
		option.locator(".directory-result-mark").boundingBox(),
	]);
	if (!optionBox || !markBox) throw new Error("Missing option geometry");
	// 项顶 1px 边框 + 9px 内边距：标记距项顶 10px，不随两行文字垂直居中。
	expect(Math.abs(markBox.y - optionBox.y - 10)).toBeLessThanOrEqual(0.5);
	await expect(option.locator(".directory-result-name")).toHaveCSS(
		"font-weight",
		"650",
	);
	for (const meta of await option.locator(".directory-result-meta").all())
		await expect(meta).toHaveCSS("font-weight", "400");
	await picker.press("Escape");
	await expectNoDuplicateControls(
		page,
		"/my-agents/new 多服务来源（G4-12 / G4-13）",
	);
	await expectCleanPage(page, pageErrors);
	await noHorizontalOverflow(page);
});

// #3179 G4-15 / G4-16：申请详情「申请配置」的镜像地址等宽；使用范围与 Owner 行一样只写名称，
// 不再逐项附组织路径。
test("application detail shows the image in monospace and the scope as one line of names (G4-15 / G4-16)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await viewportFor(page, mobile);
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [
			application({
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:v1",
					interactionMode: "platform-adapter",
				},
				configuration: {
					...pendingApplication.configuration,
					availability: [
						{ kind: "organization", organizationId: "org-platform" },
					],
				},
			}),
		],
	});
	await page.goto("/my-agents/application-browser-1");
	const summary = page.getByRole("region", { name: "申请配置摘要" });
	const fact = (label: string) =>
		summary
			.locator(".metadata-facts dt", { hasText: new RegExp(`^${label}$`) })
			.locator("+ dd");
	await expect(fact("镜像地址")).toHaveText(
		"registry.example/agents/release:v1",
	);
	const fonts = await fact("镜像地址").evaluate((element) => {
		const probe = document.createElement("span");
		probe.style.fontFamily = "var(--font-mono)";
		document.body.append(probe);
		const mono = getComputedStyle(probe).fontFamily;
		probe.remove();
		return { actual: getComputedStyle(element).fontFamily, mono };
	});
	expect(fonts.actual).toBe(fonts.mono);
	await expect(fact("使用范围")).toHaveText("平台工程");
	await expect(fact("使用范围").locator("li")).toHaveCount(0);
	await expect(summary).not.toContainText("研发 / 平台工程");
	if (mobile) {
		// 单列事实列表：使用范围与 Owner 行的 dt→dd 间距相同（设计 3px）。
		const dtToDd = async (label: string) => {
			const [dt, dd] = await Promise.all([
				summary
					.locator(".metadata-facts dt", { hasText: new RegExp(`^${label}$`) })
					.boundingBox(),
				fact(label).boundingBox(),
			]);
			if (!dt || !dd) throw new Error("Missing fact geometry");
			return dd.y - (dt.y + dt.height);
		};
		expect(Math.abs((await dtToDd("使用范围")) - 3)).toBeLessThanOrEqual(0.5);
		expect(Math.abs((await dtToDd("Owner")) - 3)).toBeLessThanOrEqual(0.5);
	}
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id 申请详情（G4-15 / G4-16）",
	);
	await expectCleanPage(page, pageErrors);
	await noHorizontalOverflow(page);
});

// #3206：两个端点各一个模型、档位相同，第二行可选与第一行不同的模型，档位复选框仍同名。
const twoEndpointDeployment = DeploymentConfigurationProjectionV2Schema.parse({
	...deploymentConfiguration,
	modelCatalog: {
		...deploymentConfiguration.modelCatalog,
		endpoints: [
			...deploymentConfiguration.modelCatalog.endpoints,
			{
				endpointId: "endpoint-secondary",
				displayName: "Secondary endpoint",
				models: [
					{ modelId: "gpt-5-mini", reasoningLevels: ["medium", "high"] },
				],
			},
		],
	},
});

async function pick(page: Page, combobox: string, option: string) {
	await page.getByRole("combobox", { name: combobox, exact: true }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

// #3206 AC-1 / AC-3：创建与修改申请添加多个模型选项、多行环境变量与 Secret 后，行内控件的可访问名称
// 带上所在行的 legend（「{可见文字}：模型选项 N」「{可见文字}：环境变量 N」「{可见文字}：Secret N」，
// D2-58），可见文字不变，#main-content 没有同角色同名控件。
for (const path of [
	"/my-agents/new",
	"/my-agents/application-browser-1/edit",
] as const) {
	test(`multiple model options, environment rows and Secret rows have distinct control names on ${path} (#3206 AC-1)`, async ({
		page,
	}, info) => {
		await viewportFor(page, info.project.name === "mobile");
		const pageErrors = trackPageErrors(page);
		await fixture(page, { deployment: twoEndpointDeployment });
		await page.goto(path);
		await expect(page.getByLabel("Agent 名称")).toBeVisible();
		if (path === "/my-agents/new") await pick(page, "标准模板", "Codex");
		else await page.getByRole("checkbox", { name: "修改模型配置" }).click();

		await pick(page, "模型端点：模型选项 1", "Primary endpoint");
		await pick(page, "模型：模型选项 1", "gpt-5");
		await page.getByRole("button", { name: "添加模型选项" }).click();
		await pick(page, "模型端点：模型选项 2", "Secondary endpoint");
		await pick(page, "模型：模型选项 2", "gpt-5-mini");
		for (const row of ["模型选项 1", "模型选项 2"])
			for (const level of ["均衡", "高"]) {
				const checkbox = page.getByRole("checkbox", {
					name: `${level}：${row}`,
					exact: true,
				});
				await checkbox.click();
				await expect(checkbox).toBeChecked();
			}
		// 可见文字不变：档位仍只显示中文名，移除按钮仍为「移除模型选项」。
		const secondRow = page.locator(".model-option-fieldset").nth(1);
		await expect(
			secondRow.locator('.model-reasoning label[data-variant="option"]'),
		).toHaveText(["均衡", "高"]);
		const removeModel = page.getByRole("button", {
			name: "移除模型选项：模型选项 2",
			exact: true,
		});
		await expect(removeModel).toHaveText("移除模型选项");
		await expect(
			page.getByRole("button", {
				name: "移除模型选项：模型选项 1",
				exact: true,
			}),
		).toBeVisible();

		await page.getByRole("button", { name: "展开高级配置" }).click();
		for (let index = 0; index < 2; index += 1) {
			await page.getByRole("button", { name: "添加环境变量" }).click();
			await page.getByRole("button", { name: "添加 Secret" }).click();
		}
		for (const row of [1, 2]) {
			await page
				.getByRole("textbox", {
					name: `变量名称：环境变量 ${row}`,
					exact: true,
				})
				.fill(`SYNTHETIC_${row}`);
			await page
				.getByRole("textbox", { name: `变量值：环境变量 ${row}`, exact: true })
				.fill("synthetic-value");
			await expect(
				page.getByRole("button", {
					name: `移除环境变量：环境变量 ${row}`,
					exact: true,
				}),
			).toHaveText("移除环境变量");
			await pick(page, `Secret 名称：Secret ${row}`, "MODEL_API_KEY");
			await expect(
				page.getByLabel(`替换值：Secret ${row}`, { exact: true }),
			).toHaveAttribute("type", "password");
			await expect(
				page.getByRole("button", {
					name: `移除 Secret：Secret ${row}`,
					exact: true,
				}),
			).toHaveText("移除 Secret");
		}
		// 字段标签的可见文字不变。
		await expect(page.locator("label", { hasText: /^变量名称$/ })).toHaveCount(
			2,
		);
		await expect(
			page.locator("label", { hasText: /^Secret 名称$/ }),
		).toHaveCount(2);

		await expectCleanPage(page, pageErrors);
		await expectNoDuplicateControls(page, `${path}（多行，#3206）`);
		await noHorizontalOverflow(page);

		// 移除第二个模型选项后只剩一行，不再有「移除模型选项」；移除第一行环境变量后，原第二行
		// 重新编号为「环境变量 1」，名称随 legend 更新，仍不重名。
		await removeModel.click();
		await expect(
			page.getByRole("button", { name: /^移除模型选项/ }),
		).toHaveCount(0);
		await page
			.getByRole("button", { name: "移除环境变量：环境变量 1", exact: true })
			.click();
		await expect(
			page.getByRole("textbox", { name: "变量名称：环境变量 1", exact: true }),
		).toHaveValue("SYNTHETIC_2");
		await expectNoDuplicateControls(page, `${path}（移除后，#3206）`);
	});
}

// #3206 AC-1：由默认 Key 管理模型的修改申请里，「检查可用模型」后勾选两个模型，各自的档位复选框
// 名称带上所属模型，没有同名控件。
test("checked Key candidates in an application edit have distinct level names (#3206 AC-1)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [application({ agentId: "agent-pilot-1" })],
		defaultRelayKeyCandidates: [
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				displayName: "gpt-5",
				reasoningLevels: ["medium", "high"],
			},
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5-mini",
				displayName: "gpt-5-mini",
				reasoningLevels: ["medium", "high"],
			},
		],
	});
	await page.goto("/my-agents/application-browser-1/edit");
	await page.getByRole("checkbox", { name: "修改模型配置" }).click();
	await page
		.getByLabel("Agent 默认 Relay Key", { exact: true })
		.fill("synthetic-relay-key");
	await page.getByRole("button", { name: "检查可用模型" }).click();
	// 需求变化（#3215 G5-12 / #3212）：候选按部署目录显示「{端点显示名} · {模型}」、档位只显示中文名，
	// 原来的「endpoint-primary · …」「medium：…」不再出现；档位名称仍带所属模型（#3206 规则不变）。
	for (const model of ["gpt-5", "gpt-5-mini"])
		await page
			.getByRole("checkbox", {
				name: `Primary endpoint · ${model}`,
				exact: true,
			})
			.click();
	for (const model of ["gpt-5", "gpt-5-mini"])
		for (const level of ["均衡", "高"])
			await expect(
				page.getByRole("checkbox", {
					name: `${level}：Primary endpoint · ${model}`,
					exact: true,
				}),
			).toBeChecked();
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id/edit（默认 Key 候选，#3206）",
	);
	await noHorizontalOverflow(page);
});

// #3242 K7-02：修改申请「检查可用模型」读取中是可聚焦的禁用（aria-disabled），键盘 Enter 后挂起期间
// 多次采样焦点都在按钮上；候选出现后焦点仍在按钮上，不落到 body。
test("checking a Key's available models keeps focus on the pending button (K7-02)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [application({ agentId: "agent-pilot-1" })],
		defaultRelayKeyCandidates: [
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				displayName: "gpt-5",
				reasoningLevels: ["medium", "high"],
			},
		],
	});
	await page.goto("/my-agents/application-browser-1/edit");
	await page.getByRole("checkbox", { name: "修改模型配置" }).click();
	await page
		.getByLabel("Agent 默认 Relay Key", { exact: true })
		.fill("synthetic-relay-key");
	const check = await pinElement(
		page.getByRole("button", { name: "检查可用模型" }),
		"check-models",
	);
	const checking = await holdRequests(
		page,
		"POST",
		/\/default-relay-key\/display-candidates$/,
	);
	await check.focus();
	await page.keyboard.press("Enter");
	await expect(check).toHaveText("正在检查…");
	await expectFocusableBusy(check, "检查可用模型");
	expect(checking.held()).toBe(1);
	checking.release();
	await expect(
		page.getByRole("checkbox", {
			name: "Primary endpoint · gpt-5",
			exact: true,
		}),
	).toBeVisible();
	await expect(check).toHaveText("检查可用模型");
	await expectFocusSettled(check, "检查可用模型");
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id/edit（检查可用模型，K7-02）",
	);
	await expectCleanPage(page, pageErrors);
	await noHorizontalOverflow(page);
});

// #3215 G5-05 / G5-06 / G5-07：标准模板下的模板就绪列表上距 8px（下拉底到列表首行 15px，设计
// .template-readiness）；目录选择器已选 chip 的移除图标 14px（icon('x',14)），命中区仍 44px；
// 「清空搜索」字重 400（设计 .directory-clear 不是 .btn），仍为 11px、--primary。
test("template readiness spacing, directory chip remove icon and clear-search weight follow the design (G5-05 / G5-06 / G5-07)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/my-agents/new");
	const readiness = page.getByRole("list", { name: "模板就绪状态" });
	await expect(readiness).toBeVisible();
	await expect(readiness).toHaveCSS("margin-top", "8px");
	const [templateBox, readinessBox] = await Promise.all([
		page.locator("#application-template-id").boundingBox(),
		readiness.boundingBox(),
	]);
	if (!templateBox || !readinessBox)
		throw new Error("Missing template geometry");
	expect(
		Math.abs(readinessBox.y - (templateBox.y + templateBox.height) - 15),
	).toBeLessThanOrEqual(0.5);

	const picker = page.getByRole("combobox", {
		name: "共同 Owner 用户",
		exact: true,
	});
	await picker.fill("user.two");
	const clear = page.getByRole("button", { name: "清空搜索", exact: true });
	await expect(clear).toBeVisible();
	expect(
		await computed(clear, ["fontWeight", "fontSize", "color", "minHeight"]),
	).toEqual({
		fontWeight: "400",
		fontSize: "11px",
		color: await resolved(page, "color", "var(--primary)"),
		minHeight: "44px",
	});
	await page.getByRole("option", { name: /验收用户二/ }).click();
	const remove = page.getByRole("button", {
		name: "从共同 Owner 用户移除 验收用户二",
		exact: true,
	});
	await expect(remove).toBeVisible();
	const [removeBox, iconBox] = await Promise.all([
		remove.boundingBox(),
		remove.locator("svg").boundingBox(),
	]);
	if (!removeBox || !iconBox) throw new Error("Missing chip remove geometry");
	expect(iconBox).toMatchObject({ width: 14, height: 14 });
	expect(removeBox).toMatchObject({ width: 44, height: 44 });
	await picker.press("Escape");
	await expectNoDuplicateControls(
		page,
		"/my-agents/new 模板就绪、目录 chip 与清空搜索（G5-05 ~ G5-07）",
	);
	await expectCleanPage(page, pageErrors);
	await noHorizontalOverflow(page);
});

// #3215 G5-12（#3212）：修改申请「检查可用模型」后的候选与默认项按 H4-12 / RK2-01 显示：端点用部署目录
// 显示名，推理档位与默认档位只显示中文名，页面不出现原始端点 ID 与档位枚举；提交的选项 ID、端点、
// 模型与档位仍是原始值。
test("default-Key candidates in an application edit show endpoint display names and Chinese levels (G5-12)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [application({ agentId: "agent-pilot-1" })],
		defaultRelayKeyCandidates: [
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				displayName: "gpt-5",
				reasoningLevels: ["medium", "high"],
			},
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5-mini",
				displayName: "gpt-5-mini",
				reasoningLevels: ["medium"],
			},
		],
	});
	// 记录修改申请的请求体（fixture 仍按 409 拒绝写入）。
	const submitted: unknown[] = [];
	await page.route(/\/api\/v2\/agent-applications\//, async (route) => {
		if (route.request().method() !== "GET")
			submitted.push(route.request().postDataJSON());
		await route.fallback();
	});
	await page.goto("/my-agents/application-browser-1/edit");
	await page.getByRole("checkbox", { name: "修改模型配置" }).click();
	await page
		.getByLabel("Agent 默认 Relay Key", { exact: true })
		.fill("synthetic-relay-key");
	await page.getByRole("button", { name: "检查可用模型" }).click();
	// 需求变化（#3268 N8-2-05）：与 Owner 配置共用模型选择器，模型列表组名为「允许的模型」，
	// 默认项是单个「默认模型选项」（{模型} · {档位}），不再拆成「默认模型」「默认推理档位」两个下拉。
	const picker = page.getByRole("group", { name: "允许的模型" });
	await expect(picker).toBeVisible();
	const pickerRoot = page.locator("#application-keyless-model");
	const mini = picker.getByRole("checkbox", {
		name: "Primary endpoint · gpt-5-mini",
		exact: true,
	});
	await mini.click();
	await expect(mini).toBeChecked();
	await expect(
		picker.getByRole("checkbox", {
			name: "均衡：Primary endpoint · gpt-5-mini",
			exact: true,
		}),
	).toBeChecked();
	const gpt5 = picker.getByRole("checkbox", {
		name: "Primary endpoint · gpt-5",
		exact: true,
	});
	if (!(await gpt5.isChecked())) await gpt5.click();
	await expect(
		picker.getByRole("checkbox", {
			name: "高：Primary endpoint · gpt-5",
			exact: true,
		}),
	).toBeVisible();
	const defaultOption = pickerRoot.getByLabel("默认模型选项", { exact: true });
	await expect(
		pickerRoot.getByLabel("默认推理档位", { exact: true }),
	).toHaveCount(0);
	const optionTexts = (select: Locator) =>
		select
			.locator("option")
			.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
	expect(await optionTexts(defaultOption)).toEqual([
		"Primary endpoint · gpt-5 · 高",
		"Primary endpoint · gpt-5 · 均衡",
		"Primary endpoint · gpt-5-mini · 均衡",
	]);
	// 原始端点 ID 与档位枚举不进入页面（可见文字与可访问名称）。
	const text = await pickerRoot.innerText();
	expect(text).not.toMatch(/endpoint-primary|\bmedium\b|\bhigh\b/);
	expect(await pickerRoot.ariaSnapshot()).not.toMatch(
		/endpoint-primary|\bmedium\b|\bhigh\b/,
	);
	await defaultOption.selectOption({
		label: "Primary endpoint · gpt-5 · 均衡",
	});
	await page.getByRole("button", { name: "修改申请", exact: true }).click();
	await expect.poll(() => submitted.length).toBe(1);
	const body = submitted[0] as {
		modelConfiguration: {
			options: {
				optionId: string;
				endpointId: string;
				modelId: string;
				reasoningLevels: string[];
			}[];
			defaultOptionId: string;
			defaultReasoningLevel: string;
		};
	};
	expect(
		body.modelConfiguration.options.map(
			({ optionId, endpointId, modelId, reasoningLevels }) => ({
				optionId,
				endpointId,
				modelId,
				reasoningLevels: [...reasoningLevels].sort(),
			}),
		),
	).toEqual([
		{
			optionId: "endpoint-primary:gpt-5",
			endpointId: "endpoint-primary",
			modelId: "gpt-5",
			reasoningLevels: ["high", "medium"],
		},
		{
			optionId: "endpoint-primary:gpt-5-mini",
			endpointId: "endpoint-primary",
			modelId: "gpt-5-mini",
			reasoningLevels: ["medium"],
		},
	]);
	expect(body.modelConfiguration.defaultOptionId).toBe(
		"endpoint-primary:gpt-5",
	);
	expect(body.modelConfiguration.defaultReasoningLevel).toBe("medium");
	expect(JSON.stringify(body)).not.toMatch(/Primary endpoint|均衡/);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id/edit（默认 Key 候选显示名，G5-12）",
	);
	await noHorizontalOverflow(page);
});

// #3268 N8-2-05：修改申请「默认 Key 管理模型」检查成功但没有可用模型时，给出与 Owner 配置一致的 warn
// 提示；拦截文案说明「没有可用模型」，不再要求用户「先点击检查」；拦截错误为公共 FieldError。
// 有候选时选择器与 Owner 配置同一个：说明 13px、单个「默认模型选项」。两视口一致。
test("a checked Key without usable models is explained and blocks with a matching message (#3268 N8-2-05)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [application({ agentId: "agent-pilot-1" })],
		defaultRelayKeyCandidates: [],
	});
	await page.goto("/my-agents/application-browser-1/edit");
	await page.getByRole("checkbox", { name: "修改模型配置" }).click();
	const keyInput = page.getByLabel("Agent 默认 Relay Key", { exact: true });
	await keyInput.fill("synthetic-relay-key");
	const check = page.getByRole("button", { name: "检查可用模型" });
	await check.click();
	const notice = page
		.locator('#main-content [data-slot="alert"][data-tone="warn"]')
		.filter({ hasText: "该 Key 没有此模板可用的模型" });
	await expect(notice).toBeVisible();
	await expect(notice).toHaveAttribute("role", "status");
	await expect(page.getByRole("group", { name: "允许的模型" })).toHaveCount(0);
	await expectFocusSettled(check, "检查可用模型（没有候选）");

	await page.getByRole("button", { name: "修改申请", exact: true }).click();
	const error = page.locator("#application-default-relay-key-error");
	await expect(error).toHaveText(
		"该 Key 没有此模板可用的模型，请换一个 Key 后重新检查。",
	);
	await expectPublicFieldError(page, error);
	await expect(keyInput).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByText(/请先点击「检查可用模型」/)).toHaveCount(0);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id/edit（没有可用模型，#3268）",
	);
	await noHorizontalOverflow(page);
});

test("the application edit uses the Owner configuration model picker for default-Key candidates (#3268 N8-2-05)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		applications: [application({ agentId: "agent-pilot-1" })],
		defaultRelayKeyCandidates: [
			{
				endpointId: "endpoint-primary",
				modelId: "gpt-5",
				displayName: "gpt-5",
				reasoningLevels: ["medium", "high"],
			},
		],
	});
	await page.goto("/my-agents/application-browser-1/edit");
	await page.getByRole("checkbox", { name: "修改模型配置" }).click();
	await page
		.getByLabel("Agent 默认 Relay Key", { exact: true })
		.fill("synthetic-relay-key");
	await page.getByRole("button", { name: "检查可用模型" }).click();
	const picker = page.locator(
		'#application-keyless-model[data-slot="keyless-model-picker"]',
	);
	await expect(picker).toBeVisible();
	const description = picker.locator(".keyless-model-description");
	await expect(description).toHaveText(
		"只列出该 Key 可见、且模板支持的模型。勾选后可调整推理档位和默认模型选项。",
	);
	expect(await computed(description, ["fontSize", "color"])).toEqual({
		fontSize: "13px",
		color: await resolved(page, "color", "var(--muted-foreground)"),
	});
	await expect(
		picker.getByLabel("默认模型选项", { exact: true }),
	).toBeVisible();
	await expect(picker.getByLabel("默认推理档位", { exact: true })).toHaveCount(
		0,
	);
	// 勾选模型后取消它的全部档位：选择器内的错误是公共 FieldError，不是 14px 红字 role=status。
	await picker
		.getByRole("checkbox", { name: "Primary endpoint · gpt-5", exact: true })
		.click();
	for (const level of ["均衡", "高"])
		await picker
			.getByRole("checkbox", {
				name: `${level}：Primary endpoint · gpt-5`,
				exact: true,
			})
			.click();
	const problem = picker.locator('[data-slot="field-error"]');
	await expect(problem).toHaveText("每个已选模型至少保留一个推理档位。");
	await expectPublicFieldError(page, problem);
	await expect(picker.getByRole("status")).toHaveCount(0);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id/edit（默认 Key 模型选择器，#3268）",
	);
	await noHorizontalOverflow(page);
});

/** 动作完成后焦点不落到 body（AC-2）：多次采样。 */
async function expectFocusOffBody(page: Page, context: string) {
	for (const delay of [50, 300, 1000]) {
		await page.waitForTimeout(delay);
		expect(
			await page.evaluate(() => document.activeElement === document.body),
			`${context}（${delay}ms）焦点落到 body`,
		).toBe(false);
	}
}

// #3291 N9-2-01：部署没有登记标准模板（templates=[]）时，模板就绪列表的回退项按 PRD §4 写模板显示名
// （Codex、Claude、OpenCode、Pi）并说明原因，不外露小写模板 ID；下拉仍禁用，提交时由字段错误说明。两视口一致。
test("template readiness fallback names the four standard templates when the deployment has none (#3291 N9-2-01)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	await fixture(page, {
		deployment: DeploymentConfigurationProjectionV2Schema.parse({
			...deploymentConfiguration,
			templates: [],
		}),
	});
	await page.goto("/my-agents/new");
	const readiness = page.getByRole("list", { name: "模板就绪状态" });
	await expect(readiness.getByRole("listitem")).toHaveText([
		"Codex：尚未登记，请联系平台管理员。",
		"Claude：尚未登记，请联系平台管理员。",
		"OpenCode：尚未登记，请联系平台管理员。",
		"Pi：尚未登记，请联系平台管理员。",
	]);
	await expect(readiness).not.toContainText(/\b(?:codex|claude|opencode|pi)：/);
	const template = page.getByRole("combobox", { name: "标准模板" });
	await expect(template).toBeDisabled();
	await expect(template).toContainText("选择标准模板");
	await page.getByLabel("Agent 名称", { exact: true }).fill("客户支持助理");
	await page
		.getByLabel("用途说明", { exact: true })
		.fill("面向支持团队的内部知识问答。");
	const submit = page.getByRole("button", { name: "提交审批", exact: true });
	await submit.focus();
	await page.keyboard.press("Enter");
	const error = page.locator("#application-template-id-error");
	await expect(error).toHaveText(
		"当前部署没有可用的标准模板或模型选项，请联系管理员配置后重试。",
	);
	await expectFocusOffBody(page, "没有标准模板时提交");
	await expect(page.locator("#main-content")).not.toContainText(
		/\b(?:codex|claude|opencode|pi)：/,
	);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/new（没有标准模板，#3291）",
	);
	await noHorizontalOverflow(page);
});

// #3291 N9-2-02：修改申请「默认 Key 管理模型」的选择器字段错误与 Key 字段的拦截错误、申请表单其余字段
// 一样是 polite（web-ui「申请与 Owner 配置的补充状态」），不是 role=alert；提交被拦下时页面没有 alert
// 打断播报，焦点留在 Key 输入框。已选模型没有推理档位与没有选模型两种问题一致。两视口一致。
for (const problem of ["no_model", "no_reasoning_level"] as const)
	test(`an application edit announces the Key picker problem politely beside the Key error (${problem}, #3291 N9-2-02)`, async ({
		page,
	}, info) => {
		await viewportFor(page, info.project.name === "mobile");
		const pageErrors = trackPageErrors(page);
		const base = application({ agentId: "agent-pilot-1" });
		await fixture(page, {
			// 当前模型就是 Key 可见的候选：选择器预先勾选它，取消后才是「改动过的」选择问题。
			applications: [
				application({
					agentId: "agent-pilot-1",
					configuration: {
						...base.configuration,
						modelOptions: [
							{
								optionId: "endpoint-primary:gpt-5",
								modelId: "gpt-5",
								displayName: "gpt-5",
								reasoningLevels: ["medium", "high"],
							},
						],
						defaultModelOptionId: "endpoint-primary:gpt-5",
						defaultReasoningLevel: "medium",
					},
				}),
			],
			defaultRelayKeyCandidates: [
				{
					endpointId: "endpoint-primary",
					modelId: "gpt-5",
					displayName: "gpt-5",
					reasoningLevels: ["medium", "high"],
				},
			],
		});
		await page.goto("/my-agents/application-browser-1/edit");
		await page.getByRole("checkbox", { name: "修改模型配置" }).click();
		const keyInput = page.getByLabel("Agent 默认 Relay Key", { exact: true });
		await keyInput.fill("synthetic-relay-key");
		await page.getByRole("button", { name: "检查可用模型" }).click();
		const picker = page.locator(
			'#application-keyless-model[data-slot="keyless-model-picker"]',
		);
		const model = picker.getByRole("checkbox", {
			name: "Primary endpoint · gpt-5",
			exact: true,
		});
		await expect(model).toHaveAttribute("aria-checked", "true");
		if (problem === "no_model") await model.click();
		else
			for (const level of ["均衡", "高"])
				await picker
					.getByRole("checkbox", {
						name: `${level}：Primary endpoint · gpt-5`,
						exact: true,
					})
					.click();
		const pickerError = picker.locator('[data-slot="field-error"]');
		await expect(pickerError).toHaveText(
			problem === "no_model"
				? "至少选择一个模型。"
				: "每个已选模型至少保留一个推理档位。",
		);
		await expect(pickerError).toHaveAttribute("aria-live", "polite");
		await expect(pickerError).not.toHaveAttribute("role", /.*/);
		await expectPublicFieldError(page, pickerError);

		const submit = page.getByRole("button", { name: "修改申请", exact: true });
		await submit.focus();
		await page.keyboard.press("Enter");
		const keyError = page.locator("#application-default-relay-key-error");
		await expect(keyError).toHaveText(
			"请在下方选好模型（至少一个模型，每个模型至少一个推理档位）。",
		);
		await expect(keyError).toHaveAttribute("aria-live", "polite");
		await expect(page.locator("#main-content").getByRole("alert")).toHaveCount(
			0,
		);
		await expectFocusSettled(keyInput, "修改申请模型选择拦截");
		await expectCleanPage(page, pageErrors);
		await expectNoDuplicateControls(
			page,
			`/my-agents/:id/edit（选择器字段错误 ${problem}，#3291）`,
		);
		await noHorizontalOverflow(page);
	});

// #3291 N9-2-03：修改「自有交互入口 · 由平台校验」的申请时部署未启用平台身份入口（ACTION_UNAVAILABLE）。
// 已有申请不能更改入口身份：顶部提示不再引导「检查字段后重试」，改为提示新建申请，焦点移到这条提示
// （只读的入口身份下拉不是焦点目标），字段下的说明与之一致；未修改时再次提交被拦下，焦点回到提示。
// 创建申请仍按 #3034 聚焦入口身份下拉（management.spec.ts）。两视口一致。
test("an edited platform identity application that the deployment cannot serve points to a new application (#3291 N9-2-03)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	const base = application({
		status: "rejected",
		decision: { decidedAt: "2026-09-07T00:00:00Z", reason: "请调整后重提" },
	});
	await fixture(page, {
		applications: [
			application({
				status: "rejected",
				decision: base.decision,
				source: {
					kind: "custom",
					imageReference: "registry.example/agents/release:v1",
					interactionMode: "self-managed",
					identityResponsibility: "platform-managed",
				},
				configuration: {
					...base.configuration,
					modelOptions: [],
					defaultModelOptionId: null,
					defaultReasoningLevel: null,
				},
			}),
		],
	});
	let rejected = 0;
	await page.route(
		"**/api/v2/agent-applications/application-browser-1",
		async (route) => {
			if (route.request().method() !== "PUT") return route.fallback();
			rejected += 1;
			await route.fulfill({
				status: 409,
				json: {
					schemaVersion: 1,
					code: "ACTION_UNAVAILABLE",
					message: "Controlled identity entry rejection",
					retryable: false,
					traceId: "trace-identity-entry",
				},
			});
		},
	);
	await page.goto("/my-agents/application-browser-1/edit");
	const identity = page.getByRole("combobox", { name: "入口身份校验" });
	await expect(identity).toContainText("由平台校验");
	const submit = page.getByRole("button", {
		name: "修改并重新提交",
		exact: true,
	});
	await submit.focus();
	await page.keyboard.press("Enter");
	const main = page.locator("#main-content");
	const alert = main.locator(".application-form-alert");
	await expect(alert).toHaveText(
		"当前部署不支持此申请的入口身份校验，请新建申请。",
	);
	await expect(alert).toHaveAttribute("role", "alert");
	await expect(main.getByText(/检查字段后重试/)).toHaveCount(0);
	await expectFocusSettled(alert, "修改申请入口身份不可用");
	await expect(
		page.locator("#application-identity-responsibility-error"),
	).toHaveText(
		"当前部署未启用平台身份入口。已有申请不能更改入口身份校验，请新建申请并选择「由自有入口校验」。",
	);
	await expect(identity).toHaveAttribute("aria-invalid", "true");
	await expect(identity).toBeDisabled();
	// 未修改时再次提交不发请求，焦点回到顶部提示。
	await submit.focus();
	await page.keyboard.press("Enter");
	await expectFocusSettled(alert, "修改申请入口身份不可用（再次提交）");
	expect(rejected).toBe(1);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(
		page,
		"/my-agents/:id/edit（入口身份不可用，#3291）",
	);
	await noHorizontalOverflow(page);
});

/** 带模板就绪状态的部署选项（#3328）：Codex 按参数，Claude 为可申请且 revision 可变。 */
function readinessDeployment(
	codex: NonNullable<
		DeploymentConfigurationProjectionV2["templates"][number]["readiness"]
	>,
	claudeRevision = "claude-r1",
) {
	const [codexTemplate] = deploymentConfiguration.templates;
	if (!codexTemplate) throw new Error("Missing Codex template fixture");
	return DeploymentConfigurationProjectionV2Schema.parse({
		...deploymentConfiguration,
		templates: [
			{ ...codexTemplate, readiness: codex },
			{
				templateId: "claude",
				displayName: "Claude",
				connectionEnabled: false,
				allowedEnvironmentKeys: [],
				allowedSecretKeys: [],
				readiness: { state: "ready", revision: claudeRevision },
			},
		],
	});
}

/** 驳回后待修改的标准模板申请（#3328）：「修改并重新提交」。 */
function rejectedStandardApplication() {
	return application({
		status: "rejected",
		decision: { decidedAt: "2026-09-07T00:00:00Z", reason: "请调整后重提" },
	});
}

// #3328 N10-2-01：创建申请时所选模板在会话内更新（部署选项重读后 readiness.revision 变化，仍可申请）。
// 字段下先由 polite 提示「模板已更新，请刷新后确认。」；提交被拦下时字段错误沿用同一原因（公共 FieldError），
// 同义提示随之收起，不再出现笼统的「部署选项暂不可用。」，页面没有顶部提示；下拉可改选，焦点到它。两视口一致。
test("a create form whose selected template is updated in the session reuses the readiness reason as the field error (#3328 N10-2-01)", async ({
	page,
}, info) => {
	await viewportFor(page, info.project.name === "mobile");
	const pageErrors = trackPageErrors(page);
	const { commands } = await fixture(page);
	let claudeRevision = "claude-r1";
	await page.route("**/api/v2/deployment/configuration", (route) =>
		route.fulfill({
			json: readinessDeployment(
				{ state: "ready", revision: "codex-r1" },
				claudeRevision,
			),
		}),
	);
	await page.goto("/my-agents/new");
	await page.getByLabel("Agent 名称", { exact: true }).fill("客户支持助理");
	await page
		.getByLabel("用途说明", { exact: true })
		.fill("面向支持团队的内部知识问答。");
	await page
		.getByLabel("Agent 默认 Relay Key", { exact: true })
		.fill("synthetic-relay-key");
	await pick(page, "标准模板", "Claude");
	await pick(page, "模型端点：模型选项 1", "Primary endpoint");
	await pick(page, "模型：模型选项 1", "gpt-5");
	await page
		.getByRole("checkbox", { name: "均衡：模型选项 1", exact: true })
		.click();
	await pick(page, "默认模型", "Primary endpoint · gpt-5");
	await pick(page, "默认推理档位", "均衡");

	claudeRevision = "claude-r2";
	await page.evaluate(() =>
		window.dispatchEvent(new Event("visibilitychange")),
	);
	const main = page.locator("#main-content");
	const notice = main.getByText("模板已更新，请刷新后确认。", { exact: true });
	await expect(notice).toHaveAttribute("aria-live", "polite");
	await expect(
		page.getByRole("list", { name: "模板就绪状态" }).getByRole("listitem"),
	).toHaveText(["Codex：可申请", "Claude：可申请"]);

	const submit = page.getByRole("button", { name: "提交审批", exact: true });
	await submit.focus();
	await page.keyboard.press("Enter");
	const template = page.getByRole("combobox", { name: "标准模板" });
	const error = page.locator("#application-template-id-error");
	await expect(error).toHaveText("模板已更新，请刷新后确认。");
	await expect(error).toHaveAttribute("aria-live", "polite");
	await expectPublicFieldError(page, error);
	await expect(template).toHaveAttribute("aria-invalid", "true");
	await expect(main.getByText("模板已更新，请刷新后确认。")).toHaveCount(1);
	await expect(main.getByText(/部署选项暂不可用/)).toHaveCount(0);
	await expect(main.locator(".application-form-alert")).toHaveCount(0);
	await expectFocusSettled(template, "创建申请模板已更新");
	expect(commands).toEqual([]);
	await expectCleanPage(page, pageErrors);
	await expectNoDuplicateControls(page, "/my-agents/new（模板已更新，#3328）");
	await noHorizontalOverflow(page);
});

// #3328 N10-2-01：修改申请的模板验证失败。已有申请不能更换模板（下拉只读），提交被拦下时不发请求：
// 顶部同一位置的 danger 提示（role=alert、tabIndex=-1）给出等待恢复或新建申请并获得焦点；字段错误沿用
// 就绪原因并写明不能更换模板，不再出现「部署选项暂不可用。」，同义提示随之收起，就绪列表仍显示原因
// （PRD §4「未就绪项展示原因」）。再次提交焦点回到提示。验证过期（stale：验证证据与当前登记不符或超出
// 有效期，刷新仍为过期）同样提示等待恢复或新建申请；就绪原因只说明要等平台重新验证，提交前的提示、就绪
// 列表与字段错误都不引导刷新，前后两句不给出相反的下一步（#3351 N11-01）。两视口一致。
for (const readiness of [
	{
		state: "failed",
		title: "failed verification",
		reason: "验证失败，暂不可申请。",
		label: "模板验证失败",
	},
	{
		state: "stale",
		title: "has a stale verification",
		reason: "模板验证已过期，需等待平台重新验证。",
		label: "模板验证过期",
	},
] as const)
	test(`an edited application whose template ${readiness.title} is explained at the focused top alert (#3328 N10-2-01)`, async ({
		page,
	}, info) => {
		await viewportFor(page, info.project.name === "mobile");
		const pageErrors = trackPageErrors(page);
		const { commands } = await fixture(page, {
			applications: [rejectedStandardApplication()],
			deployment: readinessDeployment({
				state: readiness.state,
				revision: readiness.state === "failed" ? "codex-r1" : null,
			}),
		});
		await page.goto("/my-agents/application-browser-1/edit");
		const main = page.locator("#main-content");
		const template = page.getByRole("combobox", { name: "标准模板" });
		await expect(template).toContainText("Codex");
		await expect(template).toBeDisabled();
		await expect(
			main.getByText(readiness.reason, { exact: true }),
		).toHaveAttribute("aria-live", "polite");
		await expect(main.locator(".application-form-alert")).toHaveCount(0);
		await expect(
			page.getByRole("list", { name: "模板就绪状态" }).getByRole("listitem"),
		).toHaveText([`Codex：${readiness.reason}`, "Claude：可申请"]);
		// 提交前的提示与就绪列表不引导刷新：验证失败或过期，刷新后仍不可申请（#3351 N11-01）。
		await expect(main.getByText(/刷新/)).toHaveCount(0);

		const submit = page.getByRole("button", {
			name: "修改并重新提交",
			exact: true,
		});
		await submit.focus();
		await page.keyboard.press("Enter");
		const alert = main.locator(".application-form-alert");
		await expect(alert).toHaveText(
			"此申请的模板暂不可申请，请等待模板恢复后再提交，或新建申请。",
		);
		await expect(alert).toHaveAttribute("role", "alert");
		await expect(alert).toHaveAttribute("tabindex", "-1");
		await expectFocusSettled(alert, `修改申请${readiness.label}`);
		const alertBox = await rect(alert);
		const nameBox = await rect(page.getByLabel("Agent 名称", { exact: true }));
		expect(alertBox.bottom).toBeLessThan(nameBox.top);
		const error = page.locator("#application-template-id-error");
		await expect(error).toHaveText(
			`${readiness.reason}已有申请不能更换模板，请等待模板恢复后再提交，或新建申请。`,
		);
		await expectPublicFieldError(page, error);
		await expect(template).toHaveAttribute("aria-invalid", "true");
		await expect(main.getByText(readiness.reason, { exact: true })).toHaveCount(
			0,
		);
		await expect(main.getByText(/部署选项暂不可用/)).toHaveCount(0);
		await expect(
			page.getByRole("list", { name: "模板就绪状态" }).getByRole("listitem"),
		).toHaveText([`Codex：${readiness.reason}`, "Claude：可申请"]);
		await expect(main.getByRole("alert")).toHaveCount(1);
		// 顶部提示与字段错误给出同一个下一步（等待模板恢复或新建申请），整页不出现「刷新」（#3351 N11-01）。
		await expect(main.getByText(/刷新/)).toHaveCount(0);

		await submit.focus();
		await page.keyboard.press("Enter");
		await expectFocusSettled(alert, `修改申请${readiness.label}（再次提交）`);
		expect(commands).toEqual([]);
		await expectCleanPage(page, pageErrors);
		await expectNoDuplicateControls(
			page,
			`/my-agents/:id/edit（${readiness.label}，#3328）`,
		);
		await noHorizontalOverflow(page);
	});

// #3328 N10-2-02：修改申请的模板已从部署移除（部署模板列表不再有 codex；带或不带就绪状态）。只读下拉
// 显示「已移除模板」，不写「请重新加载」；提交被拦下时不发请求，顶部提示「当前部署已移除此申请的模板，
// 请新建申请。」并获得焦点，字段错误不再引导「重新选择」。再次提交焦点回到提示。两视口一致。
for (const readiness of [false, true] as const)
	test(`an edited application whose template was removed points to a new application (${readiness ? "readiness" : "no readiness"}, #3328 N10-2-02)`, async ({
		page,
	}, info) => {
		await viewportFor(page, info.project.name === "mobile");
		const pageErrors = trackPageErrors(page);
		const claudeOnly = readinessDeployment({
			state: "ready",
			revision: "codex-r1",
		}).templates.filter((template) => template.templateId !== "codex");
		const { commands } = await fixture(page, {
			applications: [rejectedStandardApplication()],
			deployment: DeploymentConfigurationProjectionV2Schema.parse({
				...deploymentConfiguration,
				templates: readiness
					? claudeOnly
					: claudeOnly.map(
							({ readiness: _readiness, ...template }) => template,
						),
			}),
		});
		await page.goto("/my-agents/application-browser-1/edit");
		const main = page.locator("#main-content");
		const template = page.getByRole("combobox", { name: "标准模板" });
		await expect(template.locator('[data-slot="select-value"]')).toHaveText(
			"已移除模板",
		);
		await expect(template).toBeDisabled();
		await expect(main.locator(".application-form-alert")).toHaveCount(0);

		const submit = page.getByRole("button", {
			name: "修改并重新提交",
			exact: true,
		});
		await submit.focus();
		await page.keyboard.press("Enter");
		const alert = main.locator(".application-form-alert");
		await expect(alert).toHaveText("当前部署已移除此申请的模板，请新建申请。");
		await expect(alert).toHaveAttribute("role", "alert");
		await expect(alert).toHaveAttribute("tabindex", "-1");
		await expectFocusSettled(alert, "修改申请模板已移除");
		const error = page.locator("#application-template-id-error");
		await expect(error).toHaveText(
			"该模板已从当前部署移除。已有申请不能更换模板，请新建申请。",
		);
		await expectPublicFieldError(page, error);
		await expect(template).toHaveAttribute("aria-invalid", "true");
		await expect(main.getByText(/重新选择|请重新加载/)).toHaveCount(0);
		await expect(main.getByRole("alert")).toHaveCount(1);

		await submit.focus();
		await page.keyboard.press("Enter");
		await expectFocusSettled(alert, "修改申请模板已移除（再次提交）");
		expect(commands).toEqual([]);
		await expectCleanPage(page, pageErrors);
		await expectNoDuplicateControls(
			page,
			"/my-agents/:id/edit（模板已移除，#3328）",
		);
		await noHorizontalOverflow(page);
	});

// #3351 N11-02：非校验类提交失败（503 依赖不可用、500 未知或内部错误、不可重试的 409）的说明只在表单顶部
// 唯一的 danger 提示里。从页底的提交按钮提交（提交前顶部已滚出视口）：请求进行中按钮保持可聚焦
// （aria-disabled）并留住焦点；失败后顶部提示滚入视口、停在吸顶顶栏之下并接过焦点，与同表单的整表校验失败
// （INVALID_REQUEST）一致，焦点不再留在页底按钮上、可见区域里看得到失败。创建与修改申请一致，两视口一致。
const submissionFailures = [
	{
		mode: "create",
		title: "503 dependency unavailable",
		status: 503,
		body: {
			schemaVersion: 1,
			code: "DEPENDENCY_UNAVAILABLE",
			message: "Controlled submission failure",
			retryable: true,
			traceId: "trace-submission-failure",
		},
		text: "申请提交失败，部署依赖暂不可用，请稍后重试。",
	},
	{
		mode: "create",
		title: "500 unknown error",
		status: 500,
		body: {},
		text: "申请提交失败，非敏感内容已保留。请重新填写 Secret 或模型凭证后再提交。",
	},
	{
		mode: "create",
		title: "409 not retryable",
		status: 409,
		body: {
			schemaVersion: 1,
			code: "RESOURCE_UNAVAILABLE",
			message: "Controlled submission conflict",
			retryable: false,
			traceId: "trace-submission-failure",
		},
		text: "申请已变更或当前不可用，请刷新页面后核对。",
	},
	{
		mode: "update",
		title: "503 dependency unavailable",
		status: 503,
		body: {
			schemaVersion: 1,
			code: "DEPENDENCY_UNAVAILABLE",
			message: "Controlled submission failure",
			retryable: true,
			traceId: "trace-submission-failure",
		},
		text: "申请提交失败，部署依赖暂不可用，请稍后重试。",
	},
	{
		mode: "update",
		title: "500 internal error",
		status: 500,
		body: {
			schemaVersion: 1,
			code: "INTERNAL_ERROR",
			message: "Controlled submission failure",
			retryable: true,
			traceId: "trace-submission-failure",
		},
		text: "申请提交失败，部署依赖暂不可用，请稍后重试。",
	},
	{
		mode: "update",
		title: "409 not retryable",
		status: 409,
		body: {
			schemaVersion: 1,
			code: "RESOURCE_UNAVAILABLE",
			message: "Controlled submission conflict",
			retryable: false,
			traceId: "trace-submission-failure",
		},
		text: "申请已变更或当前不可用，请刷新页面后核对。",
	},
] as const;

for (const failure of submissionFailures)
	test(`a ${failure.mode} submission ${failure.title} brings the top alert into view and focuses it (#3351 N11-02)`, async ({
		page,
	}, info) => {
		await viewportFor(page, info.project.name === "mobile");
		const pageErrors = trackPageErrors(page);
		await fixture(page, { applications: [rejectedStandardApplication()] });
		const method = failure.mode === "create" ? "POST" : "PUT";
		const path =
			failure.mode === "create"
				? "/api/v2/agent-applications"
				: "/api/v2/agent-applications/application-browser-1";
		let submissions = 0;
		await page.route(
			(url) => url.pathname === path,
			(route) => {
				if (route.request().method() !== method) return route.fallback();
				submissions += 1;
				return route.fulfill({ status: failure.status, json: failure.body });
			},
		);
		const main = page.locator("#main-content");
		const name = page.getByLabel("Agent 名称", { exact: true });
		if (failure.mode === "create") {
			await page.goto("/my-agents/new");
			await name.fill("客户支持助理");
			await page
				.getByLabel("用途说明", { exact: true })
				.fill("面向支持团队的内部知识问答。");
			await page
				.getByLabel("Agent 默认 Relay Key", { exact: true })
				.fill("synthetic-relay-key");
			await pick(page, "标准模板", "Codex");
			await pick(page, "模型端点：模型选项 1", "Primary endpoint");
			await pick(page, "模型：模型选项 1", "gpt-5");
			await page
				.getByRole("checkbox", { name: "均衡：模型选项 1", exact: true })
				.click();
			await pick(page, "默认模型", "Primary endpoint · gpt-5");
			await pick(page, "默认推理档位", "均衡");
		} else {
			await page.goto("/my-agents/application-browser-1/edit");
			await expect(name).toHaveValue(rejectedStandardApplication().name);
		}
		const submit = await pinElement(
			main.getByRole("button", {
				name: failure.mode === "create" ? "提交审批" : "修改并重新提交",
				exact: true,
			}),
			"application-submit",
		);
		// 前置状态：页底的提交按钮在视口内时，表单顶部（顶部提示所在的位置）已滚出视口。
		await submit.focus();
		const before = await topbarClearance(name);
		expect(before.top, "提交前「Agent 名称」在顶栏之上").toBeLessThan(
			before.barBottom,
		);
		await expect(main.locator(".application-form-alert")).toHaveCount(0);

		const submitting = await holdRequests(page, method, path);
		await page.keyboard.press("Enter");
		await expect(submit).toHaveText("正在提交…");
		await expectFocusableBusy(submit, `申请提交（${failure.title}）`);
		submitting.release();

		const alert = main.locator(".application-form-alert");
		await expect(alert).toHaveText(failure.text);
		await expect(alert).toHaveAttribute("role", "alert");
		await expect(alert).toHaveAttribute("tabindex", "-1");
		await expectFocusSettled(
			alert,
			`申请提交失败（${failure.title}）`,
			[100, 400, 1000, 1600],
		);
		await expectFocusUnobscured(alert, `申请提交失败（${failure.title}）`);
		await expect(main.getByRole("alert")).toHaveCount(1);
		await expect(submit).not.toHaveAttribute("aria-disabled", "true");
		expect(submissions).toBe(1);
		await expectCleanPage(page, pageErrors);
		await expectNoDuplicateControls(
			page,
			`申请提交失败（${failure.mode} ${failure.title}，#3351）`,
		);
		await noHorizontalOverflow(page);
	});
