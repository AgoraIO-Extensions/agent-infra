import {
	ApplicationMetadataV1Schema,
	PersonalApiCredentialPageV1Schema,
	PersonalRelayKeyStateV1Schema,
	SkillHubDirectoryPageV1Schema,
	SkillHubInstallationPageV1Schema,
	SkillHubOwnedVersionPageV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubVersionDetailV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";
import {
	expectFocusableBusy,
	expectFocusSettled,
	expectNoDuplicateControls,
	holdRequests,
	pinElement,
} from "./page-health";
import { expectCleanPage, trackPageErrors } from "./primitive-styles";

// #3292（#2830 终验第九轮）：员工打开系统管理页的无权限状态（N9-3-01），Skill Hub 与设置页读取
// 401 的「登录已过期」与「重新登录」（N9-3-04）。两视口：desktop 按导出稿 1440×900，mobile 390×844。

const employee = {
	schemaVersion: 1,
	user: {
		userId: "access-states-employee",
		displayName: "状态员工",
		roles: ["employee"],
	},
};
const failure = (status: number) => ({
	schemaVersion: 1,
	code: status === 401 ? "AUTHENTICATION_REQUIRED" : "RESOURCE_UNAVAILABLE",
	message: "Controlled access state",
	retryable: false,
	traceId: "trace-access-states",
});

/**
 * 受控平台：会话固定有效并记录读取次数；expired 中的路径在 recover() 前返回 401，之后按 ok 返回；
 * 其余 API 返回 404。请求记录只保留方法与路径。
 */
async function platform(
	page: Page,
	responses: Record<string, unknown> = {},
	expired: readonly string[] = [],
) {
	const reads: string[] = [];
	let sessionReads = 0;
	let recovered = false;
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET") reads.push(path);
		if (path === "/api/v1/session") {
			sessionReads += 1;
			return route.fulfill({ json: employee });
		}
		if (path === "/api/v1/connection/capability")
			return route.fulfill({
				json: { schemaVersion: 1, status: "unavailable", reason: "missing" },
			});
		if (request.method() === "GET" && expired.includes(path) && !recovered)
			return route.fulfill({ status: 401, json: failure(401) });
		if (request.method() === "GET" && path in responses)
			return route.fulfill({ json: responses[path] });
		return route.fulfill({ status: 404, json: failure(404) });
	});
	return {
		reads,
		sessionReads: () => sessionReads,
		recover() {
			recovered = true;
		},
	};
}

async function designViewport(page: Page, mobile: boolean) {
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
}

const adminPages = [
	{
		path: "/admin/approvals",
		eyebrow: "系统管理 / 创建审批",
		heading: "审批申请",
		description: "当前无权访问创建审批。",
	},
	{
		path: "/admin/agents",
		eyebrow: "系统管理 / Agent 管理",
		heading: "查看 Agent 状态",
		description: "当前无权访问 Agent 管理。",
	},
	{
		path: "/admin/skill-reviews",
		eyebrow: "系统管理 / Skill 审核",
		heading: "Skill 发布审核",
		description: "当前无权访问 Skill 审核。",
	},
	{
		path: "/admin/audit",
		eyebrow: "系统管理 / 平台审计",
		heading: "查看平台变更记录。",
		description: "当前无权访问平台审计。",
	},
] as const;

test("employees opening system administration pages get the page head and one unauthorized card (N9-3-01)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	await designViewport(page, mobile);
	const errors = trackPageErrors(page);
	const control = await platform(page);
	for (const target of adminPages) {
		await page.goto(target.path);
		const main = page.locator("#main-content");
		// 每页都有 eyebrow 与 h1（原审批与平台审计只有一条 warn 提示）。
		await expect(main.getByRole("heading", { level: 1 })).toHaveText(
			target.heading,
		);
		await expect(main.locator(".page-eyebrow")).toHaveText(target.eyebrow);
		const card = main.locator('[data-slot="state-card"]');
		await expect(card).toHaveCount(1);
		await expect(card).toHaveAttribute("data-kind", "unauthorized");
		await expect(card.getByRole("heading", { level: 2 })).toHaveText("未授权");
		await expect(
			card.locator('[data-slot="state-card-description"]'),
		).toHaveText(target.description);
		await expect(
			card.getByRole("link", { name: "返回工作台", exact: true }),
		).toHaveAttribute("href", "/");
		// 四页同一种呈现：没有 warn 提示、Skill 空态与页头工具；静态边界不是 live region。
		await expect(card).not.toHaveAttribute("role", /.*/);
		await expect(
			main.locator('[role="alert"], [role="status"], [aria-live]'),
		).toHaveCount(0);
		await expect(main.locator('[data-slot="alert"]')).toHaveCount(0);
		await expect(main.locator('[data-slot="empty"]')).toHaveCount(0);
		await expect(main.getByRole("button")).toHaveCount(0);
		const [head, box] = await Promise.all([
			main.locator(".page-heading").boundingBox(),
			card.boundingBox(),
		]);
		expect(
			(box?.y ?? 0) - ((head?.y ?? 0) + (head?.height ?? 0)),
		).toBeGreaterThanOrEqual(0);
		await expectNoDuplicateControls(page, target.path);
		await expectCleanPage(page, errors);
		await info.attach(`n9-3-01${target.path.replaceAll("/", "-")}`, {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	}
	// 员工不发出系统管理读取。
	expect(
		control.reads.filter((path) =>
			/^\/api\/v2\/(admin|audit|skills\/reviews)/.test(path),
		),
	).toEqual([]);
});

const skillVersion = {
	schemaVersion: 1,
	skillId: "access-notes",
	skillVersionId: "access-notes-v1",
	name: "access-notes",
	version: "1.0.0",
	provider: "my_library",
	visibility: "PRIVATE",
	state: "published",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
} as const;
const emptyPage = { items: [], nextCursor: null };
const application = ApplicationMetadataV1Schema.parse({
	applicationId: "access-application-1",
	authorizationRevision: "access-revision-1",
	createdAt: "2026-10-10T00:00:00Z",
	name: "Access build service",
	responsibleUserId: employee.user.userId,
	status: "active",
	updatedAt: "2026-10-10T00:00:00Z",
});

const reloginPages = [
	{
		name: "Skill Hub directory",
		path: "/skills",
		heading: "Skill Hub",
		expired: ["/api/v2/skills"],
		buttons: ["重新登录"],
		recovered: "目录中还没有 Skill",
	},
	{
		name: "Skill version detail",
		path: `/skills/${skillVersion.skillVersionId}`,
		heading: "Skill 详情",
		expired: [`/api/v2/skills/versions/${skillVersion.skillVersionId}/detail`],
		buttons: ["重新登录"],
		recovered: "用途与内容",
		recoveredHeading: skillVersion.name,
	},
	{
		name: "My Skill",
		path: "/skills/manage",
		heading: "我的 Skill",
		expired: ["/api/v2/skills/installations", "/api/v2/skills/projects"],
		// 两个分区同时 401：按钮名称带分区名，可见文字都是「重新登录」（N9-3-05）。
		buttons: ["重新登录：已安装", "重新登录：我创建的"],
		recovered: "我的库还是空的",
	},
	{
		name: "personal Relay Key",
		path: "/my-settings/relay-key",
		heading: "个人 Relay Key",
		expired: ["/api/v2/me/relay-key"],
		buttons: ["重新登录"],
		recovered: "接入个人 Key",
	},
	{
		name: "API credentials",
		path: `/my-settings/api-credentials?applicationId=${application.applicationId}`,
		heading: "API 凭证",
		expired: [
			"/api/v2/me/api-credentials",
			`/api/v2/applications/${application.applicationId}`,
		],
		// 个人凭证列表与应用管理同时 401：应用管理的按钮带分区名。
		buttons: ["重新登录", "重新登录：应用管理"],
		recovered: "暂无个人 API 凭证",
	},
] as const;

const reloginResponses = {
	"/api/v2/skills": SkillHubDirectoryPageV1Schema.parse(emptyPage),
	"/api/v2/skills/owned-versions":
		SkillHubOwnedVersionPageV1Schema.parse(emptyPage),
	"/api/v2/skills/installations":
		SkillHubInstallationPageV1Schema.parse(emptyPage),
	"/api/v2/skills/projects": SkillHubProjectPageV1Schema.parse(emptyPage),
	[`/api/v2/skills/versions/${skillVersion.skillVersionId}/detail`]:
		SkillHubVersionDetailV1Schema.parse({
			...skillVersion,
			ownerId: "access-other-owner",
			installation: { state: "not_installed" },
			content: {
				state: "available",
				body: "# access-notes\n受控说明。\n",
				bodyTruncated: false,
				resources: [],
			},
		}),
	"/api/v2/me/relay-key": PersonalRelayKeyStateV1Schema.parse({
		schemaVersion: 1,
		isSet: false,
		keyVersion: null,
	}),
	"/api/v2/me/api-credentials":
		PersonalApiCredentialPageV1Schema.parse(emptyPage),
	[`/api/v2/applications/${application.applicationId}`]: application,
};

for (const target of reloginPages) {
	test(`a 401 read on ${target.name} asks to sign in again and re-reads when the session is still valid (N9-3-04)`, async ({
		page,
	}, info) => {
		const mobile = info.project.name === "mobile";
		await designViewport(page, mobile);
		const errors = trackPageErrors(page);
		const control = await platform(page, reloginResponses, target.expired);
		await page.goto(target.path);
		const main = page.locator("#main-content");
		await expect(
			main.getByRole("heading", { level: 1, name: target.heading }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: target.buttons[0], exact: true }),
		).toBeVisible();
		// 登录失效不是「找管理员」：没有「请联系管理员」「暂时无法访问」，每处 401 都有「重新登录」。
		await expect(main).not.toContainText("请联系管理员");
		await expect(main).not.toContainText("暂时无法访问");
		await expect(main).toContainText("登录状态已失效，请重新登录后再试。");
		const buttons = main.getByRole("button", { name: /^重新登录/ });
		await expect(buttons).toHaveCount(target.buttons.length);
		for (const [index, name] of target.buttons.entries()) {
			await expect(buttons.nth(index)).toHaveAccessibleName(name);
			await expect(buttons.nth(index)).toHaveText("重新登录");
		}
		await expectNoDuplicateControls(page, `${target.name} 401`);
		await expectCleanPage(page, errors);
		await info.attach(`n9-3-04-${target.name.replaceAll(" ", "-")}`, {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});

		// 会话仍有效：先确认会话（挂起时触发按钮仍持有焦点或交给 h1，不落到 body），再重读失败的读取。
		const sessionReads = control.sessionReads();
		const hold = await holdRequests(page, "GET", "/api/v1/session");
		const trigger = await pinElement(buttons.first(), "relogin");
		await trigger.focus();
		await page.keyboard.press("Enter");
		await expect.poll(() => hold.held()).toBeGreaterThanOrEqual(1);
		// 失败提示在确认期间保留的页面（设置页），触发按钮是可聚焦的禁用；Skill Hub 确认期间换成读取中，
		// 按钮卸载后焦点交给页面 h1（读取页的 h1 不可聚焦时为 #main-content）。
		if ((await trigger.count()) === 1)
			await expectFocusableBusy(
				trigger,
				`${target.name} 确认会话中`,
				[30, 150],
			);
		else
			expect(
				await page.evaluate(() => {
					const active = document.activeElement;
					return active?.id === "main-content" || active?.tagName === "H1";
				}),
				`${target.name} 确认会话中的焦点`,
			).toBe(true);
		control.recover();
		hold.release();
		await expect
			.poll(() => control.sessionReads())
			.toBeGreaterThan(sessionReads);
		await expect(main.getByText(target.recovered).first()).toBeVisible();
		await expect(main.getByRole("button", { name: /^重新登录/ })).toHaveCount(
			0,
		);
		await expect(main).not.toContainText("登录已过期");
		const recoveredHeading = main.getByRole("heading", {
			level: 1,
			name:
				"recoveredHeading" in target ? target.recoveredHeading : target.heading,
		});
		// 恢复后焦点在页面 h1（D2-59），不落到 body。
		await expectFocusSettled(
			recoveredHeading,
			`${target.name} 恢复后`,
			[50, 300, 1000],
		);
		for (const path of target.expired)
			expect(
				control.reads.filter((read) => read === path).length,
				`${path} 重读`,
			).toBeGreaterThanOrEqual(2);
		// 整页没有重新加载。
		expect(
			await page.evaluate(
				() => performance.getEntriesByType("navigation").length,
			),
		).toBe(1);
		await expectCleanPage(page, errors);
	});
}
