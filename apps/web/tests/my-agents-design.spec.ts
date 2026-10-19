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
import {
	deploymentConfiguration,
	pendingApplication,
} from "../src/features/my-agents/test-fixtures";
import type {
	AgentApplicationProjectionV2,
	AgentProjectionV2,
} from "../src/pilot/generated-v2/types.gen";
import { computed, resolved } from "./primitive-styles";

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
				json: {
					schemaVersion: 1,
					items: directoryRecords.filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							(!ids || ids.includes(item.canonicalId)) &&
							JSON.stringify(item).toLowerCase().includes(query),
					),
				},
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
		const href = await row
			.getByRole("link", { name: /^查看申请：/ })
			.getAttribute("href");
		await expect(row.locator(`a[href="${href}"]`)).toHaveCount(1);
		const time = row.locator("time");
		await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
		await expect(time.locator("xpath=..")).toContainText(" · 更新于 ");
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
			if (step.label === "提交申请") break;
			await page.keyboard.press("Tab");
		}
		expect(steps.at(-1)?.label).toBe("提交申请");
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
	// M-10 决策前：没有渠道分区与保存草稿，主按钮保持「提交申请」并带 16px 箭头。
	await expect(page.getByRole("heading", { name: "渠道" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: /保存草稿/ })).toHaveCount(0);
	const submit = footer.getByRole("button", { name: "提交申请", exact: true });
	await expect(submit.locator("svg")).toHaveCSS("width", "16px");

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
	// M-06：推理档位选项 13px / 400 / 前景色，至少 44px 高，复选框 18×18。
	const option = page.locator('label[data-variant="option"]', {
		hasText: "medium",
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

test("application detail puts actions in the heading, shows three progress rows and a next step (M-11 / M-12 / M-04)", async ({
	page,
}, info) => {
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
