import {
	SkillHubDirectoryPageV1Schema,
	SkillHubInstallationCommandV1Schema,
	SkillHubInstallationResponseV1Schema,
	SkillHubProjectPageV1Schema,
	SkillHubPublicationResponseV1Schema,
	SkillHubVersionMetadataV1Schema,
} from "@agent-infra/contracts/pilot";
import { expect, type Page, test } from "@playwright/test";

// Skill 目录与版本详情（K-01、K-02、K-05、K-06、N-04 与防回归 NI-98/100/103）。
const ownerId = "skill-browser-owner";
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
};

async function fixture(page: Page, options: Fixture = {}) {
	const requests = {
		directory: 0,
		installs: [] as { body: unknown; key?: string }[],
		revokes: [] as { id: string; key?: string }[],
		writes: [] as string[],
	};
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
		const versionMatch = /^\/api\/v2\/skills\/versions\/([^/]+)$/.exec(path);
		if (versionMatch && request.method() === "GET") {
			const version = versions.find(
				(item) => item.skillVersionId === versionMatch[1],
			);
			return version
				? route.fulfill({ json: version })
				: route.fulfill({
						status: 404,
						json: protocolError("RESOURCE_UNAVAILABLE", false),
					});
		}
		if (path === "/api/v2/skills/projects" && request.method() === "GET")
			return route.fulfill({
				json: SkillHubProjectPageV1Schema.parse({
					items: [
						{
							schemaVersion: 1,
							projectId: "release-notes",
							name: "release-notes",
							ownerId,
							organizationId: null,
							status: "active",
							createdAt: "2026-10-01T00:00:00Z",
							updatedAt: "2026-10-01T00:00:00Z",
						},
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
			return route.fulfill({
				status: 201,
				json: SkillHubInstallationResponseV1Schema.parse({
					replayed: false,
					installation: {
						schemaVersion: 1,
						installationId: "installation-1",
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

		const search = page.getByRole("searchbox", { name: "搜索 Skill" });
		await search.fill("no-such-skill");
		await expect(page.getByText("没有匹配的 Skill")).toBeVisible();
		await expect(page.getByText("换个关键词，或清除筛选。")).toBeVisible();
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
		const control = await fixture(page);
		await page.goto("/skills/release-notes-v2");
		const trigger = page.getByRole("button", { name: "撤销此版本" });
		await expect(trigger).toBeVisible();
		await trigger.click();
		const dialog = page.getByRole("dialog", { name: "撤销这个 Skill 版本？" });
		await expect(dialog).toContainText(
			"阻止新的安装、绑定与调用。已发生的执行及结果继续保留原版本。",
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
	});
});
