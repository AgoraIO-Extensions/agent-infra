import {
	SkillHubDirectoryPageV1Schema,
	SkillHubInstallationListItemV1Schema,
	SkillHubInstallationPageV1Schema,
	SkillHubInstallationResponseV1Schema,
	SkillHubProjectContentSaveResponseV1Schema,
	SkillHubProjectContentUpdateV1Schema,
	SkillHubProjectContentV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubProjectPublicationRequestV1Schema,
	SkillHubProviderImportRequestV1Schema,
	SkillHubPublicationResponseV1Schema,
	SkillHubReviewContentV1Schema,
	SkillHubReviewQueueItemV1Schema,
	SkillHubReviewQueuePageV1Schema,
	SkillHubReviewRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import { expectNoDuplicateControls } from "./page-health";
import {
	computed,
	expectCleanPage,
	expectSkillDialog,
	resolved,
	trackPageErrors,
} from "./primitive-styles";

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

type InstallationItem = ReturnType<
	typeof SkillHubInstallationListItemV1Schema.parse
>;
/** 待审正文读取的一步：HTTP 失败码、内容不可用、截断或完整正文。 */
type ReviewContentStep = number | "unavailable" | "truncated" | "available";
// 待审正文含 HTML 与脚本标记：页面只能按纯文本显示，不能解析或执行。
const reviewBody = (skillVersionId: string) =>
	`# ${skillVersionId}\n核对变更范围。\n<img src=x onerror="window.__reviewXss=1"><script>window.__reviewXss=1</script>\n`;
const truncatedReviewBody = `# weekly-digest\n${"长行".repeat(400)}\n`;

async function fixture(
	page: Page,
	role: "employee" | "admin" = "employee",
	options: {
		installations?: InstallationItem[];
		/** 依次返回的移出状态码；成功后服务端列表不再包含该安装。 */
		uninstall?: number[];
		/** 按版本依次返回的待审正文读取结果（#3046）；用完后返回完整正文。 */
		reviewContent?: Record<string, ReviewContentStep[]>;
	} = {},
) {
	const writes: { method: string; path: string; body: unknown }[] = [];
	const reads: string[] = [];
	const removals: { path: string; key: string | undefined }[] = [];
	// 「我的安装」按服务端规则回读：移出成功后该安装离开列表。
	const library = [...(options.installations ?? [])];
	const uninstallStatuses = [...(options.uninstall ?? [])];
	// 项目内容按修订号整体替换；网页发布按服务端规则拒绝已用过的版本号。
	const contents = new Map<
		string,
		{
			revision: number;
			files: { path: string; encoding: string; content: string }[];
		}
	>();
	const publishedVersions = new Set<string>();
	let publications = 0;
	const contentSteps = Object.fromEntries(
		Object.entries(options.reviewContent ?? {}).map(([id, steps]) => [
			id,
			[...steps],
		]),
	);
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
		if (path === "/api/v2/skills" || path === "/api/v2/skills/owned-versions")
			// 我的 Skill 改读本人版本目录（K-02）；fixture 中两者都只有这个本人已发布版本。
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
		if (path === "/api/v2/skills/installations" && request.method() === "GET")
			return route.fulfill({
				json: SkillHubInstallationPageV1Schema.parse({
					items: library,
					nextCursor: null,
				}),
			});
		const removal = path.match(/^\/api\/v2\/skills\/installations\/([^/]+)$/);
		if (removal && request.method() === "DELETE") {
			removals.push({ path, key: request.headers()["idempotency-key"] });
			const index = library.findIndex(
				(item) => item.installationId === removal[1],
			);
			const status = index === -1 ? 404 : (uninstallStatuses.shift() ?? 200);
			const [item] = status === 200 ? library.splice(index, 1) : [];
			if (!item)
				return route.fulfill({
					status,
					json: {
						schemaVersion: 1,
						code:
							status === 503
								? "DEPENDENCY_UNAVAILABLE"
								: "RESOURCE_UNAVAILABLE",
						message: "Skill installation fixture unavailable",
						retryable: status === 503,
						traceId: "trace-skill-management",
					},
				});
			return route.fulfill({
				json: SkillHubInstallationResponseV1Schema.parse({
					replayed: false,
					installation: {
						schemaVersion: 1,
						installationId: item.installationId,
						principalType: "user",
						principalId: userId,
						skillVersionId: item.skillVersionId,
						state: "uninstalled",
						needUpgrade: item.needUpgrade,
						installedAt: item.installedAt,
						updatedAt: "2026-10-02T08:00:00Z",
					},
				}),
			});
		}
		const contentPath = path.match(
			/^\/api\/v2\/skills\/projects\/([^/]+)\/content$/,
		);
		if (contentPath) {
			const projectId = contentPath[1] ?? "";
			const current = contents.get(projectId) ?? { revision: 0, files: [] };
			if (request.method() === "PUT") {
				const body = SkillHubProjectContentUpdateV1Schema.parse(
					request.postDataJSON(),
				);
				if (body.baseRevision !== current.revision)
					return route.fulfill({
						status: 409,
						json: {
							schemaVersion: 1,
							code: "INVALID_REQUEST",
							message: "Request conflicts with current state.",
							retryable: false,
							traceId: "trace-skill-management",
						},
					});
				const next = { revision: current.revision + 1, files: body.files };
				contents.set(projectId, next);
				return route.fulfill({
					json: SkillHubProjectContentSaveResponseV1Schema.parse({
						replayed: false,
						projectId,
						revision: next.revision,
						contentDigest: "d".repeat(64),
						fileCount: body.files.length,
						totalBytes: 64,
						updatedAt: "2026-10-02T08:00:00Z",
					}),
				});
			}
			return route.fulfill({
				json: SkillHubProjectContentV1Schema.parse({
					schemaVersion: 1,
					projectId,
					revision: current.revision,
					contentDigest: current.revision ? "d".repeat(64) : null,
					fileCount: current.files.length,
					totalBytes: current.revision ? 64 : 0,
					updatedAt: current.revision ? "2026-10-02T08:00:00Z" : null,
					// 与服务端一致按路径排序返回。
					files: [...current.files]
						.sort((a, b) => (a.path < b.path ? -1 : 1))
						.map((file) => ({ ...file, sizeBytes: 8 })),
				}),
			});
		}
		const publishPath = path.match(
			/^\/api\/v2\/skills\/projects\/([^/]+)\/versions$/,
		);
		if (publishPath && request.method() === "POST") {
			const projectId = publishPath[1] ?? "";
			const body = SkillHubProjectPublicationRequestV1Schema.parse(
				request.postDataJSON(),
			);
			const taken = publishedVersions.has(`${projectId}@${body.version}`);
			if (taken || body.contentRevision !== contents.get(projectId)?.revision)
				return route.fulfill({
					status: 409,
					json: {
						schemaVersion: 1,
						code: "INVALID_REQUEST",
						message: "Request conflicts with current state.",
						retryable: false,
						traceId: "trace-skill-management",
					},
				});
			publishedVersions.add(`${projectId}@${body.version}`);
			publications += 1;
			return route.fulfill({
				status: 201,
				json: SkillHubPublicationResponseV1Schema.parse({
					replayed: false,
					version: {
						schemaVersion: 1,
						skillId: projectId,
						skillVersionId: `${projectId}-web-${publications}`,
						provider: "my_library",
						version: body.version,
						packageDigest: "a".repeat(64),
						manifestDigest: "b".repeat(64),
						signatureDigest: "c".repeat(64),
						visibility: body.visibility,
						state:
							body.visibility === "PRIVATE" ? "published" : "pending_review",
						needUpgrade: false,
						reviewedBy: null,
						reviewReason: null,
						revokedAt: null,
					},
				}),
			});
		}
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
		// 审核正文只读入口（#3046）：只读待审版本，系统管理员身份与队列状态由服务端判定。
		const reviewContentPath = path.match(
			/^\/api\/v2\/skills\/reviews\/([^/]+)\/content$/,
		);
		if (reviewContentPath && request.method() === "GET" && role === "admin") {
			const skillVersionId = reviewContentPath[1] ?? "";
			const step = contentSteps[skillVersionId]?.shift() ?? "available";
			if (typeof step === "number")
				return route.fulfill({
					status: step,
					json: {
						schemaVersion: 1,
						code:
							step === 503 ? "DEPENDENCY_UNAVAILABLE" : "RESOURCE_UNAVAILABLE",
						message: "Skill review content fixture unavailable",
						retryable: step === 503,
						traceId: "trace-skill-management",
					},
				});
			return route.fulfill({
				json: SkillHubReviewContentV1Schema.parse({
					schemaVersion: 1,
					skillVersionId,
					content:
						step === "unavailable"
							? { state: "unavailable" }
							: {
									state: "available",
									body:
										step === "truncated"
											? truncatedReviewBody
											: reviewBody(skillVersionId),
									bodyTruncated: step === "truncated",
									resources: [
										{ path: "scripts/run.sh", kind: "script", sizeBytes: 8 },
									],
								},
				}),
			});
		}
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
				json: directorySearchResponse(
					url,
					[
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
				),
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
	return { writes, reads, removals, library };
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

/** #2830 终验的两个视口：桌面 1440×900，移动 390×844（mobile project 自带）。 */
async function designViewport(page: Page, mobile: boolean) {
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
}

/**
 * E3-07：设计 .field-error margin-top 6px，加上 .field 的 7px 间距，文本框底到错误文字 13px，
 * 与公共 FieldError（审批驳回弹窗）一致。
 */
async function expectFieldErrorBelow(control: Locator, error: Locator) {
	await expect(error).toHaveCSS("margin-top", "6px");
	const [controlBox, errorBox] = await Promise.all([
		control.boundingBox(),
		error.boundingBox(),
	]);
	if (!controlBox || !errorBox) throw new Error("Missing field error geometry");
	expect(
		Math.abs(errorBox.y - (controlBox.y + controlBox.height) - 13),
	).toBeLessThanOrEqual(0.5);
}

test("My Skill puts 已安装 with its Agent binding entry before 我创建的 (V-15, V-16, V-17)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	const errors = trackPageErrors(page);
	const installed = SkillHubInstallationListItemV1Schema.parse({
		installationId: "installation-notes",
		skillVersionId: "weekly-digest-v3",
		needUpgrade: false,
		installedAt: "2026-10-01T08:00:00Z",
		updatedAt: "2026-10-01T08:00:00Z",
		version: {
			access: "visible",
			skillId: "weekly-digest",
			name: "weekly-digest",
			version: "3.1.0",
			provider: "market",
			visibility: "MARKET",
			state: "published",
		},
	});
	await fixture(page, "employee", { installations: [installed] });
	await page.goto("/skills/manage");
	const main = page.locator("#main-content");
	await expect(main.locator("article.skill-row")).toHaveCount(3);
	await designViewport(page, mobile);
	await expect(
		main.locator(".page-heading > div:first-child > p:last-child"),
	).toHaveText("管理自己创建的 Skill 和已安装版本。");
	// 区块顺序：已安装 → 我创建的；没有独立的「Agent 绑定」区块与说明。
	await expect(main.getByRole("heading", { level: 2 })).toHaveText([
		"已安装",
		"我创建的",
	]);
	await expect(main.getByText("在 Agent 的 Owner 配置中绑定")).toHaveCount(0);
	const installedSection = main.getByRole("region", { name: "已安装" });
	const binding = installedSection.getByRole("link", { name: "Agent 绑定" });
	await expect(binding).toHaveAttribute("href", "/my-agents?tab=owned");
	await expect(main.getByRole("link", { name: "Agent 绑定" })).toHaveCount(1);
	await expect(binding).toHaveCSS("border-top-width", "1px");
	const heading = installedSection.locator(".section-heading");
	const [headingBox, bindingBox] = await Promise.all([
		heading.boundingBox(),
		binding.boundingBox(),
	]);
	// 设计 .section-head：标题与按钮同一行，按钮靠右。
	expect(
		Math.abs(
			(headingBox?.x ?? 0) +
				(headingBox?.width ?? 0) -
				(bindingBox?.x ?? 0) -
				(bindingBox?.width ?? 0),
		),
	).toBeLessThanOrEqual(1);
	const owned = main.getByRole("region", { name: "我创建的" });
	const [installedBox, ownedBox] = await Promise.all([
		installedSection.boundingBox(),
		owned.boundingBox(),
	]);
	expect((ownedBox?.y ?? 0) - (installedBox?.y ?? 0)).toBeGreaterThan(0);
	// 设计 .section-head.section：「我创建的」上距 32px；≤767px 为 26px（E3-11，设计
	// `.section{margin-top:26px}`；原断言两视口都按 32px）。
	expect(
		Math.round(
			(ownedBox?.y ?? 0) - (installedBox?.y ?? 0) - (installedBox?.height ?? 0),
		),
	).toBe(mobile ? 26 : 32);
	// 已安装行只有 ghost「查看」与「移出我的库」，行标题为 h3。
	const row = installedSection.locator("article.skill-row");
	await expect(row.getByRole("link")).toHaveText(["查看"]);
	await expect(row.getByRole("button")).toHaveText(["移出我的库"]);
	await expect(owned.locator("article.skill-row h3")).toHaveText([
		"release-notes",
		"draft",
	]);
	// C2-11：「我创建的」行标题行高同设计 h2（16px × 1.35）。
	await expect(owned.locator("article.skill-row h3").first()).toHaveCSS(
		"line-height",
		"21.6px",
	);
	await expectNoDuplicateControls(page, "我的 Skill");
	await expectCleanPage(page, errors);
});

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

test("My Skill lists my installations, removes one and re-reads the list (K-03)", async ({
	page,
}) => {
	const installed = SkillHubInstallationListItemV1Schema.parse({
		installationId: "installation-notes",
		skillVersionId: "weekly-digest-v3",
		needUpgrade: true,
		installedAt: "2026-10-01T08:00:00Z",
		updatedAt: "2026-10-01T08:00:00Z",
		version: {
			access: "visible",
			skillId: "weekly-digest",
			name: "weekly-digest",
			version: "3.1.0",
			provider: "market",
			visibility: "MARKET",
			state: "published",
		},
	});
	const unavailable = SkillHubInstallationListItemV1Schema.parse({
		...installed,
		installationId: "installation-hidden",
		skillVersionId: "hidden-v1",
		needUpgrade: false,
		version: { access: "unavailable" },
	});
	const control = await fixture(page, "employee", {
		installations: [installed, unavailable],
		uninstall: [503],
	});
	await page.goto("/skills/manage");
	const main = page.locator("#main-content");
	// V-15：区块标题为「已安装」。
	const section = main.getByRole("region", { name: "已安装" });
	const rows = section.locator("article.skill-row");
	await expect(rows).toHaveCount(2);
	const digest = rows.filter({ hasText: "weekly-digest" });
	await expect(digest).toContainText("v3.1.0");
	await expect(digest).toContainText("内部市场");
	await expect(digest).toContainText("有新版本");
	// V-17、C2-10：说明行为「固定版本 v{版本} · {来源}」，其下是发布状态 chip 与「有新版本」，均取安装投影。
	await expect(digest.locator(".skill-row-copy > p")).toHaveText(
		"固定版本 v3.1.0 · 内部市场",
	);
	await expect(digest.locator(".skill-row-badges > *")).toHaveText([
		"已发布",
		"有新版本",
	]);
	// C2-11：行标题 h3 为 16px / 600，行高同设计 h2 的 1.35（21.6px）。
	await expect(
		digest.getByRole("heading", { name: "weekly-digest" }),
	).toHaveCSS("line-height", "21.6px");
	// V-17：已安装行的详情入口按设计为 ghost「查看」。
	await expect(
		digest.getByRole("link", { name: "查看：weekly-digest" }),
	).toHaveAttribute("href", "/skills/weekly-digest-v3");
	// 当前不可见的版本不显示名称和详情入口，仍可移出。
	const hidden = rows.filter({ hasText: "版本不可用" });
	await expect(hidden).toContainText("当前无权查看");
	await expect(hidden.getByRole("link")).toHaveCount(0);
	await expect(section).not.toContainText(
		/installation-|hidden-v1|MARKET|published|principal/,
	);

	// 第一次移出遇到 503：显示可重试的中文提示，行保留；重试复用同一幂等键。
	const remove = digest.getByRole("button", {
		name: "移出我的库：weekly-digest",
	});
	await remove.click();
	await expect(digest.getByRole("alert")).toHaveText(
		"暂时无法移出我的库，请稍后重试。",
	);
	await expect(rows).toHaveCount(2);
	const listReads = () =>
		control.reads.filter((path) => path === "/api/v2/skills/installations")
			.length;
	const readsBeforeRemoval = listReads();
	await remove.click();
	await expect(page.locator('[data-slot="toast"]')).toHaveText("已移出我的库");
	await expect(
		section.getByRole("heading", { level: 2, name: "已安装" }),
	).toBeFocused();
	await expect(rows).toHaveCount(1);
	await expect(rows.filter({ hasText: "weekly-digest" })).toHaveCount(0);
	await expect.poll(listReads).toBeGreaterThan(readsBeforeRemoval);
	expect(control.removals).toHaveLength(2);
	expect(control.removals[0]?.path).toBe(
		"/api/v2/skills/installations/installation-notes",
	);
	expect(control.removals[0]?.key).toBeTruthy();
	expect(control.removals[1]?.key).toBe(control.removals[0]?.key);
	// 刷新后仍以服务端列表为准。
	await page.reload();
	await expect(rows).toHaveCount(1);
	await expect(rows).toContainText("版本不可用");
	await fitsViewport(page);
});

test("Create and publish edits project content, publishes fixed versions and reports their state (K-03)", async ({
	page,
}) => {
	const control = await fixture(page);
	await page.goto("/skills/manage/new?project=release-notes");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 2, name: "Skill 内容" }),
	).toBeVisible();
	await expect(main.getByText("有未保存的修改")).toHaveCount(0);
	// 空的 SKILL.md 不能发布，焦点回到正文。
	await main.getByLabel("版本号").fill("1.0.0");
	await main.getByRole("button", { name: "发布固定版本" }).click();
	const skillMd = main.getByLabel("SKILL.md（任务说明）");
	await expect(skillMd).toBeFocused();
	await expect(main.getByRole("alert")).toHaveText(
		"请填写 SKILL.md，说明用途和使用步骤。",
	);
	await expectFieldErrorBelow(skillMd, main.getByRole("alert"));
	expect(control.writes).toHaveLength(0);

	await skillMd.fill("# release-notes\n汇总本周发布说明。\n");
	await main.getByRole("button", { name: "添加文本文件" }).click();
	await expect(main.getByLabel("文件名")).toBeFocused();
	await main.getByLabel("文件名").fill("collect.sh");
	await main.getByLabel("文件内容").fill("#!/bin/sh\necho collect\n");
	await main.getByLabel("上传文件到 assets/").setInputFiles({
		name: "logo.png",
		mimeType: "image/png",
		buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	});
	await expect(main.getByText("二进制文件")).toBeVisible();
	await expect(main.getByText("有未保存的修改")).toBeVisible();
	await main.getByRole("button", { name: "保存并发布" }).click();
	await expect(
		main.getByText("v1.0.0 已发布，可以在 Skill Hub 中查看。"),
	).toBeVisible();
	await expect(main.getByText("已发布", { exact: true })).toBeVisible();
	await expect(
		main.getByRole("link", { name: "查看版本详情" }),
	).toHaveAttribute("href", "/skills/release-notes-web-1");
	// 先整体保存内容，再按保存后的修订发布；请求中没有任何包事实。
	expect(control.writes).toEqual([
		{
			method: "PUT",
			path: "/api/v2/skills/projects/release-notes/content",
			body: {
				schemaVersion: 1,
				baseRevision: 0,
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						content: "# release-notes\n汇总本周发布说明。\n",
					},
					{
						path: "scripts/collect.sh",
						encoding: "utf8",
						content: "#!/bin/sh\necho collect\n",
					},
					{
						path: "assets/logo.png",
						encoding: "base64",
						content: "iVBORw0KGgo=",
					},
				],
			},
		},
		{
			method: "POST",
			path: "/api/v2/skills/projects/release-notes/versions",
			body: {
				schemaVersion: 1,
				contentRevision: 1,
				version: "1.0.0",
				visibility: "PRIVATE",
			},
		},
	]);
	await expect(main.getByText("有未保存的修改")).toHaveCount(0);

	// 已提交的版本号不能换包：服务端拒绝后给出中文说明。
	// V-18：范围为右栏单选卡；共享范围的主按钮为「提交审核」。
	await main.getByRole("radio", { name: "全体成员" }).click();
	await expect(main.getByRole("radio", { name: "全体成员" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await main.getByRole("button", { name: "提交审核" }).click();
	await expect(main.getByRole("alert")).toHaveText(
		"这个版本号已被使用，或内容已在其他地方修改。已提交的版本不能换包，修改内容请使用新的版本号。",
	);
	await main.getByLabel("版本号").fill("1.1.0");
	await main.getByRole("button", { name: "提交审核" }).click();
	await expect(
		main.getByText("v1.1.0 已提交审核，审核通过前不能安装。"),
	).toBeVisible();
	await expect(main.getByText("待审核", { exact: true })).toBeVisible();
	expect(control.writes.map(({ method, path }) => `${method} ${path}`)).toEqual(
		[
			"PUT /api/v2/skills/projects/release-notes/content",
			"POST /api/v2/skills/projects/release-notes/versions",
			"POST /api/v2/skills/projects/release-notes/versions",
			"POST /api/v2/skills/projects/release-notes/versions",
		],
	);
	await expect(main).not.toContainText(
		/digest|aaaaaaaa|项目 ID|版本 ID|pending_review|MEMBER|PRIVATE/,
	);
	// 刷新后内容按服务端修订回读。
	await page.reload();
	await expect(main.getByLabel("SKILL.md（任务说明）")).toHaveValue(
		"# release-notes\n汇总本周发布说明。\n",
	);
	await expect(main.getByLabel("文件名").first()).toHaveValue("logo.png");
	await fitsViewport(page);
});

test("Create and publish follows the design's two columns with scope cards on the right (V-18, V-19)", async ({
	page,
}, info) => {
	const mobile = info.project.name === "mobile";
	const errors = trackPageErrors(page);
	const control = await fixture(page);
	await page.goto("/skills/manage/new?project=release-notes");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 2, name: "Skill 内容" }),
	).toBeVisible();
	await designViewport(page, mobile);
	await expect(main.locator(".page-heading p").last()).toHaveText(
		"填写说明和发布范围。发布后版本固定，修改时创建新版本。",
	);
	const layout = main.locator(".skill-editor-layout");
	const editor = layout.locator(":scope > div");
	const aside = main.getByRole("complementary", { name: "版本与发布范围" });
	const [editorBox, asideBox] = await Promise.all([
		editor.boundingBox(),
		aside.boundingBox(),
	]);
	if (!editorBox || !asideBox) throw new Error("editor layout missing");
	if (mobile) {
		// ≤1023px 单栏：右栏排在编辑区之下，两栏同宽，间距 16px。
		expect(asideBox.x).toBe(editorBox.x);
		expect(asideBox.width).toBe(editorBox.width);
		expect(Math.round(asideBox.y - editorBox.y - editorBox.height)).toBe(16);
	} else {
		// 设计 .editor-layout：minmax(0,1.5fr) minmax(260px,.8fr)，gap 22px；两栏同高。
		expect(Math.round(asideBox.x - editorBox.x - editorBox.width)).toBe(22);
		expect(editorBox.width / asideBox.width).toBeCloseTo(1.5 / 0.8, 1);
		expect(asideBox.y).toBe(editorBox.y);
		expect(asideBox.height).toBe(editorBox.height);
	}
	// 左栏：项目信息 → Skill 内容 → 导入固定来源；右栏标题 16px / 600 正文字体。
	await expect(editor.locator('[data-slot="form-section-title"]')).toHaveText([
		"项目信息",
		"Skill 内容",
		"导入固定来源",
	]);
	const asideHeading = aside.getByRole("heading", {
		level: 2,
		name: "版本与发布范围",
	});
	await expect(asideHeading).toHaveCSS("font-size", "16px");
	await expect(asideHeading).toHaveCSS("font-weight", "600");
	// 设计 .field.section-tight：版本字段距标题 15px（C2-13；原按回写前的 .field.section 断言 32px）。
	const [headingBox, versionLabelBox] = await Promise.all([
		asideHeading.boundingBox(),
		aside.getByText("版本号", { exact: true }).boundingBox(),
	]);
	expect(
		Math.round(
			(versionLabelBox?.y ?? 0) -
				(headingBox?.y ?? 0) -
				(headingBox?.height ?? 0),
		),
	).toBe(15);
	// 设计 textarea.skill-editor：SKILL.md 至少 280px，13px / 1.8 等宽（C2-12）；
	// 配套文件的「文件内容」仍是 180px / 1.6。
	const skillMd = main.getByLabel("SKILL.md（任务说明）");
	expect(
		await computed(skillMd, [
			"minHeight",
			"maxHeight",
			"fontSize",
			"lineHeight",
			"resize",
		]),
	).toEqual({
		minHeight: "280px",
		maxHeight: "600px",
		fontSize: "13px",
		lineHeight: "23.4px",
		resize: "vertical",
	});
	expect((await skillMd.boundingBox())?.height).toBeGreaterThanOrEqual(280);
	// C2-14：「添加文本文件」用设计的 plus 图标。
	await expect(
		main.getByRole("button", { name: "添加文本文件" }).locator("svg"),
	).toHaveClass(/lucide-plus\b/);
	const gapBetween = async (above: Locator, below: Locator) => {
		const [top, bottom] = await Promise.all([
			above.boundingBox(),
			below.boundingBox(),
		]);
		if (!top || !bottom) throw new Error("Missing editor geometry");
		return bottom.y - top.y - top.height;
	};
	// E3-12：h3「配套文件」14px / 600 / 1.5；「还没有配套文件」到「添加文本文件」只隔 grid 的 12px。
	const filesHeading = main.getByRole("heading", {
		level: 3,
		name: "配套文件",
	});
	expect(
		await computed(filesHeading, ["fontSize", "fontWeight", "lineHeight"]),
	).toEqual({ fontSize: "14px", fontWeight: "600", lineHeight: "21px" });
	expect(
		await gapBetween(
			main.getByText("还没有配套文件。可以添加脚本、参考资料或资源。", {
				exact: true,
			}),
			main.getByRole("button", { name: "添加文本文件" }),
		),
	).toBeCloseTo(12, 0);
	// E3-13：「共 N 个文件…」距上方文件输入框 5px（设计 .form-section > p）。
	expect(
		await gapBetween(
			main.getByLabel("上传文件到 assets/"),
			main.getByText(/^共 \d+ 个文件，/),
		),
	).toBeCloseTo(5, 0);
	// 四张范围单选卡：两列（390 单列），圆角 10px、内边距 12px、最小高 60px，说明 11px。
	const scope = aside.getByRole("radiogroup", { name: "发布范围" });
	const cards = scope.locator(".skill-scope-option");
	await expect(cards).toHaveCount(4);
	await expect(scope.getByRole("radio")).toHaveCount(4);
	for (const [name, note] of [
		["仅自己", "自主创建内容可直接发布"],
		["全体成员", "需要独立审核后才可见"],
		["组织共享", "需要独立审核后才可见"],
		["内部市场", "需要独立审核后才可见"],
	] as const)
		await expect(
			cards.filter({ has: page.getByRole("radio", { name }) }),
		).toHaveText(`${name}${note}`);
	const card = cards.first();
	await expect(card).toHaveCSS("border-top-left-radius", "10px");
	await expect(card).toHaveCSS("padding-top", "12px");
	await expect(card).toHaveCSS("min-height", "60px");
	await expect(card.locator("small")).toHaveCSS("font-size", "11px");
	const resolved = (value: string, property = "color") =>
		page.evaluate(
			([css, name]) => {
				const probe = document.createElement("span");
				probe.style.setProperty(name as string, css as string);
				document.body.append(probe);
				const color = getComputedStyle(probe).getPropertyValue(name as string);
				probe.remove();
				return color;
			},
			[value, property],
		);
	// 选中卡边框为 --muted（应用 --muted-foreground）、底色为 surface-raised。
	await expect(card).toHaveCSS(
		"border-top-color",
		await resolved("var(--muted-foreground)"),
	);
	await expect(card).toHaveCSS(
		"background-color",
		await resolved("var(--surface-raised)", "background-color"),
	);
	const boxes = await Promise.all(
		[0, 1].map((index) => cards.nth(index).boundingBox()),
	);
	if (mobile) expect(boxes[1]?.y).toBeGreaterThan(boxes[0]?.y ?? 0);
	else {
		expect(boxes[1]?.y).toBe(boxes[0]?.y);
		expect(boxes[1]?.x).toBeGreaterThan(boxes[0]?.x ?? 0);
	}
	// 项目没有所属组织：「组织共享」不可选并说明原因。
	await expect(scope.getByRole("radio", { name: "组织共享" })).toHaveAttribute(
		"data-disabled",
		"",
	);
	await expect(
		aside.getByText("项目没有所属组织，不能选择组织共享。"),
	).toBeVisible();
	// E3-14：提示距最后一张范围卡 15px（设计 p.field-help.section-tight）。
	expect(
		await gapBetween(
			cards.last(),
			aside.getByText("项目没有所属组织，不能选择组织共享。"),
		),
	).toBeCloseTo(15, 0);
	// 键盘：Tab 停在已选项，方向键切换范围；共享范围主按钮为「提交审核」。
	const own = scope.getByRole("radio", { name: "仅自己" });
	await own.focus();
	await page.keyboard.press("ArrowDown");
	const member = scope.getByRole("radio", { name: "全体成员" });
	await expect(member).toBeFocused();
	await expect(member).toHaveAttribute("aria-checked", "true");
	await expect(aside.getByRole("button")).toHaveText(["保存草稿", "提交审核"]);
	await own.click();
	await expect(aside.getByRole("button")).toHaveText([
		"保存草稿",
		"发布固定版本",
	]);
	await expect(aside.getByText("权限不会扩大")).toBeVisible();
	// E3-11：右栏说明卡与操作区的分区上距桌面 32px，≤767px 按设计 .section 收为 26px。
	for (const section of [
		aside.locator(".skill-editor-section"),
		aside.locator(".skill-editor-actions"),
	]) {
		await expect(section).toHaveCount(1);
		await expect(section).toHaveCSS("margin-top", mobile ? "26px" : "32px");
	}
	// 同一页面没有同名控件：项目与导入的包名称分开命名。
	await expect(main.getByLabel("包名称", { exact: true })).toHaveCount(1);
	await expect(main.getByLabel("导入包名称", { exact: true })).toHaveCount(1);
	await expectNoDuplicateControls(page, "创建与发布 Skill");
	// 「保存草稿」提交左栏内容：先补正文，再保存；提交后焦点不落到 body。
	await main.getByLabel("SKILL.md（任务说明）").fill("# release-notes\n");
	await expect(aside.getByText("有未保存的修改")).toBeVisible();
	await aside.getByRole("button", { name: "保存草稿" }).click();
	await expect(aside.getByText(/^内容已保存/)).toBeVisible();
	await expect(aside.getByText("有未保存的修改")).toHaveCount(0);
	expect(control.writes.map(({ method, path }) => `${method} ${path}`)).toEqual(
		["PUT /api/v2/skills/projects/release-notes/content"],
	);
	expect(
		await page.evaluate(() => document.activeElement === document.body),
	).toBe(false);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);

	// 新建首屏：先创建项目（项目内容属于已创建的项目），右栏只有说明，没有范围卡与发布。
	await page.goto("/skills/manage/new");
	const newAside = main.getByRole("complementary", { name: "版本与发布范围" });
	await expect(newAside).toContainText(
		"创建 Skill 项目后，可以编辑 SKILL.md，并在这里选择版本与发布范围。",
	);
	await expect(newAside.getByRole("radio")).toHaveCount(0);
	await expect(newAside.getByRole("button")).toHaveCount(0);
	await expect(main.getByRole("button", { name: "创建项目" })).toBeVisible();
	await expect(main.getByLabel("包名称", { exact: true })).toHaveCount(1);
	await expectNoDuplicateControls(page, "新建 Skill");
	await expectCleanPage(page, errors);
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
	const pageErrors = trackPageErrors(page);
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
	// V-06：每行说明下为 quiet-pill「脚本禁用 · 仅使用 Agent 已有权限」（11px、圆角 7px）。
	const pills = rows.locator(".skill-row-copy > .quiet-pill");
	await expect(pills).toHaveText(
		Array(3).fill("脚本禁用 · 仅使用 Agent 已有权限"),
	);
	await expect(pills.first()).toHaveCSS("font-size", "11px");
	await expect(pills.first()).toHaveCSS("border-top-left-radius", "7px");
	// C2-05：设计 .skill-row-meta 中版本号 strong 与状态 chip 紧贴，chip 不另加上距。
	const meta = rows
		.filter({ hasText: "incident-summary" })
		.locator(".skill-row-meta");
	const stateChip = meta.locator('[data-slot="badge"]');
	await expect(stateChip).toHaveText("待审核");
	await expect(stateChip).toHaveCSS("margin-top", "0px");
	const versionBox = await box(meta.locator("strong"));
	const chipBox = await box(stateChip);
	expect(
		Math.abs(chipBox.y - (versionBox.y + versionBox.height)),
	).toBeLessThanOrEqual(1);
	await expect(main).not.toContainText(
		/pending_review|ORGANIZATION|org-release|user-other|aaaaaaaa/,
	);
	await expect(main.locator("input, textarea")).toHaveCount(0);
	// AC-2：各行「审阅：{名称 · 版本}」互不同名。
	await expectNoDuplicateControls(page, "Skill 审核");

	// 驳回理由必填：空理由不发出请求。
	await main
		.getByRole("button", { name: "审阅：incident-summary · v1.0.0" })
		.click();
	const dialog = page.getByRole("dialog", { name: "审阅发布申请" });
	await expect(dialog).toContainText("组织共享：发布工程");
	// #3037 X-11：审阅弹窗使用设计 .skill-dialog 外观与文字「关闭」。
	await expectSkillDialog(page, dialog, test.info().project.name === "mobile");
	await dialog.getByRole("button", { name: "驳回" }).click();
	await expect(dialog.getByRole("alert")).toHaveText("请填写驳回原因。");
	await expect(dialog.getByLabel("审核说明 · 驳回时必填")).toBeFocused();
	await expectFieldErrorBelow(
		dialog.getByLabel("审核说明 · 驳回时必填"),
		dialog.getByRole("alert"),
	);
	expect(control.writes).toHaveLength(0);
	await dialog.getByLabel("审核说明 · 驳回时必填").fill("  缺少使用说明  ");
	const queueReads = control.reads.filter(
		(path) => path === "/api/v2/skills/reviews",
	).length;
	await dialog.getByRole("button", { name: "驳回" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("已驳回，发布者可修改后重提")).toBeVisible();
	// 提交后审阅入口随该版本离开队列，焦点不落到 body（#3037 AC-2）。
	await expect
		.poll(() => page.evaluate(() => document.activeElement === document.body))
		.toBe(false);
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
	await expect
		.poll(() => page.evaluate(() => document.activeElement === document.body))
		.toBe(false);
	await expectCleanPage(page, pageErrors);
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

/** 弹窗内同一角色的可交互控件不同名（读屏用户按名称区分）。 */
async function expectDistinctDialogNames(dialog: Locator) {
	const snapshot = await dialog.ariaSnapshot();
	const names = [
		...snapshot.matchAll(
			/^\s*- (button|link|textbox|checkbox|combobox) "((?:[^"\\]|\\.)*)"/gm,
		),
	].map((match) => `${match[1]} "${match[2]}"`);
	expect(
		names.filter((name, index) => names.indexOf(name) !== index),
		names.join(" / "),
	).toEqual([]);
}

async function box(locator: Locator) {
	const value = await locator.boundingBox();
	if (!value) throw new Error("Missing review dialog geometry");
	return value;
}

test("Skill review dialog shows the pending SKILL.md as plain text below the facts (#3046 V-05)", async ({
	page,
}) => {
	const mobile = test.info().project.name === "mobile";
	// 终验视口：桌面 1440×900，窄屏 390×844（mobile 项目默认）。
	if (!mobile) await page.setViewportSize({ width: 1440, height: 900 });
	const pageErrors = trackPageErrors(page);
	const control = await fixture(page, "admin", {
		reviewContent: { "weekly-digest-v1": [503, "truncated"] },
	});
	await page.goto("/admin/skill-reviews");
	const main = page.locator("#main-content");
	const contentReads = () =>
		control.reads.filter((path) => path.endsWith("/content"));
	// 列表只读队列，不预取任何正文。
	await expect(main.locator("article.skill-row")).toHaveCount(3);
	expect(contentReads()).toEqual([]);

	await main
		.getByRole("button", { name: "审阅：incident-summary · v1.0.0" })
		.click();
	const dialog = page.getByRole("dialog", { name: "审阅发布申请" });
	const region = dialog.getByRole("region", { name: "SKILL.md 正文" });
	await expect(region).toBeVisible();
	// 正文原样显示为文本：其中的 HTML 不被解析，脚本与事件处理不执行。
	expect(await region.locator("pre").textContent()).toBe(
		reviewBody("incident-summary-v1"),
	);
	await expect(dialog.locator("img, script")).toHaveCount(0);
	expect(
		await page.evaluate(() => (window as { __reviewXss?: number }).__reviewXss),
	).toBeUndefined();
	expect(contentReads()).toEqual([
		"/api/v2/skills/reviews/incident-summary-v1/content",
	]);
	// 设计 pre.skill-code：紧跟事实列表（上距 12px）、与之同宽，审核说明在其下方。
	const facts = await box(dialog.locator("dl"));
	const code = await box(region);
	const reason = await box(dialog.getByText("审核说明 · 驳回时必填"));
	expect(Math.abs(code.y - (facts.y + facts.height) - 12)).toBeLessThanOrEqual(
		1,
	);
	expect(Math.abs(code.x - facts.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(code.width - facts.width)).toBeLessThanOrEqual(1);
	expect(reason.y).toBeGreaterThan(code.y + code.height);
	// C2-04：设计 label.field.section，「审核说明」距正文区 32px（窄屏 26px）。
	const content = await box(dialog.locator(".skill-review-content"));
	expect(
		Math.abs(reason.y - (content.y + content.height) - (mobile ? 26 : 32)),
	).toBeLessThanOrEqual(1);
	// 设计 .skill-dialog .facts：桌面标签列 100px、gap 10px 18px（C2-03）；窄屏单列，
	// dt 上距 8px、dd 下距 4px、gap 3px，与审批审阅弹窗一致（C2-02）。
	const factList = dialog.locator("dl");
	const factStyle = await computed(factList, [
		"gridTemplateColumns",
		"rowGap",
		"columnGap",
	]);
	if (mobile) {
		expect(factStyle.gridTemplateColumns.split(" ")).toHaveLength(1);
		expect(factStyle.rowGap).toBe("3px");
		expect(
			await computed(factList.locator("dt").first(), ["marginTop"]),
		).toEqual({ marginTop: "8px" });
		expect(
			await computed(factList.locator("dd").first(), ["marginBottom"]),
		).toEqual({ marginBottom: "4px" });
		// 单列：dd 在 dt 下方，左边缘对齐。
		const term = await box(factList.locator("dt").first());
		const detail = await box(factList.locator("dd").first());
		expect(detail.y).toBeGreaterThanOrEqual(term.y + term.height);
		expect(Math.abs(detail.x - term.x)).toBeLessThanOrEqual(1);
	} else {
		expect(factStyle.gridTemplateColumns.split(" ")[0]).toBe("100px");
		expect(factStyle).toMatchObject({ rowGap: "10px", columnGap: "18px" });
		const term = await box(factList.locator("dt").first());
		const detail = await box(factList.locator("dd").first());
		expect(Math.round(detail.x - term.x)).toBe(118);
	}
	expect(
		await computed(region, [
			"paddingTop",
			"paddingLeft",
			"borderTopWidth",
			"borderTopStyle",
			"borderTopLeftRadius",
			"backgroundColor",
			"borderTopColor",
			"fontSize",
			"lineHeight",
		]),
	).toEqual({
		paddingTop: "16px",
		paddingLeft: "16px",
		borderTopWidth: "1px",
		borderTopStyle: "solid",
		borderTopLeftRadius: "10px",
		backgroundColor: await resolved(
			page,
			"backgroundColor",
			"var(--surface-raised)",
		),
		borderTopColor: await resolved(page, "color", "var(--border)"),
		fontSize: "12px",
		lineHeight: "20.4px",
	});
	expect(
		await region.evaluate((element) => {
			const pre = element.querySelector("pre");
			return {
				mono: getComputedStyle(element).fontFamily.startsWith("ui-monospace"),
				whiteSpace: pre ? getComputedStyle(pre).whiteSpace : "",
				overflowWrap: pre ? getComputedStyle(pre).overflowWrap : "",
			};
		}),
	).toEqual({ mono: true, whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
	await expect
		.poll(() => page.evaluate(() => document.activeElement === document.body))
		.toBe(false);
	await expectDistinctDialogNames(dialog);
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(dialog).toBeHidden();

	// 可重试的读取失败：弹窗内唯一的「重新读取正文」，重读时焦点留在弹窗内。
	await main
		.getByRole("button", { name: "审阅：weekly-digest · v1.0.0" })
		.click();
	const failure = dialog.getByRole("alert");
	await expect(failure).toContainText(
		"暂时无法读取 SKILL.md 正文，可以稍后重新读取。",
	);
	await expect(region).toHaveCount(0);
	const retry = dialog.getByRole("button", { name: "重新读取正文" });
	await expect(retry).toHaveCount(1);
	await expectDistinctDialogNames(dialog);
	await retry.click();
	await expect(region).toBeVisible();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	expect(
		await page.evaluate(() => {
			const active = document.activeElement;
			return (
				active !== document.body && Boolean(active?.closest('[role="dialog"]'))
			);
		}),
	).toBe(true);
	// 截断沿用版本详情的 64 KiB 上限，单独提示；长行在块内换行，不撑宽弹窗。
	expect(await region.locator("pre").textContent()).toBe(truncatedReviewBody);
	await expect(
		dialog.getByText("正文较长，这里只显示开头部分（64 KiB）。"),
	).toBeVisible();
	const dialogBox = await box(dialog);
	const truncated = await box(region);
	expect(truncated.x + truncated.width).toBeLessThanOrEqual(
		dialogBox.x + dialogBox.width,
	);
	expect(truncated.height).toBeLessThanOrEqual(421);
	expect(contentReads()).toEqual([
		"/api/v2/skills/reviews/incident-summary-v1/content",
		"/api/v2/skills/reviews/weekly-digest-v1/content",
		"/api/v2/skills/reviews/weekly-digest-v1/content",
	]);
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(dialog).toBeHidden();
	// 再次打开重新读取，不复用关闭前的正文。
	await main
		.getByRole("button", { name: "审阅：incident-summary · v1.0.0" })
		.click();
	await expect(region).toBeVisible();
	expect(contentReads()).toHaveLength(4);
	expect(control.writes).toEqual([]);
	await expectCleanPage(page, pageErrors);
});

test("Skill review dialog tells a handled version and unavailable content apart (#3046)", async ({
	page,
}) => {
	if (test.info().project.name !== "mobile")
		await page.setViewportSize({ width: 1440, height: 900 });
	const pageErrors = trackPageErrors(page);
	const control = await fixture(page, "admin", {
		reviewContent: {
			"incident-summary-v1": [404],
			"weekly-digest-v1": ["unavailable"],
		},
	});
	await page.goto("/admin/skill-reviews");
	const main = page.locator("#main-content");
	const dialog = page.getByRole("dialog", { name: "审阅发布申请" });
	await main
		.getByRole("button", { name: "审阅：incident-summary · v1.0.0" })
		.click();
	// 已处理（与不存在不可区分）：不可重试，不显示正文。
	await expect(dialog.getByRole("alert")).toHaveText(
		"这个版本已不在待审核状态，正文不再提供。",
	);
	await expect(
		dialog.getByRole("button", { name: "重新读取正文" }),
	).toHaveCount(0);
	await expect(dialog.locator(".skill-code")).toHaveCount(0);
	await expectDistinctDialogNames(dialog);
	await dialog.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(dialog).toBeHidden();
	await main
		.getByRole("button", { name: "审阅：weekly-digest · v1.0.0" })
		.click();
	// 内容不可用不是错误：其余审核信息与操作照常。
	await expect(
		dialog.getByText("这个版本的正文暂时无法读取，其余审核信息不受影响。"),
	).toBeVisible();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await expect(dialog.locator(".skill-code")).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "批准发布" })).toBeEnabled();
	await expect
		.poll(() => page.evaluate(() => document.activeElement === document.body))
		.toBe(false);
	expect(control.writes).toEqual([]);
	await expectCleanPage(page, pageErrors);
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
	// 也不读取任何待审正文（#3046）。
	expect(
		control.reads.filter((path) => path.startsWith("/api/v2/skills/reviews/")),
	).toEqual([]);
});

// #3179 G4-25：配套文件卡（fieldset.skill-content-file）卡顶边到首行字段标签「目录 / 文件名」12px
// （设计 .skill-content-file .form-grid{margin-top:12px}），两个视口一致。
test("a companion file card starts its first field row 12px below the card edge (G4-25)", async ({
	page,
}, info) => {
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/skills/manage/new?project=release-notes");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 2, name: "Skill 内容" }),
	).toBeVisible();
	await designViewport(page, info.project.name === "mobile");
	await main.getByRole("button", { name: "添加文本文件" }).click();
	await expect(main.getByLabel("文件名")).toBeFocused();
	const card = main.locator("fieldset.skill-content-file").first();
	const [cardBox, directoryLabel, nameLabel] = await Promise.all([
		card.boundingBox(),
		card.getByText("目录", { exact: true }).boundingBox(),
		card.getByText("文件名", { exact: true }).boundingBox(),
	]);
	if (!cardBox || !directoryLabel || !nameLabel)
		throw new Error("Missing file card geometry");
	const borderTop = await card.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).borderTopWidth),
	);
	const firstRow = Math.min(directoryLabel.y, nameLabel.y);
	expect(Math.abs(firstRow - (cardBox.y + borderTop) - 12)).toBeLessThanOrEqual(
		0.5,
	);
	await expectNoDuplicateControls(page, "创建与发布（配套文件，G4-25）");
	await expectCleanPage(page, errors);
});

// #3215 G5-10：配套文件卡的 ghost「移除」用叉号（设计 icon('x')，16px），不是垃圾桶；名称仍为
// 「移除文件：{目录}/{文件名}」。
test("the companion file remove action uses the design's x icon (G5-10)", async ({
	page,
}, info) => {
	const errors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/skills/manage/new?project=release-notes");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 2, name: "Skill 内容" }),
	).toBeVisible();
	await designViewport(page, info.project.name === "mobile");
	await main.getByRole("button", { name: "添加文本文件" }).click();
	await expect(main.getByLabel("文件名")).toBeFocused();
	const remove = main
		.locator("fieldset.skill-content-file")
		.first()
		.getByRole("button", { name: /^移除文件：/ });
	await expect(remove).toHaveText("移除");
	const icon = remove.locator("svg");
	await expect(icon).toHaveCount(1);
	const classes = ((await icon.getAttribute("class")) ?? "").split(/\s+/);
	expect(classes).toContain("lucide-x");
	expect(classes.some((name) => name.startsWith("lucide-trash"))).toBe(false);
	expect(await icon.boundingBox()).toMatchObject({ width: 16, height: 16 });
	await expectNoDuplicateControls(page, "创建与发布（配套文件，G5-10）");
	await expectCleanPage(page, errors);
});
