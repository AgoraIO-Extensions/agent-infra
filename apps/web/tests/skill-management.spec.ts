import {
	SkillHubDirectoryPageV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubProviderImportRequestV1Schema,
	SkillHubPublicationResponseV1Schema,
	SkillHubReviewQueueItemV1Schema,
	SkillHubReviewQueuePageV1Schema,
	SkillHubReviewRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";

// 我的 Skill、创建与发布、Skill 审核（K-03、K-04 与防回归 NI-31、NI-74）。
const userId = "skill-management-user";
const project = {
	schemaVersion: 1,
	projectId: "release-notes",
	name: "release-notes",
	ownerId: userId,
	organizationId: null,
	status: "active",
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
} as const;

async function fixture(page: Page, role: "employee" | "admin" = "employee") {
	const writes: { method: string; path: string; body: unknown }[] = [];
	const reads: string[] = [];
	// 待审队列按服务端规则回读：审核成功后该版本离开队列。
	const pending = [
		reviewItem("incident-summary", "user-other", "ORGANIZATION", "org-release"),
		reviewItem("release-notes", userId, "MARKET", null),
		reviewItem("weekly-digest", "user-latin", "MEMBER", null),
	];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === "GET") reads.push(path);
		else
			writes.push({
				method: request.method(),
				path,
				body: request.postDataJSON(),
			});
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId,
						displayName: "Skill 管理员",
						roles:
							role === "admin" ? ["employee", "system_admin"] : ["employee"],
					},
				},
			});
		if (path === "/api/v2/skills")
			return route.fulfill({
				json: SkillHubDirectoryPageV1Schema.parse({
					items: [
						{
							schemaVersion: 1,
							skillId: "release-notes",
							skillVersionId: "release-notes-v1",
							name: "release-notes",
							version: "1.2.0",
							provider: "my_library",
							visibility: "PRIVATE",
							state: "published",
							packageDigest: "a".repeat(64),
							manifestDigest: "b".repeat(64),
							signatureDigest: "c".repeat(64),
						},
					],
					nextCursor: null,
				}),
			});
		if (path === "/api/v2/skills/projects" && request.method() === "GET")
			return route.fulfill({
				json: SkillHubProjectPageV1Schema.parse({
					items: [project, { ...project, projectId: "draft", name: "draft" }],
					nextCursor: null,
				}),
			});
		if (path === "/api/v2/skills/imports" && request.method() === "POST") {
			const body = SkillHubProviderImportRequestV1Schema.parse(
				request.postDataJSON(),
			);
			return route.fulfill({
				status: 201,
				json: SkillHubPublicationResponseV1Schema.parse({
					replayed: false,
					version: {
						schemaVersion: 1,
						skillId: "release-notes",
						skillVersionId: "release-notes-v2",
						provider: body.provider,
						version: body.version,
						packageDigest: "a".repeat(64),
						manifestDigest: "b".repeat(64),
						signatureDigest: "c".repeat(64),
						visibility: "PRIVATE",
						state: "pending_review",
						needUpgrade: false,
						reviewedBy: null,
						reviewReason: null,
						revokedAt: null,
					},
				}),
			});
		}
		if (path === "/api/v2/skills/reviews" && role === "admin")
			return route.fulfill({
				json: SkillHubReviewQueuePageV1Schema.parse({
					items: pending,
					nextCursor: null,
				}),
			});
		const reviewPath = path.match(
			/^\/api\/v2\/skills\/versions\/([^/]+)\/review$/,
		);
		if (reviewPath && request.method() === "POST" && role === "admin") {
			const body = SkillHubReviewRequestV1Schema.parse(request.postDataJSON());
			const index = pending.findIndex(
				(item) => item.skillVersionId === reviewPath[1],
			);
			const [item] = pending.splice(index, 1);
			if (!item) throw new Error("review fixture missing");
			return route.fulfill({
				json: SkillHubPublicationResponseV1Schema.parse({
					replayed: false,
					version: {
						schemaVersion: 1,
						skillId: item.skillId,
						skillVersionId: item.skillVersionId,
						provider: item.provider,
						version: item.version,
						packageDigest: item.packageDigest,
						manifestDigest: item.manifestDigest,
						signatureDigest: item.signatureDigest,
						visibility: item.visibility,
						state: body.decision === "approve" ? "published" : "rejected",
						needUpgrade: false,
						reviewedBy: userId,
						reviewReason: body.reason ?? null,
						revokedAt: null,
					},
				}),
			});
		}
		if (path === "/api/v2/directory/search") {
			const url = new URL(request.url());
			const ids = url.searchParams.get("ids")?.split(",") ?? [];
			return route.fulfill({
				json: {
					items: [
						{ kind: "user", canonicalId: "user-other", displayName: "周可" },
						{
							kind: "user",
							canonicalId: "user-latin",
							displayName: "Alex Chen",
						},
						{ kind: "user", canonicalId: userId, displayName: "Skill 管理员" },
						{
							kind: "organization",
							canonicalId: "org-release",
							displayName: "发布工程",
						},
					].filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							ids.includes(item.canonicalId),
					),
				},
			});
		}
		return route.fulfill({
			status: 404,
			json: {
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Not part of Skill management fixture",
				retryable: false,
				traceId: "trace-skill-management",
			},
		});
	});
	return { writes, reads };
}

function reviewItem(
	name: string,
	ownerId: string,
	visibility: "MEMBER" | "ORGANIZATION" | "MARKET",
	organizationId: string | null,
) {
	return SkillHubReviewQueueItemV1Schema.parse({
		schemaVersion: 1,
		skillId: name,
		skillVersionId: `${name}-v1`,
		name,
		provider: "github",
		version: "1.0.0",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
		visibility,
		organizationId,
		state: "pending_review",
		ownerId,
		submittedAt: "2026-10-01T08:00:00Z",
	});
}

async function fitsViewport(page: Page) {
	for (const [width, height] of [
		[390, 844],
		[320, 640],
	] as const) {
		await page.setViewportSize({ width, height });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
	}
}

test("My Skill lists the user's projects with the same group in eyebrow, breadcrumb and navigation", async ({
	page,
}) => {
	await fixture(page);
	await page.goto("/skills/manage");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 1, name: "我的 Skill" }),
	).toBeVisible();
	// NI-74：eyebrow 分组、面包屑与当前导航项都在「我的管理」。
	await expect(main.locator(".page-eyebrow")).toHaveText(
		"我的管理 / 我的 Skill",
	);
	await expect(page.locator('[data-slot="breadcrumb-item"]')).toHaveText([
		"我的管理",
		"我的 Skill",
	]);
	// 窄屏侧栏收在抽屉里，按含隐藏元素的方式核对当前项所在分组。
	const current = page
		.getByRole("navigation", { name: "主导航", includeHidden: true })
		.locator('[aria-current="page"]');
	await expect(current).toHaveCount(1);
	await expect(current).toHaveText("我的 Skill");
	expect(
		await current.evaluate((node) =>
			node.closest("nav[aria-label]")?.getAttribute("aria-label"),
		),
	).toBe("我的管理");
	await expect(main.locator("article.skill-row")).toHaveCount(2);
	await expect(
		main.getByRole("link", { name: "编辑新版本：release-notes" }),
	).toHaveAttribute("href", "/skills/manage/new?project=release-notes");
	await expect(
		main.getByRole("link", { name: "详情：release-notes" }),
	).toHaveAttribute("href", "/skills/release-notes-v1");
	// NI-31 / K-03：没有手填 ID 表单，也没有管理员审核卡。
	await expect(main.locator("input, textarea")).toHaveCount(0);
	await expect(main).not.toContainText(
		/项目 ID|版本 ID|digest|Agent ID|配置 revision|Grant JSON|共享审核|pending_sync/,
	);
	await fitsViewport(page);
});

test("creating and publishing never asks for internal IDs and reports state in Chinese", async ({
	page,
}) => {
	const control = await fixture(page);
	await page.goto("/skills/manage/new?project=release-notes");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 1, name: "创建与发布 Skill" }),
	).toBeVisible();
	await expect(page.locator('[data-slot="breadcrumb-item"]')).toHaveText([
		"我的 Skill",
		"创建与发布",
	]);
	await expect(main).not.toContainText(/项目 ID|版本 ID|digest/i);
	const reference = main.getByLabel("固定版本引用");
	await reference.fill("release-notes@latest");
	await main.getByRole("button", { name: "导入为待检查草稿" }).click();
	await expect(main.getByRole("alert")).toHaveText(
		"请填写可核验的固定版本引用。",
	);
	await expect(reference).toBeFocused();
	expect(control.writes).toHaveLength(0);
	await reference.fill("2.0.0");
	await main.getByRole("button", { name: "导入为待检查草稿" }).click();
	await expect(
		main.getByText("v2.0.0 已提交审核，审核通过前不能安装。"),
	).toBeVisible();
	await expect(main.getByText("待审核", { exact: true })).toBeVisible();
	await expect(main).not.toContainText(/pending_review|published/);
	expect(control.writes).toEqual([
		{
			method: "POST",
			path: "/api/v2/skills/imports",
			body: {
				schemaVersion: 1,
				name: "release-notes",
				provider: "github",
				version: "2.0.0",
			},
		},
	]);
	await fitsViewport(page);
});

test("Skill review lists pending versions, reviews them and re-reads the queue (K-04)", async ({
	page,
}) => {
	const control = await fixture(page, "admin");
	await page.goto("/admin/skill-reviews");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 1, name: "Skill 发布审核" }),
	).toBeVisible();
	await expect(main.locator(".page-eyebrow")).toHaveText(
		"系统管理 / Skill 审核",
	);
	await expect(page.locator('[data-slot="breadcrumb-item"]')).toHaveText([
		"系统管理",
		"Skill 审核",
	]);
	const system = page.getByRole("navigation", {
		name: "系统管理",
		includeHidden: true,
	});
	await expect(
		system.getByRole("link", { name: "Skill 审核", includeHidden: true }),
	).toHaveAttribute("aria-current", "page");
	const rows = main.locator("article.skill-row");
	await expect(rows).toHaveCount(3);
	const incident = rows.filter({ hasText: "incident-summary" });
	await expect(incident).toContainText(
		"周可申请 · 组织共享：发布工程 · GitHub · ",
	);
	await expect(incident.locator("time")).toHaveAttribute(
		"datetime",
		"2026-10-01T08:00:00Z",
	);
	await expect(rows.filter({ hasText: "weekly-digest" })).toContainText(
		"Alex Chen 申请 · 全体成员 · GitHub",
	);
	// 创建者看不到自己发布版本的审核入口。
	const own = rows.filter({ hasText: "release-notes" });
	await expect(own).toContainText("不能审核自己发布的版本");
	await expect(own.getByRole("button")).toHaveCount(0);
	await expect(main).not.toContainText(
		/pending_review|ORGANIZATION|org-release|user-other|aaaaaaaa/,
	);
	await expect(main.locator("input, textarea")).toHaveCount(0);

	// 驳回理由必填：空理由不发出请求。
	await main
		.getByRole("button", { name: "审阅：incident-summary · v1.0.0" })
		.click();
	const dialog = page.getByRole("dialog", { name: "审阅发布申请" });
	await expect(dialog).toContainText("组织共享：发布工程");
	await dialog.getByRole("button", { name: "驳回" }).click();
	await expect(dialog.getByRole("alert")).toHaveText("请填写驳回原因。");
	await expect(dialog.getByLabel("审核说明 · 驳回时必填")).toBeFocused();
	expect(control.writes).toHaveLength(0);
	await dialog.getByLabel("审核说明 · 驳回时必填").fill("  缺少使用说明  ");
	const queueReads = control.reads.filter(
		(path) => path === "/api/v2/skills/reviews",
	).length;
	await dialog.getByRole("button", { name: "驳回" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("已驳回，发布者可修改后重提")).toBeVisible();
	// 处理后队列立即回读，已驳回的版本离开队列。
	await expect(rows).toHaveCount(2);
	await expect(rows.filter({ hasText: "incident-summary" })).toHaveCount(0);
	expect(
		control.reads.filter((path) => path === "/api/v2/skills/reviews").length,
	).toBeGreaterThan(queueReads);

	await main
		.getByRole("button", { name: "审阅：weekly-digest · v1.0.0" })
		.click();
	await dialog.getByRole("button", { name: "批准发布" }).click();
	await expect(
		page.getByText("版本已批准发布，现有绑定继续使用原版本"),
	).toBeVisible();
	await expect(rows).toHaveCount(1);
	await expect(rows).toContainText("release-notes");
	expect(control.writes).toEqual([
		{
			method: "POST",
			path: "/api/v2/skills/versions/incident-summary-v1/review",
			body: { decision: "reject", reason: "缺少使用说明" },
		},
		{
			method: "POST",
			path: "/api/v2/skills/versions/weekly-digest-v1/review",
			body: { decision: "approve" },
		},
	]);
	await fitsViewport(page);
});

test("employees see no Skill review entry and a no-permission page on deep links", async ({
	page,
}) => {
	const control = await fixture(page);
	await page.goto("/admin/skill-reviews");
	await expect(
		page.locator("#main-content").getByText("没有访问权限"),
	).toBeVisible();
	await expect(
		page.getByRole("navigation", { name: "系统管理", includeHidden: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("link", { name: "Skill 审核", includeHidden: true }),
	).toHaveCount(0);
	await expect(page.locator("#main-content").getByRole("button")).toHaveCount(
		0,
	);
	expect(control.writes).toHaveLength(0);
	// 普通员工不发出待审队列读取。
	expect(control.reads).not.toContain("/api/v2/skills/reviews");
});
