import {
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
	ScopedPlatformAuditPageV2Schema,
	ScopedPlatformAuditProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV2 } from "@agent-infra/test-support/pilot";
import {
	expect,
	type Locator,
	type Page,
	type TestInfo,
	test,
} from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import { captureDesignContract, designViewports } from "./design-contract";
import {
	expectFocusableBusy,
	expectFocusHeld,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import {
	computed,
	expectCardTable,
	expectCleanPage,
	expectDesktopTable,
	expectFieldControl,
	expectFieldLabel,
	expectPageHeadTop,
	trackPageErrors,
} from "./primitive-styles";

const session = (role: "employee" | "admin") => ({
	schemaVersion: 1,
	user: {
		userId: role === "admin" ? "audit-admin" : "audit-user-a",
		displayName: role === "admin" ? "审计管理员" : "审计用户",
		roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
	},
});

// #2909：页面读取 V2 投影；名称由服务端按查询方当前权限返回，null 表示只给类型与 ID。
function record(
	auditId: string,
	userId = "audit-user-a",
	agentName: string | null = null,
) {
	return ScopedPlatformAuditProjectionV2Schema.parse({
		schemaVersion: 2,
		auditId,
		action: "task.api.access",
		actor: { kind: "user", actorId: userId, displayName: null },
		subject: {
			kind: "agent",
			subjectId: `agent-${auditId}`,
			displayName: agentName,
		},
		result: "accepted",
		summary: `任务 API 访问获准 ${auditId}`,
		taskApi: {
			operation: "submit",
			phase: "access",
			reason: "request_accepted",
		},
		occurredAt: "2026-09-28T00:00:00.000Z",
		traceId: "trace-a",
		requestId: "request-a",
		agentId: `agent-${auditId}`,
		conversationId: null,
		executionId: null,
		authorizationRecordId: null,
		originalPrincipal: null,
		executor: null,
		operation: null,
		agentDisplayName: agentName,
	});
}

const governance = ScopedPlatformAuditProjectionV2Schema.parse({
	...record("audit-a"),
	action: "agent.application.submitted",
	subject: {
		kind: "agent_application",
		subjectId: `application-${"safe".repeat(18)}`,
		displayName: "数据助手",
	},
	result: "accepted",
	summary: "申请已受理；治理元数据只含受控对象与结果，不包含对话正文。".repeat(
		3,
	),
	taskApi: null,
	agentId: null,
	executionId: null,
	originalPrincipal: null,
});
const backgroundExecutionId = `execution-backend-${"safe".repeat(18)}`;
const background = ScopedPlatformAuditProjectionV2Schema.parse({
	...record("audit-b"),
	action: "task.status.changed",
	actor: { kind: "system", actorId: "platform_worker", displayName: null },
	subject: {
		kind: "execution",
		subjectId: backgroundExecutionId,
		displayName: null,
	},
	result: "unknown",
	summary: "后台执行结果待核实；不能把请求受理或启动当作执行成功。".repeat(3),
	taskApi: null,
	agentId: "agent-a",
	agentDisplayName: "编程助手",
	executionId: backgroundExecutionId,
	authorizationRecordId: "authorization-background-a",
	originalPrincipal: { kind: "user", id: "audit-user-a", displayName: null },
	executor: "platform_worker",
});
const applicationActorId = `application-ops-${"safe".repeat(6)}`;
const applicationStop = ScopedPlatformAuditProjectionV2Schema.parse({
	...record("audit-c"),
	action: "agent.lifecycle.stopped",
	actor: {
		kind: "application",
		actorId: applicationActorId,
		displayName: "运维机器人",
	},
	subject: { kind: "agent", subjectId: "agent-a", displayName: "编程助手" },
	result: "succeeded",
	summary: "应用停止 Agent，名称按管理员当前权限返回。",
	taskApi: null,
	agentId: "agent-a",
	agentDisplayName: "编程助手",
});
// 名称不可确认（无权、不存在或无法确认）时，投影只给类型与 ID。
const unnamedAgentId = `agent-unnamed-${"safe".repeat(6)}`;
const unnamedApplication = ScopedPlatformAuditProjectionV2Schema.parse({
	...record("audit-d"),
	action: "agent.lifecycle.stopped",
	actor: {
		kind: "application",
		actorId: `application-unnamed-${"safe".repeat(6)}`,
		displayName: null,
	},
	subject: { kind: "agent", subjectId: unnamedAgentId, displayName: null },
	result: "succeeded",
	summary: "名称不可确认时只显示类型与 ID 短形式。",
	taskApi: null,
	agentId: unnamedAgentId,
	agentDisplayName: null,
});
const agentBaseline = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
// Agent 筛选的候选只来自服务端已授权的 Agent 列表。
const agentCandidates = {
	employee: [
		["agent-audit-a", "编程助手"],
		["agent-audit-b", "写作助手"],
	],
	admin: [
		["agent-a", "编程助手"],
		["agent-b", "数据助手"],
	],
} as const;

async function fixture(page: Page, role: "employee" | "admin" = "employee") {
	let failNext = false;
	let emptyNext = false;
	let holdDetail = false;
	let roles = session(role).user.roles;
	const ownRecords = [
		record("audit-a", session(role).user.userId, "编程助手"),
		record("audit-b", session(role).user.userId),
	];
	const requests: { method: string; path: string; search: string }[] = [];
	const held: string[] = [];
	let releaseDetail = () => {};
	const pendingDetail = new Promise<void>((resolve) => {
		releaseDetail = resolve;
	});
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/api/"))
			requests.push({
				method: request.method(),
				path: url.pathname,
				search: url.search,
			});
	});
	// 审计主体按目录显示姓名；目录只返回已知用户。
	await page.route("**/api/v2/directory/search?**", (route) => {
		const ids =
			new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
		return route.fulfill({
			json: directorySearchResponse(
				new URL(route.request().url()),
				(["admin", "employee"] as const)
					.map((item) => ({
						kind: "user",
						canonicalId: session(item).user.userId,
						displayName: session(item).user.displayName,
						email: `${session(item).user.userId}@example.test`,
					}))
					.filter((item) => ids.includes(item.canonicalId)),
			),
		});
	});
	await page.route(/\/api\/v2\/(admin\/)?agents(?:\?.*)?$/, (route) => {
		const admin = new URL(route.request().url()).pathname.startsWith(
			"/api/v2/admin/",
		);
		return route.fulfill({
			json: {
				items: agentCandidates[admin ? "admin" : "employee"].map(
					([agentId, name]) =>
						AgentProjectionV2Schema.parse({ ...agentBaseline, agentId, name }),
				),
				nextCursor: null,
			},
		});
	});
	await page.route(/\/api\/v1\/session$/, (route) =>
		route.fulfill({
			status: 200,
			json: { ...session(role), user: { ...session(role).user, roles } },
		}),
	);
	await page.route(
		/\/api\/(v2\/audit|v4\/admin\/audit)(\/.*)?(?:\?.*)?$/,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const records = url.pathname.startsWith("/api/v4/admin/audit")
				? [governance, background, applicationStop, unnamedApplication]
				: ownRecords;
			if (failNext) {
				failNext = false;
				await route.fulfill({
					status: 503,
					json: PilotProtocolErrorV1Schema.parse({
						schemaVersion: 1,
						code: "DEPENDENCY_UNAVAILABLE",
						message: "private fixture error",
						traceId: "trace-fixture-unavailable",
						retryable: true,
					}),
				});
				return;
			}
			const detail = records.find((item) =>
				url.pathname.endsWith(`/${item.auditId}`),
			);
			if (detail) {
				if (holdDetail) {
					holdDetail = false;
					held.push(detail.auditId);
					await pendingDetail;
				}
				await route.fulfill({ status: 200, json: detail });
				return;
			}
			const filtered = records.filter((item) => {
				const principal = item.originalPrincipal ?? {
					kind: item.actor.kind,
					id: item.actor.actorId,
				};
				return (
					Object.entries({
						principalKind: principal.kind,
						principalId: principal.id,
						agentId: item.agentId,
						executionId: item.executionId,
						action: item.action,
						result: item.result,
					}).every(
						([key, value]) =>
							!url.searchParams.has(key) || url.searchParams.get(key) === value,
					) &&
					(!url.searchParams.has("from") ||
						item.occurredAt >= (url.searchParams.get("from") ?? "")) &&
					(!url.searchParams.has("until") ||
						item.occurredAt < (url.searchParams.get("until") ?? ""))
				);
			});
			// 每页 1 条，cursor 记下一页的序号。
			const index = Number(
				url.searchParams.get("cursor")?.replace("cursor-", "") ?? 0,
			);
			await route.fulfill({
				status: 200,
				json: ScopedPlatformAuditPageV2Schema.parse({
					items: emptyNext ? [] : filtered.slice(index, index + 1),
					nextCursor:
						!emptyNext && index + 1 < filtered.length
							? `cursor-${index + 1}`
							: null,
				}),
			});
			emptyNext = false;
		},
	);
	return {
		requests,
		held,
		failNext: () => (failNext = true),
		emptyNext: () => (emptyNext = true),
		revokeAdmin: () => {
			roles = ["employee"];
		},
		holdNextDetail: () => (holdDetail = true),
		releaseDetail,
	};
}

test("own audit page filters, paginates, opens detail, and fits mobile", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const api = await fixture(page);
	await page.goto("/audit");
	await expect(
		page.getByRole("heading", { name: "查看自己的执行记录。", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /^详情：/ })).toHaveCount(1);
	await page
		.getByLabel("动作", { exact: true })
		.selectOption("task.api.access");
	await page.getByRole("button", { name: "查询", exact: true }).click();
	await expect(page.getByText("访问获准", { exact: true })).toBeVisible();
	// #2909：有权查看的 Agent 显示名称，ID 以 IdentifierText 短形式附在下方。
	await expect(
		page.locator('.audit-table [data-label="对象"]').first(),
	).toHaveText("编程助手agent-au…");
	await page.getByRole("button", { name: "下一页", exact: true }).click();
	// F-03：列表只给对象 ID 的等宽短形式（完整值在 title 与详情中），不再列出 Agent / Execution 原值；
	// 没有名称的对象只显示类型。
	const objectId = page
		.locator(".audit-table")
		.getByText("agent-au…", { exact: true });
	await expect(objectId).toBeVisible();
	await expect(objectId).toHaveAttribute("title", "agent-audit-b");
	await expect(page.locator(".audit-table")).not.toContainText("Execution：");
	await expect(page.locator(".audit-table")).not.toContainText("Agent：");
	await expect(page.locator(".audit-table")).not.toContainText(
		"task.api.access",
	);
	await page.getByRole("button", { name: /^详情：/ }).click();
	await expect(
		page.getByRole("region", { name: "审计详情", exact: true }),
	).toContainText("agent-audit-b");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: /^详情：/ })).toBeFocused();
	await expect(
		page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).resolves.toBe(true);
	await api.failNext();
	await page.getByRole("button", { name: "刷新审计记录" }).click();
	await expect(
		page.getByRole("alert").filter({ hasText: "审计查询失败" }),
	).toBeVisible();
	await expect(page.getByText("private fixture error")).toHaveCount(0);
});

for (const compact of [false, true]) {
	test(`administrator original audit consumes governance and background metadata read-only${compact ? " at 320x370" : ""}`, async ({
		page,
	}, info) => {
		if (compact) await page.setViewportSize({ width: 320, height: 370 });
		const api = await fixture(page, "admin");
		await page.goto("/admin/audit");
		await expect(
			page.getByRole("heading", {
				name: "查看平台变更记录。",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByText("系统管理 / 平台审计", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "平台操作记录", exact: true }),
		).toBeVisible();
		const row = page.getByRole("row").filter({ hasText: governance.summary });
		await expect(row).toContainText("applicat…");
		await expect(row).not.toContainText(governance.subject.subjectId);
		// #2909：创建申请对象显示服务端返回的申请名称。
		await expect(row.locator('[data-label="对象"]')).toHaveText(
			"数据助手applicat…",
		);
		// 时间位于 <time dateTime title> 中，按本地时区显示，不出现 ISO 原文或秒。
		const occurred = row.locator(`time[datetime="${governance.occurredAt}"]`);
		await expect(occurred).toHaveAttribute(
			"title",
			/^\d{4} 年 \d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}:\d{2}$/,
		);
		await expect(occurred).not.toHaveText(/T\d\d:|:\d\d:\d\d/);
		await expect(row).toContainText("创建申请");
		await expect(row).not.toContainText("Execution：");
		await expect(row.getByText("已受理", { exact: true })).toBeVisible();
		await expect(row.getByText("成功", { exact: true })).toHaveCount(0);
		await expect(page.getByText("最小审计数据", { exact: true })).toBeVisible();
		await expect(page.getByText(/关联引用不授予查询权限/)).toBeVisible();
		// 审计范围是首屏静态说明（B-10）：info notice，不设 live 角色，首屏没有 role="alert"。
		const scopeNotice = page.locator('[data-slot="alert"]', {
			hasText: "最小审计数据",
		});
		await expect(scopeNotice).not.toHaveAttribute("role");
		await expect(scopeNotice).not.toHaveAttribute("aria-live");
		await expect(page.getByRole("alert")).toHaveCount(0);
		if (!compact) {
			await expect(scopeNotice).toHaveCSS("display", "flex");
			await expect(scopeNotice).toHaveCSS("column-gap", "10px");
			await expect(scopeNotice).toHaveCSS("padding", "13px 14px");
			await expect(scopeNotice).toHaveCSS("border-top-left-radius", "12px");
			await expect(scopeNotice).toHaveCSS("font-size", "13px");
			const accent = await page.evaluate(() => {
				const probe = document.createElement("span");
				probe.style.color = "var(--accent)";
				document.body.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			});
			const icon = scopeNotice.locator(":scope > svg");
			await expect(icon).toHaveCSS("width", "17px");
			await expect(icon).toHaveCSS("height", "17px");
			await expect(icon).toHaveCSS("margin-top", "2px");
			await expect(icon).toHaveCSS("color", accent);
			const title = scopeNotice.getByText("最小审计数据", { exact: true });
			expect(await title.evaluate((element) => element.tagName)).toBe("STRONG");
			await expect(title).toHaveCSS("display", "block");
			await expect(title).toHaveCSS("font-weight", "650");
			const description = scopeNotice.locator(
				'[data-slot="alert-description"]',
			);
			await expect(description).toHaveCSS("font-size", "13px");
			await expect(description).toHaveCSS("line-height", "21.45px");
		}
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await info.attach("controlled-original-administrator-audit", {
			body: await page.screenshot({ fullPage: true, animations: "disabled" }),
			contentType: "image/png",
		});
		await page.getByRole("button", { name: "下一页", exact: true }).click();
		const worker = page
			.getByRole("row")
			.filter({ hasText: background.summary });
		await expect(worker).toContainText("executio…");
		await expect(worker).not.toContainText(background.subject.subjectId);
		// #2909：Execution 对象附上可见的所属 Agent 名称。
		await expect(worker.locator('[data-label="对象"]')).toHaveText(
			"编程助手 · Executionexecutio…",
		);
		// 主体格：后台组件为类型中文名 + ID 短形式；原发起主体显示目录姓名（PRD §13.1）。
		const principal = worker.locator('[data-label="主体"]');
		await expect(principal).toContainText("后台组件 platform…");
		await expect(principal).toContainText("原发起：审计用户");
		await expect(principal).not.toContainText("audit-user-a");
		await expect(worker.getByText("结果待核实", { exact: true })).toBeVisible();
		await worker.getByRole("button", { name: /^详情：/ }).click();
		const dialog = page.getByRole("region", { name: "审计详情", exact: true });
		await expect(dialog).toContainText(background.summary);
		// 详情：主体先显示名称，完整 ID 作为等宽次要文字保留以便核对。
		await expect(dialog).toContainText("后台组件platform_worker");
		await expect(dialog).toContainText("审计用户audit-user-a");
		await expect(dialog.getByText("audit-user-a", { exact: true })).toHaveCSS(
			"font-family",
			/^ui-monospace/,
		);
		await expect(
			dialog.locator("dt", { hasText: "Agent 名称" }).locator("+ dd"),
		).toHaveText("编程助手");
		await expect(dialog).not.toContainText("动作代码");
		await expect(dialog).not.toContainText("task.status.changed");
		await expect(dialog).toContainText("实际后台组件");
		await info.attach("controlled-original-audit-detail-viewport", {
			body: await page.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});
		await expect(
			dialog.getByRole("heading", {
				name: "任务状态变化 · 结果待核实",
				exact: true,
			}),
		).toBeInViewport({ ratio: 1 });
		await expect(
			dialog.getByRole("button", { name: "关闭审计详情", exact: true }),
		).toBeInViewport({ ratio: 1 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await info.attach("controlled-original-audit-background-detail", {
			body: await page.screenshot({ fullPage: true, animations: "disabled" }),
			contentType: "image/png",
		});
		await page.keyboard.press("Escape");
		await expect(worker.getByRole("button", { name: /^详情：/ })).toBeFocused();
		// F-03：其余字段默认收在「更多筛选」中，用户展开后再填写。
		const more = page.getByRole("button", { name: /^更多筛选/ });
		await expect(more).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByLabel("Execution ID", { exact: true })).toBeHidden();
		await more.click();
		await expect(more).toHaveAttribute("aria-expanded", "true");
		await page.getByLabel("起始时间", { exact: true }).fill("2026-09-27T00:00");
		await page.getByLabel("结束时间", { exact: true }).fill("2026-09-29T00:00");
		await page.getByLabel("主体类型", { exact: true }).selectOption("user");
		await page.getByLabel("主体 ID", { exact: true }).fill("audit-user-a");
		// AC-2：Agent 按名称选择，请求里仍是 Agent ID。
		await page.getByRole("combobox", { name: "Agent", exact: true }).click();
		await page
			.getByRole("listbox", { name: "Agent搜索结果" })
			.getByRole("option", { name: /编程助手/ })
			.click();
		await expect(
			page.getByRole("button", { name: "移除 编程助手", exact: true }),
		).toBeVisible();
		await page
			.getByLabel("动作", { exact: true })
			.selectOption("task.status.changed");
		await page.getByLabel("结果", { exact: true }).selectOption("unknown");
		await page
			.getByLabel("Execution ID", { exact: true })
			.fill(backgroundExecutionId);
		const filteredRequest = page.waitForRequest((request) => {
			const url = new URL(request.url());
			return (
				url.pathname === "/api/v4/admin/audit" &&
				url.searchParams.get("executionId") === backgroundExecutionId
			);
		});
		await page.getByRole("button", { name: "查询", exact: true }).click();
		const url = new URL((await filteredRequest).url());
		for (const [key, value] of Object.entries({
			principalKind: "user",
			principalId: "audit-user-a",
			agentId: "agent-a",
			action: "task.status.changed",
			result: "unknown",
			executionId: backgroundExecutionId,
		}))
			expect(url.searchParams.get(key)).toBe(value);
		expect(url.searchParams.has("from") && url.searchParams.has("until")).toBe(
			true,
		);
		expect(url.searchParams.has("cursor")).toBe(false);
		// 隐藏字段有值时按钮带数量，查询后保持展开。
		await expect(more).toHaveText("更多筛选（5）");
		await expect(more).toHaveAttribute("aria-expanded", "true");
		await expect(worker).toBeVisible();
		await expect(row).toHaveCount(0);
		await page.reload();
		await expect(row).toBeVisible();
		await expect(
			page.getByRole("link", { name: "我的执行审计", exact: true }).last(),
		).toBeVisible();
		await page
			.getByRole("link", { name: "我的执行审计", exact: true })
			.last()
			.click();
		await expect(page).toHaveURL(/\/audit$/);
		await expect(
			page.getByRole("heading", { name: "查看自己的执行记录。", exact: true }),
		).toBeVisible();
		await expect(page.locator(".audit-table")).toContainText("审计管理员");
		await expect(page.locator(".audit-table")).not.toContainText("审计用户");
		await expect(page.locator(".audit-table")).not.toContainText("audit-admin");
		await expect(
			page.getByText(governance.summary, { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText(background.summary, { exact: true }),
		).toHaveCount(0);
		await page.goBack();
		await expect(page).toHaveURL(/\/admin\/audit$/);
		await expect(row).toBeVisible();
		expect(api.requests.filter((request) => request.method !== "GET")).toEqual(
			[],
		);
	});
}

test("employee direct administrator audit route neither requests nor displays administrator records", async ({
	page,
}) => {
	const api = await fixture(page);
	await page.goto("/admin/audit");
	await expect(
		page.getByText("当前无权访问平台审计。", { exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: /^详情(：|$)/ })).toHaveCount(
		0,
	);
	expect(
		api.requests.filter((request) =>
			/^\/api\/(v3|v4)\/admin\/(audit|agents)/.test(request.path),
		),
	).toEqual([]);
});

test("administrator audit failure is distinct from successful empty metadata", async ({
	page,
}) => {
	const api = await fixture(page, "admin");
	const queryFailure = page
		.getByRole("alert")
		.filter({ hasText: "审计查询失败" });
	await page.goto("/admin/audit");
	await expect(
		page.getByText(governance.summary, { exact: true }),
	).toBeVisible();
	api.failNext();
	await page.getByRole("button", { name: "刷新审计记录" }).click();
	await expect(queryFailure).toBeVisible();
	await expect(page.getByText("暂无审计记录", { exact: true })).toHaveCount(0);
	await expect(page.getByText("private fixture error")).toHaveCount(0);
	api.emptyNext();
	await page.getByRole("button", { name: "刷新审计记录" }).click();
	await expect(page.getByText("暂无审计记录", { exact: true })).toBeVisible();
	await expect(queryFailure).toHaveCount(0);
	await expect(
		page.getByRole("option", { name: "审计查询失败", exact: true }),
	).toHaveCount(1);
	expect(api.requests.filter((request) => request.method !== "GET")).toEqual(
		[],
	);
});

declare global {
	interface Window {
		controlledAuditTransport: { aborted: number; completed: number };
	}
}

test("same-user administrator role revocation clears list and detail despite a late authorized fixture response", async ({
	page,
}) => {
	// Only this controlled detail transport completes after the real consumer abort.
	await page.addInitScript(() => {
		const originalFetch = window.fetch.bind(window);
		window.controlledAuditTransport = { aborted: 0, completed: 0 };
		window.fetch = (input, init) => {
			const request = new Request(input, init);
			if (!new URL(request.url).pathname.startsWith("/api/v4/admin/audit/"))
				return originalFetch(input, init);
			request.signal.addEventListener(
				"abort",
				() => {
					window.controlledAuditTransport.aborted += 1;
				},
				{ once: true },
			);
			return originalFetch(new Request(request, { signal: null })).then(
				(response) => {
					window.controlledAuditTransport.completed += 1;
					return response;
				},
			);
		};
	});
	const api = await fixture(page, "admin");
	try {
		await page.goto("/admin/audit");
		await expect(
			page.getByText(governance.summary, { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: /^详情：/ }).click();
		await expect(
			page.getByRole("region", { name: "审计详情", exact: true }),
		).toContainText(governance.summary);
		const completed = await page.evaluate(
			() => window.controlledAuditTransport.completed,
		);
		api.holdNextDetail();
		await page.getByRole("button", { name: "刷新审计详情" }).click();
		await expect.poll(() => api.held).toEqual(["audit-a"]);
		api.revokeAdmin(); // User ID and login generation remain unchanged.
		await page.evaluate(() => {
			const descriptor = Object.getOwnPropertyDescriptor(
				document,
				"visibilityState",
			);
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "hidden",
			});
			window.dispatchEvent(new Event("visibilitychange"));
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "visible",
			});
			window.dispatchEvent(new Event("visibilitychange"));
			if (descriptor)
				Object.defineProperty(document, "visibilityState", descriptor);
			else Reflect.deleteProperty(document, "visibilityState");
		});
		await expect(
			page.getByText("当前无权访问平台审计。", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("region", { name: "审计详情", exact: true }),
		).toHaveCount(0);
		await expect
			.poll(() => page.evaluate(() => window.controlledAuditTransport.aborted))
			.toBeGreaterThan(0);
		api.releaseDetail();
		await expect
			.poll(() =>
				page.evaluate(() => window.controlledAuditTransport.completed),
			)
			.toBe(completed + 1);
		await expect(
			page.getByText(governance.summary, { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText(governance.subject.subjectId, { exact: true }),
		).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^详情(：|$)/ })).toHaveCount(
			0,
		);
		expect(api.requests.filter((request) => request.method !== "GET")).toEqual(
			[],
		);
	} finally {
		api.releaseDetail();
	}
});

for (const [route, title] of [
	["/audit", "查看自己的执行记录。"],
	["/admin/audit", "查看平台变更记录。"],
] as const) {
	test(`audit page head ${route} places the h1 at the design height`, async ({
		page,
	}, info) => {
		await fixture(page, route === "/audit" ? "employee" : "admin");
		await page.goto(route);
		await expect(
			page.getByRole("heading", { level: 1, name: title, exact: true }),
		).toBeVisible();
		// 设计 .page-head-copy .eyebrow 上外边距为 0，h1 与设计同高（±1px）。
		await expectPageHeadTop(page, info.project.name === "mobile");
	});
}

for (const route of ["/audit", "/admin/audit"]) {
	test(`exported design viewport matrix ${route}`, async ({ page }, info) => {
		test.skip(
			info.project.name !== "desktop",
			"The exported nine-viewport matrix runs once.",
		);
		await fixture(page, route === "/audit" ? "employee" : "admin");
		await page.goto(route);
		await expect(
			page.getByRole("button", { name: /^详情：/ }).first(),
		).toBeVisible();
		for (const viewport of designViewports) {
			await page.setViewportSize(viewport);
			await captureDesignContract(page, info, route.replaceAll("/", "-"));
		}
	});
}

for (const administrator of [false, true]) {
	test(`${administrator ? "platform" : "personal"} audit filters and table follow the exported design, with mobile cards`, async ({
		page,
	}) => {
		await fixture(page, administrator ? "admin" : "employee");
		await page.goto(administrator ? "/admin/audit" : "/audit");
		const table = page.locator("table.audit-table");
		await expect(table).toBeVisible();
		for (const viewport of [
			{ width: 1440, height: 900 },
			{ width: 768, height: 1024 },
		]) {
			await page.setViewportSize(viewport);
			// B-04 / B-05：审计筛选的字段标签与输入框。
			await expectFieldLabel(
				page,
				page.locator("label", { hasText: "起始时间" }),
			);
			// 「更多筛选」中的字段由用户展开后再核对输入框样式；Agent 筛选是名称选择器（#2909），
			// 控件外框与其他字段同高同圆角。
			const more = page.getByRole("button", { name: /^更多筛选/ });
			if ((await more.getAttribute("aria-expanded")) === "false")
				await more.click();
			await expectFieldControl(
				page,
				page.getByLabel("Execution ID", { exact: true }),
			);
			const agentControl = page
				.locator(".directory-field")
				.filter({
					has: page.getByRole("combobox", { name: "Agent", exact: true }),
				})
				.locator(".directory-control");
			expect(
				await agentControl.evaluate((element) => [
					element.getBoundingClientRect().height,
					getComputedStyle(element).borderTopLeftRadius,
				]),
			).toEqual([44, "10px"]);
			await expectDesktopTable(page, table);
		}
		for (const viewport of [
			{ width: 390, height: 844 },
			{ width: 320, height: 640 },
		]) {
			await page.setViewportSize(viewport);
			await expectCardTable(
				page,
				table,
				page.getByRole("button", { name: /^详情：/ }).first(),
			);
		}
	});
}

for (const administrator of [false, true]) {
	test(`${administrator ? "platform" : "personal"} audit keeps three filters outside and the rest in more filters`, async ({
		page,
	}) => {
		const api = await fixture(page, administrator ? "admin" : "employee");
		await page.goto(administrator ? "/admin/audit" : "/audit");
		await expect(page.locator("table.audit-table")).toBeVisible();
		const form = page.getByRole("form", { name: "审计查询条件" });
		const more = form.getByRole("button", { name: /^更多筛选/ });
		// 默认只显示「起始时间」「动作」「结果」与收起的「更多筛选」。
		await expect(more).toHaveAttribute("aria-expanded", "false");
		const visibleLabels = async () =>
			(
				await form.locator("label").filter({ visible: true }).allTextContents()
			).filter(Boolean);
		expect(await visibleLabels()).toEqual(["起始时间", "动作", "结果"]);
		const grid = form.locator(".audit-filter-grid").first();
		const columns = await grid.evaluate((element) =>
			getComputedStyle(element)
				.gridTemplateColumns.split(" ")
				.map((value) => Math.round(Number.parseFloat(value))),
		);
		if (test.info().project.name === "desktop") {
			expect(columns).toHaveLength(4);
			for (const [index, width] of [466, 204, 204, 204].entries())
				expect(Math.abs((columns[index] ?? 0) - width)).toBeLessThanOrEqual(1);
			expect(
				await grid.evaluate((element) => getComputedStyle(element).columnGap),
			).toBe("10px");
		} else expect(columns).toHaveLength(1);
		await more.click();
		await expect(more).toHaveAttribute("aria-expanded", "true");
		expect(await visibleLabels()).toEqual([
			"起始时间",
			"动作",
			"结果",
			"结束时间",
			...(administrator ? ["主体类型", "主体 ID"] : []),
			"Agent",
			"Execution ID",
		]);
		const agentName = administrator ? "数据助手" : "写作助手";
		const agentId = administrator ? "agent-b" : "agent-audit-b";
		await form.getByRole("combobox", { name: "Agent", exact: true }).click();
		await page
			.getByRole("listbox", { name: "Agent搜索结果" })
			.getByRole("option", { name: new RegExp(agentName) })
			.click();
		await form.getByLabel("Execution ID", { exact: true }).fill("execution-a");
		const filtered = page.waitForRequest((request) => {
			const url = new URL(request.url());
			return url.searchParams.get("executionId") === "execution-a";
		});
		await form.getByRole("button", { name: "查询", exact: true }).click();
		const url = new URL((await filtered).url());
		expect(url.searchParams.get("agentId")).toBe(agentId);
		await expect(more).toHaveText("更多筛选（2）");
		await expect(more).toHaveAttribute("aria-expanded", "true");
		if (administrator) {
			// 校验错误落在隐藏字段：区域自动展开并聚焦出错字段。
			await form.getByLabel("主体类型", { exact: true }).selectOption("user");
			await more.click();
			await expect(more).toHaveAttribute("aria-expanded", "false");
			const before = api.requests.length;
			await form.getByRole("button", { name: "查询", exact: true }).click();
			await expect(form.getByRole("alert")).toHaveText(
				"主体类型和主体 ID 需要同时填写。",
			);
			await expect(more).toHaveAttribute("aria-expanded", "true");
			await expect(form.getByLabel("主体 ID", { exact: true })).toBeFocused();
			expect(api.requests.length).toBe(before);
		}
		// 「重置」清空全部字段并收起。
		await form.getByRole("button", { name: "重置", exact: true }).click();
		await expect(more).toHaveText("更多筛选");
		await expect(more).toHaveAttribute("aria-expanded", "false");
		await more.click();
		for (const label of ["Execution ID", "结束时间"])
			await expect(form.getByLabel(label, { exact: true })).toHaveValue("");
		await expect(
			form.getByRole("button", { name: `移除 ${agentName}`, exact: true }),
		).toHaveCount(0);
		await expect(
			form.getByRole("combobox", { name: "Agent", exact: true }),
		).toHaveValue("");
	});
}

test("audit list cells, detail facts and refresh icons follow the exported design", async ({
	page,
}) => {
	await fixture(page);
	const desktop = test.info().project.name === "desktop";
	await page.goto("/audit");
	const table = page.locator("table.audit-table");
	await expect(table).toBeVisible();
	const row = table.locator("tbody tr").first();
	// U-02：事件 strong 13px / 700；对象 ID small 11px 等宽。
	expect(
		await row
			.locator('[data-label="事件"] strong')
			.evaluate((element) => [
				getComputedStyle(element).fontSize,
				getComputedStyle(element).fontWeight,
			]),
	).toEqual(["13px", "700"]);
	const objectId = row.locator('[data-label="对象"] small');
	expect(
		await objectId.evaluate((element) => [
			getComputedStyle(element).fontSize,
			getComputedStyle(element).fontFamily,
		]),
	).toEqual(["11px", expect.stringMatching(/^ui-monospace/)]);
	// NI-108：每行只有「详情」一个按钮，没有 ID 展开 / 复制，也没有「审计 ID」行。
	await expect(row.getByRole("button")).toHaveCount(1);
	await expect(row.getByRole("button")).toHaveText("详情");
	await expect(table).not.toContainText("审计 ID");
	const height = (await row.boundingBox())?.height ?? 0;
	// 设计 1440 行高 73px；390 卡片设计 250px，基础表格卡片把 strong / small 纵向排列（设计为同一行），
	// 实测约 292px。上限用于拦截 NI-108 那种 ID 展开按钮把卡片撑到 576px 的回归。
	expect(height).toBeLessThanOrEqual(desktop ? 74 : 300);
	// 页头刷新为 44×44 ghost 图标按钮，图标为 RefreshCw 16px。
	const refresh = page.getByRole("button", { name: "刷新审计记录" });
	expect(await refresh.boundingBox()).toMatchObject({ width: 44, height: 44 });
	const icon = refresh.locator("svg");
	await expect(icon).toHaveClass(/lucide-refresh-cw/);
	expect(
		await icon.evaluate((svg) => [
			svg.getBoundingClientRect().width,
			svg.getBoundingClientRect().height,
		]),
	).toEqual([16, 16]);
	// U-01：详情标题为「事件 · 结果」，只有 1 个 h2，标题区没有徽章；关闭带 16px 图标。
	await row.getByRole("button", { name: /^详情：/ }).click();
	const panel = page.getByRole("region", { name: "审计详情", exact: true });
	await expect(panel.getByRole("heading", { level: 2 })).toHaveText(
		"任务 API 访问 · 访问获准",
	);
	await expect(panel.getByRole("heading", { level: 2 })).toHaveCount(1);
	await expect(panel.locator("header [data-slot=badge]")).toHaveCount(0);
	await expectAuditDetailHead(panel);
	const close = panel.getByRole("button", { name: /^关闭/ });
	expect(
		await close
			.locator("svg")
			.evaluate((svg) => svg.getBoundingClientRect().width),
	).toBe(16);
	await expect(
		panel.getByRole("button", { name: "刷新审计详情" }).locator("svg"),
	).toHaveClass(/lucide-refresh-cw/);
	const facts = panel.locator("dl").first();
	const layout = await facts.evaluate((element) => {
		const css = getComputedStyle(element);
		const pairs = [...element.querySelectorAll("dt")].map((dt) => {
			const dd = dt.nextElementSibling as HTMLElement;
			return Math.abs(
				dt.getBoundingClientRect().top - dd.getBoundingClientRect().top,
			);
		});
		return {
			columns: css.gridTemplateColumns.split(" "),
			gap: css.gap,
			fontSize: css.fontSize,
			dtColor: getComputedStyle(element.querySelector("dt") as Element).color,
			maxPairOffset: Math.max(...pairs),
			first: element.querySelector("dt")?.textContent,
			result: element.querySelector("dd [data-slot=badge]")?.textContent,
		};
	});
	const muted = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--muted-foreground)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	expect(layout.fontSize).toBe("13px");
	expect(layout.dtColor).toBe(muted);
	expect(layout.first).toBe("结果");
	expect(layout.result).toBe("访问获准");
	if (desktop) {
		expect(layout.columns[0]).toBe("150px");
		expect(layout.gap).toBe("10px 18px");
		expect(layout.maxPairOffset).toBeLessThanOrEqual(1);
	} else expect(layout.columns).toHaveLength(1);
	for (const label of ["审计 ID", "对象 ID", "请求尝试 ID", "Trace ID"])
		await expect(
			panel.locator("dt", { hasText: label }).locator("+ dd"),
		).toHaveCSS("font-family", /^ui-monospace/);
	// U-01：详情末尾的 page-note（12px、--muted-ink、margin-top 16px、无 role）。
	const note = panel.getByText(
		"只展示可审计元数据；不返回会话正文、Secret 值或模型内部思考。",
	);
	const noteStyle = await note.evaluate((element) => ({
		fontSize: getComputedStyle(element).fontSize,
		color: getComputedStyle(element).color,
		marginTop: getComputedStyle(element).marginTop,
		role: element.getAttribute("role"),
	}));
	const mutedInk = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--muted-ink)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	expect(noteStyle).toEqual({
		fontSize: "12px",
		color: mutedInk,
		marginTop: "16px",
		role: null,
	});
});

/**
 * 记录详情（/audit 与 /admin/audit 共用）：「记录详情」eyebrow 到标题 9px（E3-08，设计 .eyebrow
 * margin 4px 0 9px）；「可信操作主体」的 ID 次要行 11px / 18.15px 等宽，与列表 IdentifierText
 * 相同（E3-09）。
 */
async function expectAuditDetailHead(panel: Locator) {
	const eyebrow = panel.locator("header .page-eyebrow");
	await expect(eyebrow).toHaveText("记录详情");
	await expect(eyebrow).toHaveCSS("margin-bottom", "9px");
	const [eyebrowBox, titleBox] = await Promise.all([
		eyebrow.boundingBox(),
		panel.getByRole("heading", { level: 2 }).boundingBox(),
	]);
	if (!eyebrowBox || !titleBox) throw new Error("Missing audit detail head");
	expect(
		Math.abs(titleBox.y - eyebrowBox.y - eyebrowBox.height - 9),
	).toBeLessThanOrEqual(0.5);
	const principalId = panel
		.locator("dt", { hasText: /^可信操作主体$/ })
		.locator("+ dd small.font-mono");
	await expect(principalId).toHaveCount(1);
	await expect(principalId).toHaveCSS("font-size", "11px");
	await expect(principalId).toHaveCSS("line-height", "18.15px");
	await expect(principalId).toHaveCSS("font-family", /^ui-monospace/);
}

test("platform audit shows only server-permitted names and keeps IDs as IdentifierText (#2909)", async ({
	page,
}) => {
	const api = await fixture(page, "admin");
	await page.goto("/admin/audit");
	const objectCell = page.locator('.audit-table [data-label="对象"]');
	const principalCell = page.locator('.audit-table [data-label="主体"]');
	const detail = page.getByRole("region", { name: "审计详情", exact: true });
	const fact = (label: string) =>
		detail.locator("dt", { hasText: label }).locator("+ dd");
	await expect(objectCell).toHaveText("数据助手applicat…");
	// AC-1：ID 用 IdentifierText 截断，完整值在 title 与记录详情中展开。
	const identifier = objectCell.locator('[data-slot="identifier-text"] code');
	await expect(identifier).toHaveText("applicat…");
	await expect(identifier).toHaveAttribute(
		"title",
		governance.subject.subjectId,
	);
	const next = page.getByRole("button", { name: "下一页", exact: true });
	await next.click();
	await expect(objectCell).toHaveText("编程助手 · Executionexecutio…");
	await next.click();
	await expect(objectCell).toHaveText("编程助手agent-a");
	await expect(principalCell).toHaveText("应用 · 运维机器人");
	await expect(principalCell.locator("[title]")).toHaveAttribute(
		"title",
		applicationActorId,
	);
	await page.getByRole("button", { name: /^详情：/ }).click();
	await expect(fact("对象名称")).toHaveText("编程助手");
	await expect(fact("对象 ID")).toHaveText("agent-a");
	await expect(fact("可信操作主体")).toHaveText(
		`应用 · 运维机器人${applicationActorId}`,
	);
	await expectAuditDetailHead(detail);
	await page.keyboard.press("Escape");
	// AC-3：名称不可确认时只显示类型与 ID 短形式，也不说明原因。
	await next.click();
	await expect(objectCell).toHaveText("Agentagent-un…");
	await expect(principalCell).toHaveText("应用 applicat…");
	await page.getByRole("button", { name: /^详情：/ }).click();
	await expect(fact("对象名称")).toHaveText("未提供");
	await expect(fact("Agent 名称")).toHaveText("未提供");
	await expect(fact("对象 ID")).toHaveText(unnamedAgentId);
	// 页面只读 V2 入口，不回退到 V1 / V3。
	expect(
		api.requests.filter((request) =>
			/^\/api\/(v1\/audit|v3\/admin\/audit)/.test(request.path),
		),
	).toEqual([]);
	expect(api.requests.filter((request) => request.method !== "GET")).toEqual(
		[],
	);
});

for (const administrator of [false, true]) {
	test(`${administrator ? "platform" : "personal"} audit Agent filter selects by name and still submits the Agent ID (#2909)`, async ({
		page,
	}) => {
		const api = await fixture(page, administrator ? "admin" : "employee");
		await page.goto(administrator ? "/admin/audit" : "/audit");
		await expect(page.locator("table.audit-table")).toBeVisible();
		const listPath = administrator ? "/api/v2/admin/agents" : "/api/v2/agents";
		// 候选在展开选择器时才读取。
		expect(api.requests.filter((request) => request.path === listPath)).toEqual(
			[],
		);
		await page.getByRole("button", { name: /^更多筛选/ }).click();
		const picker = page.getByRole("combobox", { name: "Agent", exact: true });
		const results = page.getByRole("listbox", { name: "Agent搜索结果" });
		await picker.click();
		await expect(results).toBeVisible();
		expect(
			api.requests.filter((request) => request.path === listPath).length,
		).toBeGreaterThan(0);
		await expect(results.getByRole("option")).toHaveCount(2);
		await picker.fill("编程");
		await expect(results.getByRole("option")).toHaveCount(1);
		await expect(picker).toHaveAttribute(
			"aria-activedescendant",
			/agent-(audit-)?a$/,
		);
		await picker.press("Enter");
		await expect(results).toBeHidden();
		const chip = page.getByRole("button", {
			name: "移除 编程助手",
			exact: true,
		});
		await expect(chip).toBeVisible();
		const auditPath = administrator ? "/api/v4/admin/audit" : "/api/v2/audit";
		const filtered = page.waitForRequest((request) => {
			const url = new URL(request.url());
			return url.pathname === auditPath && url.searchParams.has("agentId");
		});
		await page.getByRole("button", { name: "查询", exact: true }).click();
		const url = new URL((await filtered).url());
		expect(url.searchParams.get("agentId")).toBe(
			administrator ? "agent-a" : "agent-audit-a",
		);
		expect([...url.searchParams.values()]).not.toContain("编程助手");
		await expect(
			page.getByRole("button", { name: "更多筛选（1）", exact: true }),
		).toBeVisible();
		// Esc 只收起结果层，不清除已选 Agent。
		await picker.click();
		await expect(results).toBeVisible();
		await picker.press("Escape");
		await expect(results).toBeHidden();
		await expect(chip).toBeVisible();
		await chip.click();
		await expect(chip).toHaveCount(0);
	});
}

// #2830 终验 V-08：个人审计按设计「筛选后直接是表格」，没有「审计范围」行和列表标题；
// 查询按钮与分页保留（PRD §13.2）。平台审计保留原 #400 的区头与「最小审计数据」（V-10）。
test("personal audit goes from filters straight to the table; platform audit keeps its timeline head (V-08, V-10)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/audit");
	const table = page.locator("table.audit-table");
	await expect(table).toBeVisible();
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	const main = page.locator("#main-content");
	await expect(main.getByText(/^审计范围：/)).toHaveCount(0);
	const records = main.getByRole("region", { name: "审计记录" });
	await expect(records.getByRole("heading")).toHaveCount(0);
	// 记录区的第一个块就是表格（容器），筛选表单之后没有标题或说明行。
	expect(
		await records.evaluate((section) => {
			const first = section.firstElementChild;
			return Boolean(first?.matches("table, :has(> table)"));
		}),
	).toBe(true);
	await expect(main.getByRole("button", { name: "查询" })).toBeVisible();
	await expect(main.getByRole("button", { name: "下一页" })).toBeVisible();
	// C2-06：设计 .audit-pagination 页码 14px / 1.65；「上一页 / 下一页」与「重置 / 查询」同为 .tag-row，间距 6px。
	await expectAuditPagination(page);
	// AC-2：同一页面没有同名控件，没有控制台错误与横向溢出。
	await expectNoDuplicateControls(page, "我的审计");
	await expectCleanPage(page, errors);

	await fixture(page, "admin");
	await page.goto("/admin/audit");
	const timelineTitle = main.getByRole("heading", {
		level: 2,
		name: "平台操作记录",
	});
	await expect(timelineTitle).toBeVisible();
	// C2-07、V-10：时间线标题为 16px / 600 / 1.5 正文字体，不用分区展示字体；
	// eyebrow「事件时间线」与右侧说明 14px / 1.65。
	const bodyFont = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.fontFamily = "var(--font-body)";
		document.body.append(probe);
		const font = getComputedStyle(probe).fontFamily;
		probe.remove();
		return font;
	});
	expect(
		await computed(timelineTitle, [
			"fontFamily",
			"fontSize",
			"fontWeight",
			"lineHeight",
			"marginTop",
		]),
	).toEqual({
		fontFamily: bodyFont,
		fontSize: "16px",
		fontWeight: "600",
		lineHeight: "24px",
		marginTop: "4px",
	});
	for (const text of ["事件时间线", "不包含会话正文、凭证值或模型内部思考"])
		expect(
			await computed(main.getByText(text, { exact: true }), [
				"fontSize",
				"lineHeight",
			]),
		).toEqual({ fontSize: "14px", lineHeight: "23.1px" });
	await expectAuditPagination(page);
	await expect(main.getByText("最小审计数据", { exact: true })).toBeVisible();
	// C2-08：设计 .notice > p 不放大、宽度随最长一行收缩；正文与导出稿同文，「。」后不多出空格。
	const minimalNotice = main.locator('[data-slot="alert"]', {
		hasText: "最小审计数据",
	});
	await expect(minimalNotice.locator('[data-slot="alert-content"]')).toHaveCSS(
		"flex-grow",
		"0",
	);
	await expect(
		minimalNotice.locator('[data-slot="alert-description"]'),
	).toHaveText(
		"记录谁在何时对哪个对象做了什么及其结果，不保存对话正文、凭证值或模型内部思考。Connection 授权与外部效果由独立 Connection 审计核实，关联引用不授予查询权限。",
	);
	await expectNoDuplicateControls(page, "平台审计");
	await expectCleanPage(page, errors);
});

/** 审计列表分页行与筛选按钮组（设计 .audit-pagination、.tag-row，C2-06）。 */
async function expectAuditPagination(page: Page) {
	const main = page.locator("#main-content");
	const pageText = main.getByText(/^第 \d+ 页 · 本页 \d+ 条$/);
	expect(await computed(pageText, ["fontSize", "lineHeight"])).toEqual({
		fontSize: "14px",
		lineHeight: "23.1px",
	});
	for (const [first, second] of [
		["上一页", "下一页"],
		["重置", "查询"],
	] as const) {
		const left = main.getByRole("button", { name: first, exact: true });
		const right = main.getByRole("button", { name: second, exact: true });
		expect(
			await left.evaluate(
				(element) =>
					getComputedStyle(element.parentElement as Element).columnGap,
			),
		).toBe("6px");
		const [leftBox, rightBox] = await Promise.all([
			left.boundingBox(),
			right.boundingBox(),
		]);
		if (!leftBox || !rightBox) throw new Error(`${first} / ${second} missing`);
		expect(Math.round(rightBox.y)).toBe(Math.round(leftBox.y));
		expect(
			Math.abs(rightBox.x - leftBox.x - leftBox.width - 6),
		).toBeLessThanOrEqual(0.5);
	}
}

// #3215 G5-09：「结果」筛选的选项不重名。started（单次操作已实际开始）与 processing（任务 / Execution
// 处理中）语义不同，分别为「已开始」「处理中」；查询仍提交原始枚举值。
for (const administrator of [false, true]) {
	test(`${administrator ? "platform" : "personal"} audit result options have distinct names (G5-09)`, async ({
		page,
	}, info) => {
		await page.setViewportSize(
			info.project.name === "mobile"
				? { width: 390, height: 844 }
				: { width: 1440, height: 900 },
		);
		await fixture(page, administrator ? "admin" : "employee");
		const route = administrator ? "/admin/audit" : "/audit";
		await page.goto(route);
		await expect(page.locator("table.audit-table")).toBeVisible();
		const result = page.getByLabel("结果", { exact: true });
		const options = await result
			.locator("option")
			.evaluateAll((nodes) =>
				nodes.map((node) => [
					(node as HTMLOptionElement).value,
					node.textContent?.trim() ?? "",
				]),
			);
		const labels = options.map(([, label]) => label);
		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.fromEntries(options)).toMatchObject({
			"": "全部结果",
			started: "已开始",
			processing: "处理中",
		});
		expect(labels.filter((label) => label === "执行中")).toEqual([]);
		const request = page.waitForRequest((candidate) => {
			const url = new URL(candidate.url());
			return (
				url.pathname.endsWith(administrator ? "/admin/audit" : "/audit") &&
				url.searchParams.get("result") === "processing"
			);
		});
		await result.selectOption({ label: "处理中" });
		await page.getByRole("button", { name: "查询", exact: true }).click();
		await request;
		await expectNoDuplicateControls(page, `${route}（G5-09）`);
	});
}

// 在 fixture 之前拦下匹配的审计读取，pause() 后挂起、resume() 后交回 fixture 应答。
async function holdReads(page: Page, pattern: RegExp) {
	let hold: Promise<void> | undefined;
	let release = () => {};
	await page.route(pattern, async (route) => {
		if (hold) await hold;
		await route.fallback();
	});
	return {
		pause() {
			hold = new Promise<void>((resolve) => {
				release = () => {
					hold = undefined;
					resolve();
				};
			});
		},
		resume: () => release(),
	};
}

// #3235 I6-01：页头「刷新审计记录」与详情「刷新审计详情」读取中为可聚焦的禁用（aria-disabled），
// 键盘与点击触发后焦点在读取中、读取后都留在按钮上；详情刷新后 Escape 仍关闭详情并回到
// 「详情：{事件} · {时间}」；详情重读失败或「重试详情」恢复时焦点交给详情区域（D2-59）。
for (const [route, role] of [
	["/audit", "employee"],
	["/admin/audit", "admin"],
] as const)
	for (const mode of ["keyboard", "click"] as const)
		test(`${route} refresh buttons keep focus and Escape still closes a refreshed detail (${mode}, I6-01)`, async ({
			page,
		}, info) => {
			const mobile = info.project.name === "mobile";
			await page.setViewportSize(
				mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
			);
			const pageErrors = trackPageErrors(page);
			const api = await fixture(page, role);
			const list = await holdReads(
				page,
				/\/api\/(v2\/audit|v4\/admin\/audit)(?:\?.*)?$/,
			);
			const detailReads = await holdReads(
				page,
				/\/api\/(v2\/audit|v4\/admin\/audit)\/[^/?]+(?:\?.*)?$/,
			);
			await page.goto(route);
			const main = page.locator("main");
			const detailTrigger = main.getByRole("button", { name: /^详情：/ });
			await expect(detailTrigger).toHaveCount(1);
			const press = async (button: Locator, elsewhere: Locator) => {
				if (mode === "keyboard") {
					await button.focus();
					await page.keyboard.press("Enter");
				} else {
					// 先把焦点放到别处，确认是点击本身把焦点交给按钮。
					await elsewhere.focus();
					await button.click();
				}
			};
			const reads = (detail: boolean) =>
				api.requests.filter(
					(request) =>
						/\/(v2\/audit|v4\/admin\/audit)(\/|$)/.test(request.path) &&
						/\/audit\/[^/]+$/.test(request.path) === detail,
				).length;

			// 页头刷新。
			const refresh = main.getByRole("button", { name: "刷新审计记录" });
			const listReads = reads(false);
			list.pause();
			await press(
				refresh,
				main.getByRole("button", { name: "查询", exact: true }),
			);
			await expect(refresh).toHaveAttribute("aria-disabled", "true");
			expect(
				await refresh.evaluate((node) => (node as HTMLButtonElement).disabled),
			).toBe(false);
			await expectFocusHeld(refresh, [50, 300], `${route} 页头刷新读取中`);
			await page.keyboard.press("Enter");
			list.resume();
			await expect(detailTrigger).toHaveCount(1);
			await expect(refresh).toBeEnabled();
			await expectFocusHeld(
				refresh,
				[50, 300, 1000, 1500],
				`${route} 页头刷新读取后`,
			);
			expect(reads(false) - listReads).toBe(1);

			// 详情刷新。
			await detailTrigger.click();
			const panel = page.getByRole("region", { name: "审计详情", exact: true });
			await expect(panel).toBeFocused();
			const detailRefresh = panel.getByRole("button", { name: "刷新审计详情" });
			await expect(detailRefresh).toBeEnabled();
			const heading = panel.getByRole("heading", { level: 2 });
			const title = await heading.textContent();
			expect(title).not.toBe("审计详情");
			const before = reads(true);
			detailReads.pause();
			await press(detailRefresh, panel);
			await expect(panel.getByText("正在读取审计详情…")).toBeVisible();
			await expect(detailRefresh).toHaveAttribute("aria-disabled", "true");
			await expectFocusHeld(
				detailRefresh,
				[50, 300],
				`${route} 详情刷新读取中`,
			);
			await page.keyboard.press("Enter");
			detailReads.resume();
			await expect(heading).toHaveText(title ?? "");
			await expect(detailRefresh).toBeEnabled();
			await expectFocusHeld(
				detailRefresh,
				[50, 300, 1000, 1500],
				`${route} 详情刷新读取后`,
			);
			expect(reads(true) - before).toBe(1);
			await expectNoDuplicateControls(page, `${route}（I6-01）`);
			await expectCleanPage(page, pageErrors);
			// 详情刷新后 Escape 仍关闭详情，焦点回到触发它的「详情：{事件} · {时间}」。
			await page.keyboard.press("Escape");
			await expect(panel).toHaveCount(0);
			await expect(detailTrigger).toBeFocused();
			await expectFocusHeld(
				detailTrigger,
				[50, 300],
				`${route} 详情刷新后 Escape`,
			);

			// 详情重读失败：刷新按钮随内容卸载，焦点交给详情区域，Escape 仍可关闭。
			await detailTrigger.click();
			await expect(detailRefresh).toBeEnabled();
			api.failNext();
			await press(detailRefresh, panel);
			const failure = panel
				.getByRole("alert")
				.filter({ hasText: "审计详情读取失败" });
			await expect(failure).toBeVisible();
			await expect(panel).toBeFocused();
			await expectFocusHeld(panel, [50, 300, 1000], `${route} 详情刷新失败后`);
			// 「重试详情」恢复后按钮随失败提示卸载，焦点同样交给详情区域。
			await press(failure.getByRole("button", { name: "重试详情" }), panel);
			await expect(failure).toHaveCount(0);
			await expect(detailRefresh).toBeEnabled();
			await expect(panel).toBeFocused();
			await expectFocusHeld(panel, [50, 300, 1000], `${route} 重试详情恢复后`);
			await page.keyboard.press("Escape");
			await expect(panel).toHaveCount(0);
			await expect(detailTrigger).toBeFocused();
			await expect(page.getByText("private fixture error")).toHaveCount(0);
		});

// #3242 K7-02：「查询」「重置」「上一页」「下一页」读取中是可聚焦的禁用（aria-disabled），键盘 Enter 后
// 挂起期间多次采样焦点都在按钮上；读完后焦点留在按钮上，翻到首页或末页、按钮随之禁用时交给另一个
// 分页按钮（D2-59），不落到 body。
async function acceptanceViewport(page: Page, info: TestInfo) {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
}

test("audit query, reset and pagination keep focus on the pending button and hand it on at the edges (K7-02)", async ({
	page,
}, info) => {
	await acceptanceViewport(page, info);
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/audit");
	const main = page.locator("main");
	await expect(main.getByText("第 1 页 · 本页 1 条")).toBeVisible();
	const read = async (
		button: Locator,
		context: string,
		settled: Locator,
		pageText: string,
	) => {
		const reading = await holdRequests(page, "GET", "/api/v2/audit");
		await button.focus();
		await page.keyboard.press("Enter");
		await expectFocusableBusy(button, context);
		expect(reading.held()).toBe(1);
		reading.release();
		await expect(main.getByText(pageText)).toBeVisible();
		await expectFocusSettled(settled, context);
	};
	const query = await pinElement(
		main.getByRole("button", { name: "查询", exact: true }),
		"audit-query",
	);
	const reset = await pinElement(
		main.getByRole("button", { name: "重置", exact: true }),
		"audit-reset",
	);
	const previous = await pinElement(
		main.getByRole("button", { name: "上一页", exact: true }),
		"audit-previous",
	);
	const next = await pinElement(
		main.getByRole("button", { name: "下一页", exact: true }),
		"audit-next",
	);
	await read(query, "查询", query, "第 1 页 · 本页 1 条");
	await read(reset, "重置", reset, "第 1 页 · 本页 1 条");
	// 两条记录、每页一条：翻到第 2 页即末页，「下一页」禁用，焦点交给「上一页」。
	await read(next, "下一页（到末页）", previous, "第 2 页 · 本页 1 条");
	await expect(next).toBeDisabled();
	// 回到第 1 页，「上一页」禁用，焦点交给「下一页」。
	await read(previous, "上一页（到首页）", next, "第 1 页 · 本页 1 条");
	await expect(previous).toBeDisabled();
	await expectNoDuplicateControls(page, "我的执行审计（K7-02）");
	await expectCleanPage(page, errors);
});
