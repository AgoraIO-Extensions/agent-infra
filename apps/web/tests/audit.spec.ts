import {
	PilotProtocolErrorV1Schema,
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";
import { captureDesignContract, designViewports } from "./design-contract";

const session = (role: "employee" | "admin") => ({
	schemaVersion: 1,
	user: {
		userId: role === "admin" ? "audit-admin" : "audit-user-a",
		displayName: role === "admin" ? "审计管理员" : "审计用户",
		roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
	},
});

function record(auditId: string, userId = "audit-user-a") {
	return ScopedPlatformAuditProjectionV1Schema.parse({
		schemaVersion: 1,
		auditId,
		action: "task.api.access",
		actor: { kind: "user", actorId: userId },
		subject: { kind: "agent", subjectId: `agent-${auditId}` },
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
	});
}

const governance = ScopedPlatformAuditProjectionV1Schema.parse({
	...record("audit-a"),
	action: "agent.application.submitted",
	subject: {
		kind: "agent_application",
		subjectId: `application-${"safe".repeat(18)}`,
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
const background = ScopedPlatformAuditProjectionV1Schema.parse({
	...record("audit-b"),
	action: "task.status.changed",
	actor: { kind: "system", actorId: "platform_worker" },
	subject: {
		kind: "execution",
		subjectId: backgroundExecutionId,
	},
	result: "unknown",
	summary: "后台执行结果待核实；不能把请求受理或启动当作执行成功。".repeat(3),
	taskApi: null,
	agentId: "agent-a",
	executionId: backgroundExecutionId,
	authorizationRecordId: "authorization-background-a",
	originalPrincipal: { kind: "user", id: "audit-user-a" },
	executor: "platform_worker",
});

async function fixture(page: Page, role: "employee" | "admin" = "employee") {
	let failNext = false;
	let emptyNext = false;
	let holdDetail = false;
	let roles = session(role).user.roles;
	const ownRecords = ["audit-a", "audit-b"].map((id) =>
		record(id, session(role).user.userId),
	);
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
	await page.route(/\/api\/v1\/session$/, (route) =>
		route.fulfill({
			status: 200,
			json: { ...session(role), user: { ...session(role).user, roles } },
		}),
	);
	await page.route(
		/\/api\/(v1\/audit|v3\/admin\/audit)(\/.*)?(?:\?.*)?$/,
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const records = url.pathname.startsWith("/api/v3/admin/audit")
				? [governance, background]
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
			const index = url.searchParams.has("cursor") ? 1 : 0;
			await route.fulfill({
				status: 200,
				json: ScopedPlatformAuditPageV1Schema.parse({
					items: emptyNext ? [] : filtered.slice(index, index + 1),
					nextCursor:
						!emptyNext && index === 0 && filtered.length > 1
							? "cursor-next"
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
		page.getByRole("heading", { name: "只看自己的执行事实。", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "查看审计详情" })).toHaveCount(
		1,
	);
	await page
		.getByLabel("动作", { exact: true })
		.selectOption("task.api.access");
	await page.getByRole("button", { name: "查询", exact: true }).click();
	await expect(page.getByText("访问获准", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "下一页", exact: true }).click();
	await expect(page.getByText("agent-audit-b", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Execution：未提供", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "查看审计详情" }).click();
	await expect(
		page.getByRole("region", { name: "审计详情", exact: true }),
	).toContainText("agent-audit-b");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "查看审计详情" }),
	).toBeFocused();
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
				name: "复核平台关键变更。",
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
		await expect(row).toContainText(governance.subject.subjectId);
		await expect(row).toContainText("创建申请");
		await expect(row).toContainText("Execution：未提供");
		await expect(row.getByText("已受理", { exact: true })).toBeVisible();
		await expect(row.getByText("成功", { exact: true })).toHaveCount(0);
		await expect(page.getByText("最小审计数据", { exact: true })).toBeVisible();
		await expect(page.getByText(/关联引用不授予查询权限/)).toBeVisible();
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
		await expect(worker).toContainText(background.subject.subjectId);
		await expect(worker.locator('[data-label="操作主体"]')).toContainText(
			"可信操作主体 · 后台组件",
		);
		await expect(worker.locator('[data-label="操作主体"]')).toContainText(
			"platform_worker",
		);
		await expect(worker.locator('[data-label="操作主体"]')).toContainText(
			"原发起主体 · 用户：audit-user-a",
		);
		await expect(worker.getByText("结果待核实", { exact: true })).toBeVisible();
		await worker.getByRole("button", { name: "查看审计详情" }).click();
		const dialog = page.getByRole("region", { name: "审计详情", exact: true });
		await expect(dialog).toContainText(background.summary);
		await expect(dialog).toContainText("后台组件 · platform_worker");
		await expect(dialog).toContainText("用户 · audit-user-a");
		await expect(dialog).toContainText("实际后台组件");
		await info.attach("controlled-original-audit-detail-viewport", {
			body: await page.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});
		await expect(
			dialog.getByRole("heading", { name: "审计详情", exact: true }),
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
		await expect(
			worker.getByRole("button", { name: "查看审计详情" }),
		).toBeFocused();
		await page.getByLabel("起始时间", { exact: true }).fill("2026-09-27T00:00");
		await page.getByLabel("结束时间", { exact: true }).fill("2026-09-29T00:00");
		await page.getByLabel("主体类型", { exact: true }).selectOption("user");
		await page.getByLabel("主体 ID", { exact: true }).fill("audit-user-a");
		await page.getByLabel("Agent ID", { exact: true }).fill("agent-a");
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
				url.pathname === "/api/v3/admin/audit" &&
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
			page.getByRole("heading", { name: "只看自己的执行事实。", exact: true }),
		).toBeVisible();
		await expect(page.locator(".audit-table")).toContainText("audit-admin");
		await expect(page.locator(".audit-table")).not.toContainText(
			"audit-user-a",
		);
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
	await expect(page.getByRole("button", { name: "查看审计详情" })).toHaveCount(
		0,
	);
	expect(
		api.requests.filter((request) =>
			request.path.startsWith("/api/v3/admin/audit"),
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
			if (!new URL(request.url).pathname.startsWith("/api/v3/admin/audit/"))
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
		await page.getByRole("button", { name: "查看审计详情" }).click();
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
		await expect(
			page.getByRole("button", { name: "查看审计详情" }),
		).toHaveCount(0);
		expect(api.requests.filter((request) => request.method !== "GET")).toEqual(
			[],
		);
	} finally {
		api.releaseDetail();
	}
});

for (const route of ["/audit", "/admin/audit"]) {
	test(`exported design viewport matrix ${route}`, async ({ page }, info) => {
		test.skip(
			info.project.name !== "desktop",
			"The exported nine-viewport matrix runs once.",
		);
		await fixture(page, route === "/audit" ? "employee" : "admin");
		await page.goto(route);
		await expect(
			page.getByRole("button", { name: "查看审计详情" }).first(),
		).toBeVisible();
		for (const viewport of designViewports) {
			await page.setViewportSize(viewport);
			await captureDesignContract(page, info, route.replaceAll("/", "-"));
		}
	});
}
