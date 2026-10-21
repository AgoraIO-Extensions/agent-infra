import {
	SkillHubDirectoryPageV1Schema,
	SkillHubInstallationCommandV1Schema,
	SkillHubInstallationResponseV1Schema,
	SkillHubOwnedVersionPageV1Schema,
	SkillHubOwnedVersionV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubPublicationResponseV1Schema,
	SkillHubVersionDetailV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";
import { directorySearchResponse } from "../src/features/directory-test-fixtures";
import { expectNoDuplicateControls } from "./page-health";
import {
	expectCleanPage,
	expectEmptyRows,
	expectNativeSelectArrow,
	expectSectionHeadTopAligned,
	expectSkillDialog,
	trackPageErrors,
} from "./primitive-styles";

// Skill 目录与版本详情（K-01、K-02、K-05、K-06、N-04 与防回归 NI-98/100/103）。
const ownerId = "skill-browser-owner";
const marketOwnerId = "skill-market-owner";
const base = {
	schemaVersion: 1 as const,
	provider: "my_library" as const,
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	visibility: "PRIVATE" as const,
	state: "published" as const,
};
const releaseV1 = SkillHubVersionMetadataV1Schema.parse({
	...base,
	skillId: "release-notes",
	skillVersionId: "release-notes-v1",
	name: "release-notes",
	version: "1.0.0",
});
const releaseV2 = SkillHubVersionMetadataV1Schema.parse({
	...releaseV1,
	skillVersionId: "release-notes-v2",
	version: "1.2.0",
});
const incident = SkillHubVersionMetadataV1Schema.parse({
	...base,
	skillId: "incident-summary",
	skillVersionId: "incident-summary-v1",
	name: "incident-summary-with-a-long-package-name",
	version: "2.0.0",
	provider: "market",
	visibility: "MARKET",
});
const codeReview = SkillHubVersionMetadataV1Schema.parse({
	...base,
	skillId: "code-review",
	skillVersionId: "code-review-v1",
	name: "code-review",
	version: "0.3.1",
	provider: "github",
	visibility: "ORGANIZATION",
});
const versions = [releaseV1, incident, releaseV2, codeReview];
// 本人尚未发布的版本：只出现在本人目录与本人详情中（K-02）。
const releasePending = SkillHubOwnedVersionV1Schema.parse({
	...releaseV1,
	skillVersionId: "release-notes-v3",
	version: "1.3.0",
	visibility: "MARKET",
	state: "pending_review",
});
const digestRejected = SkillHubOwnedVersionV1Schema.parse({
	...base,
	skillId: "weekly-digest",
	skillVersionId: "weekly-digest-v1",
	name: "weekly-digest",
	version: "0.4.0",
	visibility: "MEMBER",
	state: "rejected",
});
const skillBody =
	"# release-notes\n汇总本周合入的变更。\n<script>window.__skillBodyExecuted = true</script>\n";
const owners: Record<string, string> = {
	"incident-summary": marketOwnerId,
	"code-review": marketOwnerId,
};
const project = (projectId: string) => ({
	schemaVersion: 1 as const,
	projectId,
	name: projectId,
	ownerId,
	organizationId: null,
	status: "active" as const,
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
});

const protocolError = (code: string, retryable: boolean) => ({
	schemaVersion: 1,
	code,
	message: "Controlled Skill Hub fixture",
	retryable,
	traceId: "trace-skill-hub",
});

type Fixture = {
	directory?: "ok" | "unavailable" | "denied" | "delayed";
	install?: number[];
	/** 本人目录额外包含审核中、已驳回的版本。 */
	unpublished?: boolean;
};

async function fixture(page: Page, options: Fixture = {}) {
	const requests = {
		directory: 0,
		details: [] as string[],
		installs: [] as { body: unknown; key?: string }[],
		uninstalls: [] as { id: string; key?: string }[],
		revokes: [] as { id: string; key?: string }[],
		writes: [] as string[],
	};
	// 服务端的「我的库」：详情按它回读当前用户的安装状态。
	const library = new Map<string, string>();
	const ownedVersions = [
		releaseV1,
		releaseV2,
		...(options.unpublished ? [releasePending, digestRejected] : []),
	];
	const readable = [...versions, ...ownedVersions];
	let releaseDirectory: () => void = () => undefined;
	const directoryGate = new Promise<void>((resolve) => {
		releaseDirectory = resolve;
	});
	const installStatuses = [...(options.install ?? [])];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() !== "GET")
			requests.writes.push(`${request.method()} ${path}`);
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: ownerId,
						displayName: "Skill 发布者",
						roles: ["employee"],
					},
				},
			});
		if (path === "/api/v2/skills") {
			requests.directory += 1;
			if (options.directory === "delayed" && requests.directory === 1)
				await directoryGate;
			if (options.directory === "unavailable" && requests.directory === 1)
				return route.fulfill({
					status: 503,
					json: protocolError("DEPENDENCY_UNAVAILABLE", true),
				});
			if (options.directory === "denied")
				return route.fulfill({
					status: 403,
					json: protocolError("AUTHORIZATION_REVOKED", false),
				});
			const page = SkillHubDirectoryPageV1Schema.parse({
				items: versions,
				nextCursor: null,
			});
			return route.fulfill({ json: page });
		}
		if (path === "/api/v2/skills/owned-versions")
			return route.fulfill({
				json: SkillHubOwnedVersionPageV1Schema.parse({
					items: ownedVersions,
					nextCursor: null,
				}),
			});
		const detailMatch = /^\/api\/v2\/skills\/versions\/([^/]+)\/detail$/.exec(
			path,
		);
		if (detailMatch && request.method() === "GET") {
			requests.details.push(detailMatch[1] ?? "");
			const version = readable.find(
				(item) => item.skillVersionId === detailMatch[1],
			);
			if (!version)
				return route.fulfill({
					status: 404,
					json: protocolError("RESOURCE_UNAVAILABLE", false),
				});
			const installationId = library.get(version.skillVersionId);
			return route.fulfill({
				json: SkillHubVersionDetailV1Schema.parse({
					...version,
					ownerId: owners[version.skillId] ?? ownerId,
					installation: installationId
						? { state: "installed", installationId }
						: { state: "not_installed" },
					content: {
						state: "available",
						body: skillBody,
						bodyTruncated: false,
						resources: [
							{
								path: "references/style-guide.md",
								kind: "reference",
								sizeBytes: 2048,
							},
							{ path: "scripts/collect.sh", kind: "script", sizeBytes: 120 },
						],
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
						{ kind: "user", canonicalId: ownerId, displayName: "Skill 发布者" },
						{
							kind: "user",
							canonicalId: marketOwnerId,
							displayName: "市场维护人",
						},
					].filter(
						(item) =>
							item.kind === url.searchParams.get("kind") &&
							ids.includes(item.canonicalId),
					),
				),
			});
		}
		if (path === "/api/v2/skills/projects" && request.method() === "GET")
			return route.fulfill({
				json: SkillHubProjectPageV1Schema.parse({
					items: [
						project("release-notes"),
						...(options.unpublished ? [project("weekly-digest")] : []),
					],
					nextCursor: null,
				}),
			});
		if (
			path === "/api/v2/skills/installations" &&
			request.method() === "POST"
		) {
			const body = SkillHubInstallationCommandV1Schema.parse(
				request.postDataJSON(),
			);
			requests.installs.push({
				body,
				key: request.headers()["idempotency-key"],
			});
			const status = installStatuses.shift() ?? 201;
			if (status !== 201)
				return route.fulfill({
					status,
					json: protocolError(
						status === 403 ? "AUTHORIZATION_REVOKED" : "DEPENDENCY_UNAVAILABLE",
						status === 503,
					),
				});
			const installationId = `installation-${requests.installs.length}`;
			library.set(body.skillVersionId, installationId);
			return route.fulfill({
				status: 201,
				json: SkillHubInstallationResponseV1Schema.parse({
					replayed: false,
					installation: {
						schemaVersion: 1,
						installationId,
						principalType: "user",
						principalId: ownerId,
						skillVersionId: body.skillVersionId,
						state: "installed",
						needUpgrade: false,
						installedAt: "2026-10-18T00:00:00Z",
						updatedAt: "2026-10-18T00:00:00Z",
					},
				}),
			});
		}
		const uninstallMatch = /^\/api\/v2\/skills\/installations\/([^/]+)$/.exec(
			path,
		);
		if (uninstallMatch && request.method() === "DELETE") {
			const installationId = uninstallMatch[1] ?? "";
			requests.uninstalls.push({
				id: installationId,
				key: request.headers()["idempotency-key"],
			});
			const entry = [...library].find(([, id]) => id === installationId);
			if (!entry)
				return route.fulfill({
					status: 404,
					json: protocolError("RESOURCE_UNAVAILABLE", false),
				});
			library.delete(entry[0]);
			return route.fulfill({
				json: SkillHubInstallationResponseV1Schema.parse({
					replayed: false,
					installation: {
						schemaVersion: 1,
						installationId,
						principalType: "user",
						principalId: ownerId,
						skillVersionId: entry[0],
						state: "uninstalled",
						needUpgrade: false,
						installedAt: "2026-10-18T00:00:00Z",
						updatedAt: "2026-10-18T00:01:00Z",
					},
				}),
			});
		}
		const revokeMatch = /^\/api\/v2\/skills\/versions\/([^/]+)\/revoke$/.exec(
			path,
		);
		if (revokeMatch && request.method() === "POST") {
			requests.revokes.push({
				id: revokeMatch[1] ?? "",
				key: request.headers()["idempotency-key"],
			});
			const version = versions.find(
				(item) => item.skillVersionId === revokeMatch[1],
			) as typeof releaseV2;
			return route.fulfill({
				json: SkillHubPublicationResponseV1Schema.parse({
					replayed: false,
					version: {
						schemaVersion: 1,
						skillId: version.skillId,
						skillVersionId: version.skillVersionId,
						provider: version.provider,
						version: version.version,
						packageDigest: version.packageDigest,
						manifestDigest: version.manifestDigest,
						signatureDigest: version.signatureDigest,
						visibility: version.visibility,
						state: "revoked",
						needUpgrade: false,
						reviewedBy: null,
						reviewReason: null,
						revokedAt: "2026-10-18T00:00:00Z",
					},
				}),
			});
		}
		return route.fulfill({
			status: 404,
			json: protocolError("RESOURCE_UNAVAILABLE", false),
		});
	});
	return { requests, releaseDirectory };
}

function measureRows(page: Page) {
	return page.evaluate(() => {
		const px = (value: string) => Number.parseFloat(value);
		const rows = [
			...document.querySelectorAll<HTMLElement>("article.skill-row"),
		];
		return {
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth,
			rows: rows.map((row) => {
				const style = getComputedStyle(row);
				const mark = row.querySelector<HTMLElement>(".skill-mark");
				const pill = row.querySelector<HTMLElement>('[data-slot="badge"]');
				const meta = row.querySelector<HTMLElement>(".skill-row-meta");
				const actions = row.querySelector<HTMLElement>(".skill-actions");
				const link = row.querySelector<HTMLElement>(".skill-actions a");
				const rect = (element: HTMLElement | null) =>
					element ? element.getBoundingClientRect().toJSON() : null;
				return {
					columns: style.gridTemplateColumns.split(" ").map(px),
					gap: style.columnGap,
					padding: style.padding,
					borderBottom: style.borderBottomWidth,
					scrollWidth: row.scrollWidth,
					clientWidth: row.clientWidth,
					mark: mark && {
						width: mark.offsetWidth,
						height: mark.offsetHeight,
						border: getComputedStyle(mark).borderTopWidth,
						radius: getComputedStyle(mark).borderTopLeftRadius,
						background: getComputedStyle(mark).backgroundColor,
					},
					pillInCopy: Boolean(pill?.closest(".skill-row-copy")),
					pill: rect(pill),
					link: rect(link),
					metaColumn: meta ? getComputedStyle(meta).gridColumnStart : null,
					actionsColumn: actions
						? getComputedStyle(actions).gridColumnStart
						: null,
				};
			}),
		};
	});
}

function overlaps(
	a: { left: number; right: number; top: number; bottom: number } | null,
	b: { left: number; right: number; top: number; bottom: number } | null,
) {
	if (!a || !b) return false;
	return (
		a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
	);
}

test.describe("Skill directory", () => {
	test("renders one surface list with one row and one detail link per Skill at 1440", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Sets its own viewport.");
		await fixture(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/skills");
		await expect(
			page.getByRole("heading", { level: 1, name: "Skill Hub" }),
		).toBeVisible();
		await expect(page.locator(".page-eyebrow")).toHaveText(
			"工作区 / Skill Hub",
		);
		await expect(page.locator('[data-slot="breadcrumb-item"]')).toHaveText([
			"工作区",
			"Skill Hub",
		]);
		await expect(
			page
				.getByRole("navigation", { name: "工作区" })
				.getByRole("link", { name: "Skill Hub" }),
		).toHaveAttribute("aria-current", "page");
		await expect(page.locator("article.skill-row")).toHaveCount(3);

		const list = page.locator("[data-skill-catalog]");
		await expect(list).toHaveCSS("border-top-width", "1px");
		await expect(list).toHaveCSS("border-top-left-radius", "14px");
		const measured = await measureRows(page);
		for (const row of measured.rows) {
			expect(row.columns).toHaveLength(4);
			expect(row.columns[0]).toBe(42);
			expect(row.columns[2]).toBeGreaterThanOrEqual(130);
			expect(row.gap).toBe("16px");
			expect(row.padding).toBe("20px");
			expect(row.mark).toMatchObject({
				width: 42,
				height: 42,
				border: "1px",
				radius: "12px",
			});
		}
		expect(measured.rows.map((row) => row.borderBottom)).toEqual([
			"1px",
			"1px",
			"0px",
		]);
		const surfaceRaised = await page.evaluate(() => {
			const probe = document.createElement("span");
			probe.style.backgroundColor = "var(--surface-raised)";
			document.body.append(probe);
			const color = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return color;
		});
		expect(measured.rows[0]?.mark?.background).toBe(surfaceRaised);

		const heading = page.locator("article.skill-row h2").first();
		await expect(heading).toHaveCSS("font-size", "16px");
		await expect(heading).toHaveCSS("font-weight", "600");
		await expect(heading.locator("a")).toHaveCount(0);
		const release = page.locator("article.skill-row", {
			has: page.getByRole("heading", { name: "release-notes" }),
		});
		await expect(release.locator(".skill-row-meta strong")).toHaveText(
			"v1.2.0",
		);
		const detail = release.getByRole("link");
		await expect(detail).toHaveCount(1);
		await expect(detail).toHaveAccessibleName("查看详情：release-notes");
		await expect(detail).toHaveAttribute("href", "/skills/release-notes-v2");
		const box = await detail.boundingBox();
		expect(box?.height).toBeGreaterThanOrEqual(44);
		// N-04 / NI-98：来源与范围合并成一个没有 aria-label 的标签。
		const pill = release.locator('[data-slot="badge"]');
		await expect(pill).toHaveCount(1);
		await expect(pill).toHaveAttribute("data-variant", "tag");
		await expect(pill).toHaveText("范围：仅自己 · 来源：我的库");
		expect(await pill.evaluate((node) => node.hasAttribute("aria-label"))).toBe(
			false,
		);
		const main = page.locator("#main-content");
		await expect(main).not.toContainText("版本 ID");
		await expect(main).not.toContainText("release-notes-v");
		await expect(main).not.toContainText(/metadata|Worker\/Runtime/);

		// K-06：工具栏三轨，下拉 label 只给读屏。
		const toolbar = page.locator(".skill-toolbar");
		const tracks = await toolbar.evaluate((node) =>
			getComputedStyle(node)
				.gridTemplateColumns.split(" ")
				.map((value) => Number.parseFloat(value)),
		);
		expect(tracks).toHaveLength(3);
		expect(tracks[1]).toBeGreaterThanOrEqual(140);
		expect(tracks[2]).toBeGreaterThanOrEqual(140);
		await expect(toolbar).toHaveCSS("column-gap", "10px");
		await expect(toolbar).toHaveCSS("margin-top", "20px");
		await expect(toolbar).toHaveCSS("margin-bottom", "20px");
		for (const name of ["来源", "发布范围"]) {
			await expect(
				page.getByRole("combobox", { name, exact: true }),
			).toBeVisible();
			await expect(
				page.locator("label", { hasText: new RegExp(`^${name}$`) }),
			).toHaveClass(/sr-only/);
		}

		// NI-100：Tab 顺序为搜索 → 来源 → 发布范围 → 每行唯一的「查看详情」。
		await page.getByRole("searchbox", { name: "搜索 Skill" }).focus();
		const order: string[] = [];
		for (let index = 0; index < 6; index += 1) {
			await page.keyboard.press("Tab");
			order.push(
				await page.evaluate(() => {
					const active = document.activeElement;
					return (
						active?.getAttribute("aria-label") ??
						(active?.tagName === "SELECT"
							? `select${active.id.slice(active.id.lastIndexOf("-"))}`
							: (active?.textContent?.trim() ?? ""))
					);
				}),
			);
		}
		// 区块标题旁的「我的 Skill」之后，每行只有一个 Tab 停靠点。
		expect(order).toEqual([
			"select-provider",
			"select-visibility",
			"我的 Skill",
			"查看详情：release-notes",
			"查看详情：incident-summary-with-a-long-package-name",
			"查看详情：code-review",
		]);
	});

	// 设计断点为 ≤1023px，用 1000 宽验证中间档。
	test("reflows rows at 1000, 390 and 320 without overlap or horizontal scroll", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Sets its own viewports.");
		await fixture(page);
		await page.setViewportSize({ width: 1000, height: 768 });
		await page.goto("/skills");
		await expect(page.locator("article.skill-row")).toHaveCount(3);
		let measured = await measureRows(page);
		for (const row of measured.rows) {
			expect(row.columns).toHaveLength(3);
			expect(row.metaColumn).toBe("2");
			expect(row.actionsColumn).toBe("3");
		}
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
			measured = await measureRows(page);
			expect(measured.scrollWidth).toBeLessThanOrEqual(measured.innerWidth);
			for (const row of measured.rows) {
				expect(row.columns).toHaveLength(2);
				expect(row.columns[0]).toBe(36);
				expect(row.gap).toBe("12px");
				expect(row.padding).toBe("16px");
				expect(row.mark).toMatchObject({ width: 36, height: 36 });
				expect(row.metaColumn).toBe("2");
				expect(row.actionsColumn).toBe("2");
				// NI-103：标签在名称列内，不与「查看详情」重叠，行内不溢出。
				expect(row.pillInCopy).toBe(true);
				expect(overlaps(row.pill, row.link)).toBe(false);
				expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
				expect(row.link?.height).toBeGreaterThanOrEqual(44);
			}
		}
	});

	test("shows a skeleton while reading and clears filters back to the full list", async ({
		page,
	}) => {
		const pageErrors = trackPageErrors(page);
		const control = await fixture(page, { directory: "delayed" });
		await page.goto("/skills");
		const loading = page.locator("#main-content .skill-loading");
		await expect(loading).toBeVisible();
		await expect(loading).toHaveAttribute("role", "status");
		await expect(loading.locator(".skill-skeleton")).toHaveCount(2);
		await expect(loading).toContainText("正在读取 Skill 目录…");
		control.releaseDirectory();
		await expect(page.locator("article.skill-row")).toHaveCount(3);
		await expect(page.getByRole("button", { name: "清除筛选" })).toHaveCount(0);
		// #3037 X-14：窄屏区头「我的 Skill」与「Skill 目录」顶对齐。
		if (test.info().project.name === "mobile")
			await expectSectionHeadTopAligned(
				page.getByRole("heading", { level: 2, name: "Skill 目录" }),
				page.getByRole("link", { name: "我的 Skill" }),
			);
		await expectNativeSelectArrow(
			page,
			page.getByRole("combobox", { name: "来源", exact: true }),
		);

		const search = page.getByRole("searchbox", { name: "搜索 Skill" });
		await search.fill("no-such-skill");
		await expect(page.getByText("没有匹配的 Skill")).toBeVisible();
		await expect(page.getByText("换个关键词，或清除筛选。")).toBeVisible();
		// #3037 X-13：图标与文字一行、操作一行，两行均分，操作不再额外下移 14px。
		// 图标下方沿 .empty svg 的 11px，不作为行内元素多出基线间隙；#3107 已按此回写导出稿 skillEmpty，
		// 各行与导出稿实测一致（web-ui.md「已回写导出设计的结论」X-13）。
		await expectEmptyRows(page.locator('#main-content [data-slot="empty"]'), {
			icon: 37.2,
			title: 76.2,
			description: 100.95,
			action: 138.8,
		});
		await expectCleanPage(page, pageErrors);
		await page
			.getByRole("combobox", { name: "来源", exact: true })
			.selectOption("github");
		await page.getByRole("button", { name: "清除筛选" }).click();
		await expect(search).toHaveValue("");
		await expect(
			page.getByRole("combobox", { name: "来源", exact: true }),
		).toHaveValue("all");
		await expect(search).toBeFocused();
		await expect(page.locator("article.skill-row")).toHaveCount(3);
	});

	test("explains a 503 with retry, re-reads through the loading state, and hides retry on 403", async ({
		page,
	}) => {
		const control = await fixture(page, { directory: "unavailable" });
		await page.goto("/skills");
		const main = page.locator("#main-content");
		await expect(main.getByText("暂时无法读取目录")).toBeVisible();
		await expect(main.getByText("已安装和绑定记录仍然保留。")).toBeVisible();
		await expect(main.locator('[data-slot="alert"]')).toHaveCount(0);
		// #3037 X-13：读取失败空态与无匹配空态同一行分配。
		await expectEmptyRows(main.locator('[data-slot="empty"]'), {
			icon: 37.2,
			title: 76.2,
			description: 100.95,
			action: 138.8,
		});
		await main.getByRole("button", { name: "重新读取" }).click();
		await expect(page.locator("article.skill-row")).toHaveCount(3);
		expect(control.requests.directory).toBeGreaterThanOrEqual(2);

		await page.unrouteAll({ behavior: "ignoreErrors" });
		await fixture(page, { directory: "denied" });
		await page.reload();
		await expect(
			main.getByText("当前账号没有读取 Skill 目录的权限。"),
		).toBeVisible();
		await expect(main.getByRole("button", { name: "重新读取" })).toHaveCount(0);
	});
});

test.describe("Skill version detail", () => {
	test("keeps the tab in the URL and switches between this Skill's versions", async ({
		page,
	}) => {
		await fixture(page);
		await page.goto("/skills/release-notes-v2");
		await expect(
			page.getByRole("heading", { level: 1, name: "release-notes" }),
		).toBeVisible();
		await expect(page.locator(".page-eyebrow")).toHaveText("Skill Hub");
		await expect(page.locator('[data-slot="breadcrumb-item"]')).toHaveText([
			"Skill Hub",
			"Skill 详情",
		]);
		await expect(
			page.getByRole("link", { name: "返回 Skill Hub" }),
		).toHaveAttribute("href", "/skills");
		// N-21：/skills 是当前地址的前缀，返回链接不能被前缀匹配标成当前页；全页只有主导航
		// 「Skill Hub」一个当前页链接。
		await expect(
			page.getByRole("link", { name: "返回 Skill Hub" }),
		).not.toHaveAttribute("aria-current", /.*/);
		await expect(page.locator('a[aria-current="page"]')).toHaveCount(1);
		await expect(
			page.locator('nav[aria-label="主导航"] a[aria-current="page"]'),
		).toHaveText("Skill Hub");
		const main = page.locator("#main-content");
		for (const hidden of ["版本 ID", "Skill ID", "Manifest 摘要", "metadata"])
			await expect(main).not.toContainText(hidden);
		await expect(main).not.toContainText("a".repeat(64));

		const tablist = page.getByRole("tablist", { name: "Skill 详情" });
		await expect(
			tablist.getByRole("tab", { name: "用途与内容" }),
		).toHaveAttribute("aria-selected", "true");
		await tablist.getByRole("tab", { name: "版本与变更" }).click();
		await expect(page).toHaveURL(/\/skills\/release-notes-v2\?tab=versions$/);
		await page.reload();
		await expect(
			tablist.getByRole("tab", { name: "版本与变更" }),
		).toHaveAttribute("aria-selected", "true");
		const lines = page.locator(".version-line");
		await expect(lines).toHaveCount(2);
		await expect(lines.nth(0).locator("strong")).toHaveText("v1.2.0");
		await expect(lines.nth(1).locator("strong")).toHaveText("v1.0.0");
		await expect(
			lines.nth(0).getByRole("button", { name: "正在查看" }),
		).toBeDisabled();
		await lines.nth(1).getByRole("link", { name: "查看版本：v1.0.0" }).click();
		await expect(page).toHaveURL(/\/skills\/release-notes-v1\?tab=versions$/);
		const summary = page.getByRole("complementary", { name: "版本与权限" });
		await expect(summary.locator("dd").first()).toHaveText("v1.0.0");
		await expect(main).not.toContainText("incident-summary");
	});

	test("lays out two columns at 1440 and one column with 16px sections at 390", async ({
		page,
	}, info) => {
		test.skip(info.project.name !== "desktop", "Sets its own viewports.");
		await fixture(page);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto("/skills/release-notes-v2");
		const grid = page.locator(".skill-grid");
		await expect(grid).toBeVisible();
		const columns = await grid.evaluate((node) =>
			getComputedStyle(node)
				.gridTemplateColumns.split(" ")
				.map(Number.parseFloat),
		);
		expect(columns).toHaveLength(2);
		expect(columns[1]).toBeGreaterThanOrEqual(260);
		await expect(grid).toHaveCSS("column-gap", "22px");
		const facts = page.locator(".skill-summary dt").first();
		expect((await facts.boundingBox())?.width).toBe(90);
		await expect(facts).toHaveCSS("font-size", "12px");
		for (const [width, height] of [
			[1000, 768],
			[390, 844],
			[320, 568],
		] as const) {
			await page.setViewportSize({ width, height });
			const single = await grid.evaluate(
				(node) => getComputedStyle(node).gridTemplateColumns.split(" ").length,
			);
			expect(single).toBe(1);
			if (width < 768) {
				await expect(page.locator(".skill-section").first()).toHaveCSS(
					"padding-top",
					"16px",
				);
				await expect(page.locator(".skill-summary")).toHaveCSS(
					"padding-top",
					"16px",
				);
			}
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			).toBe(true);
		}
	});

	test("installs for the session user with one reused key and switches to Agent binding", async ({
		page,
	}) => {
		const control = await fixture(page, { install: [503, 201] });
		await page.goto("/skills/release-notes-v2");
		const add = page.getByRole("button", { name: "加入我的库" });
		await add.click();
		await expect(page.locator("#main-content").getByRole("alert")).toHaveText(
			"暂时无法加入我的库，请稍后重试。",
		);
		await add.click();
		const configure = page.getByRole("link", { name: "配置 Agent 绑定" });
		await expect(configure).toBeFocused();
		await expect(page.locator('[data-slot="toast"]')).toHaveText(
			"固定版本已加入我的库，尚未绑定到 Agent",
		);
		expect(control.requests.installs).toHaveLength(2);
		expect(control.requests.installs[0]?.body).toEqual({
			principalType: "user",
			principalId: ownerId,
			skillVersionId: "release-notes-v2",
		});
		expect(control.requests.installs[0]?.key).toBeTruthy();
		expect(control.requests.installs[0]?.key).toBe(
			control.requests.installs[1]?.key,
		);
		await expect(page.locator("#main-content input")).toHaveCount(0);
	});

	test("confirms revoke before one request and keeps cancel, Escape and backdrop request-free", async ({
		page,
	}) => {
		const pageErrors = trackPageErrors(page);
		const control = await fixture(page);
		await page.goto("/skills/release-notes-v2");
		const trigger = page.getByRole("button", { name: "撤销此版本" });
		await expect(trigger).toBeVisible();
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "撤销这个 Skill 版本？" });
		await expect(dialog).toContainText(
			"阻止新的安装、绑定与调用。已发生的执行及结果继续保留原版本。",
		);
		// #3037 X-15：Skill 确认弹窗使用设计 .skill-dialog 外观与文字「关闭」。
		await expectSkillDialog(
			page,
			dialog,
			test.info().project.name === "mobile",
		);
		await dialog.getByRole("button", { name: "取消" }).click();
		await expect(dialog).toBeHidden();
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await trigger.click();
		await expect(dialog).toBeVisible();
		await page.mouse.click(4, 4);
		await expect(dialog).toBeHidden();
		expect(control.requests.revokes).toHaveLength(0);

		await trigger.click();
		await dialog.getByRole("button", { name: "确认撤销" }).click();
		await expect(page.locator('[data-slot="toast"]')).toHaveText(
			"版本已撤销，新的调用已被阻止",
		);
		await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
		await expectCleanPage(page, pageErrors);
		expect(control.requests.revokes).toHaveLength(1);
		expect(control.requests.revokes[0]).toMatchObject({
			id: "release-notes-v2",
		});
		expect(control.requests.revokes[0]?.key).toBeTruthy();
		const summary = page.getByRole("complementary", { name: "版本与权限" });
		await expect(summary.getByText("已撤销", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "加入我的库" })).toHaveCount(
			0,
		);
		await expect(trigger).toHaveCount(0);
	});

	test("does not offer revoke for a Skill the user did not create", async ({
		page,
	}) => {
		await fixture(page);
		await page.goto("/skills/incident-summary-v1");
		await expect(
			page.getByRole("heading", { level: 1, name: incident.name }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "加入我的库" }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "撤销此版本" })).toHaveCount(
			0,
		);
		// 发布者显示目录中的名称，不显示内部用户 ID。
		const summary = page.getByRole("complementary", { name: "版本与权限" });
		await expect(summary.getByText("市场维护人")).toBeVisible();
		await expect(page.locator("#main-content")).not.toContainText(
			marketOwnerId,
		);
	});

	test("shows SKILL.md as text with its resources and re-reads the library after install and removal (K-02)", async ({
		page,
	}) => {
		const errors = trackPageErrors(page);
		const control = await fixture(page);
		await page.goto("/skills/release-notes-v2");
		const main = page.locator("#main-content");
		const summary = page.getByRole("complementary", { name: "版本与权限" });
		const fact = (label: string) =>
			summary
				.locator("dt", { hasText: new RegExp(`^${label}$`) })
				.locator("xpath=following-sibling::dd[1]");
		const library = fact("我的库");
		await expect(summary.locator("dt")).toHaveText([
			"版本",
			"发布状态",
			"发布者",
			"来源",
			"可见范围",
			"我的库",
			"脚本",
			"网络权限",
		]);
		await expect(fact("发布者")).toHaveText("Skill 发布者");
		await expect(library).toHaveText("尚未安装");
		// 正文按纯文本显示：<script> 只是文字，不会执行或生成元素。
		const body = page.getByRole("region", { name: "SKILL.md 正文" });
		await expect(body).toContainText(
			"<script>window.__skillBodyExecuted = true</script>",
		);
		expect(await body.locator("pre").textContent()).toBe(skillBody);
		await expect(main.locator("script")).toHaveCount(0);
		expect(
			await page.evaluate(
				() => (window as { __skillBodyExecuted?: boolean }).__skillBodyExecuted,
			),
		).toBeUndefined();
		await body.focus();
		await expect(body).toBeFocused();
		const resources = main
			.getByRole("heading", { level: 2, name: "配套资源" })
			.locator("xpath=..")
			.locator("li");
		await expect(resources).toHaveText([
			"references/style-guide.md参考资料 · 2 KB",
			"scripts/collect.sh脚本 · 120 B",
		]);

		await page.getByRole("button", { name: "加入我的库" }).click();
		const configure = page.getByRole("link", { name: "配置 Agent 绑定" });
		await expect(configure).toBeFocused();
		await expect(library).toHaveText("已在我的库");
		// 安装后立即回读详情，刷新后仍以服务端的安装状态显示。
		await expect
			.poll(() => control.requests.details.length)
			.toBeGreaterThanOrEqual(2);
		await page.reload();
		await expect(library).toHaveText("已在我的库");
		await expect(configure).toBeVisible();

		// V-12：页头只放一个主操作，「移出我的库」在侧栏，加入前后 h1 不跳动。
		const header = main.locator(".page-heading");
		await expect(
			header.getByRole("button", { name: "移出我的库" }),
		).toHaveCount(0);
		await expect(
			summary.getByRole("button", { name: "移出我的库" }),
		).toBeVisible();
		const headingTop = async () =>
			(await page.getByRole("heading", { level: 1 }).boundingBox())?.y ?? 0;
		const installedTop = await headingTop();
		// AC-2：页头「配置 Agent 绑定」与侧栏「移出我的库」不同名，同页没有同名控件。
		await expectNoDuplicateControls(page, "Skill 详情（已加入）");

		const remove = summary.getByRole("button", { name: "移出我的库" });
		const readsBeforeRemoval = control.requests.details.length;
		await remove.click();
		const add = page.getByRole("button", { name: "加入我的库" });
		await expect(add).toBeFocused();
		await expect(library).toHaveText("尚未安装");
		await expect(page.locator('[data-slot="toast"]')).toHaveText(
			"已移出我的库",
		);
		expect(control.requests.uninstalls).toHaveLength(1);
		expect(control.requests.uninstalls[0]?.id).toBe("installation-1");
		expect(control.requests.uninstalls[0]?.key).toBeTruthy();
		expect(Math.abs((await headingTop()) - installedTop)).toBeLessThanOrEqual(
			1,
		);
		await expect
			.poll(() => control.requests.details.length)
			.toBeGreaterThan(readsBeforeRemoval);
		await page.reload();
		await expect(library).toHaveText("尚未安装");
		await expectNoDuplicateControls(page, "Skill 详情");
		await expectCleanPage(page, errors);
	});

	test("lets the publisher read back pending and rejected versions from My Skill (K-02)", async ({
		page,
	}) => {
		const control = await fixture(page, { unpublished: true });
		await page.goto("/skills/manage");
		const main = page.locator("#main-content");
		const release = main.locator("article.skill-row", {
			has: page.getByRole("heading", { name: "release-notes" }),
		});
		await expect(release.locator('[data-slot="badge"]')).toHaveText("待审核");
		await expect(release.locator(".skill-row-meta strong")).toHaveText(
			"v1.3.0",
		);
		const digest = main.locator("article.skill-row", {
			has: page.getByRole("heading", { name: "weekly-digest" }),
		});
		await expect(digest.locator('[data-slot="badge"]')).toHaveText("已驳回");
		await release.getByRole("link", { name: "详情：release-notes" }).click();
		await expect(page).toHaveURL(/\/skills\/release-notes-v3$/);
		const summary = page.getByRole("complementary", { name: "版本与权限" });
		await expect(
			summary
				.locator("dt", { hasText: /^发布状态$/ })
				.locator("xpath=following-sibling::dd[1]"),
		).toHaveText("待审核");
		// 未发布的版本不能安装或撤销，创建者可以编辑新版本。
		await expect(page.getByRole("button", { name: "加入我的库" })).toHaveCount(
			0,
		);
		await expect(page.getByRole("button", { name: "撤销此版本" })).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("link", { name: "编辑新版本" }),
		).toHaveAttribute("href", "/skills/manage/new?project=release-notes");
		await page
			.getByRole("tablist", { name: "Skill 详情" })
			.getByRole("tab", { name: "版本与变更" })
			.click();
		const lines = page.locator(".version-line");
		await expect(lines.locator("strong")).toHaveText([
			"v1.3.0",
			"v1.2.0",
			"v1.0.0",
		]);
		await expect(lines.locator('[data-slot="badge"]')).toHaveText([
			"待审核",
			"已发布",
			"已发布",
		]);
		// 看不到的版本与不存在的版本一样只得到无法访问，不提供重新读取。
		await page.goto("/skills/someone-else-pending-v1");
		await expect(
			page.getByRole("heading", { level: 1, name: "Skill 详情" }),
		).toBeVisible();
		await expect(page.getByRole("button", { name: "重新读取" })).toHaveCount(0);
		expect(control.requests.details).toContain("someone-else-pending-v1");
		expect(control.requests.writes).toEqual([]);
	});
});
