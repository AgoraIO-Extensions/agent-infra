import { expect, test } from "@playwright/test";

const session = (role: "employee" | "admin") => ({
	schemaVersion: 1,
	user: {
		userId: role === "admin" ? "audit-admin" : "audit-user-a",
		displayName: role === "admin" ? "审计管理员" : "审计用户",
		roles: role === "admin" ? ["employee", "system_admin"] : ["employee"],
	},
});

function record(auditId: string) {
	return {
		schemaVersion: 1,
		auditId,
		action: "task.api.access",
		actor: { kind: "user", actorId: "audit-user-a" },
		subject: { kind: "agent", subjectId: "agent-a" },
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
		executionId: `execution-${auditId}`,
		authorizationRecordId: null,
		originalPrincipal: { kind: "user", id: "audit-user-a" },
		executor: null,
		operation: null,
	};
}

async function fixture(
	page: import("@playwright/test").Page,
	role: "employee" | "admin" = "employee",
) {
	let failNext = false;
	await page.route(/\/api\/v1\/session$/, (route) =>
		route.fulfill({ status: 200, json: session(role) }),
	);
	await page.route(
		/\/api\/(v1\/audit|v3\/admin\/audit)(\/.*)?(?:\?.*)?$/,
		async (route) => {
			const request = route.request();
			if (failNext) {
				failNext = false;
				await route.fulfill({
					status: 503,
					json: {
						code: "DEPENDENCY_UNAVAILABLE",
						message: "private fixture error",
					},
				});
				return;
			}
			const url = new URL(request.url());
			if (url.pathname.endsWith("/audit-a")) {
				await route.fulfill({ status: 200, json: record("audit-a") });
				return;
			}
			if (url.pathname.endsWith("/audit-b")) {
				await route.fulfill({ status: 200, json: record("audit-b") });
				return;
			}
			await route.fulfill({
				status: 200,
				json: {
					items: [
						record(url.searchParams.has("cursor") ? "audit-b" : "audit-a"),
					],
					nextCursor: url.searchParams.has("cursor") ? null : "cursor-next",
				},
			});
		},
	);
	return { failNext: () => (failNext = true) };
}

test("own audit page filters, paginates, opens detail, and fits mobile", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const api = await fixture(page);
	await page.goto("/audit");
	await expect(
		page.getByRole("heading", { name: "我的执行审计", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "查看审计详情" })).toHaveCount(
		1,
	);
	await page
		.getByLabel("动作", { exact: true })
		.selectOption("task.api.access");
	await page.getByRole("button", { name: "查询", exact: true }).click();
	await expect(page.getByText("访问获准")).toBeVisible();
	await page.getByRole("button", { name: "下一页", exact: true }).click();
	await expect(page.getByText("execution-audit-b")).toBeVisible();
	await page.getByRole("button", { name: "查看审计详情" }).click();
	await expect(page.getByRole("dialog")).toContainText("execution-audit-b");
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
	await expect(page.getByRole("alert")).toContainText("审计查询失败");
	await expect(page.getByText("private fixture error")).toHaveCount(0);
});

test("administrator audit route is available only in the administrator session", async ({
	page,
}, info) => {
	await fixture(page, "admin");
	await page.goto("/admin/audit");
	await expect(
		page.getByRole("heading", { name: "平台审计", exact: true }),
	).toBeVisible();
	if (info.project.name === "mobile")
		await page.getByRole("button", { name: "打开导航" }).click();
	await expect(
		page.getByRole("link", { name: "审计日志", exact: true }).first(),
	).toBeVisible();
	if (info.project.name === "mobile")
		await page.getByRole("button", { name: "关闭导航" }).click();
	await page.getByLabel("主体类型", { exact: true }).selectOption("user");
	await page.getByLabel("主体 ID", { exact: true }).fill("audit-user-a");
	await page.getByRole("button", { name: "查询", exact: true }).click();
	await expect(page.getByRole("button", { name: "查看审计详情" })).toHaveCount(
		1,
	);
});
