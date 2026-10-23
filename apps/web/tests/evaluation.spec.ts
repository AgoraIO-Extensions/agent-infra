import { expect, type Page, test } from "@playwright/test";
import { expectNoDuplicateControls } from "./page-health";
import {
	computed,
	expectCleanPage,
	expectEmptyRows,
	resolved,
	trackPageErrors,
} from "./primitive-styles";

// 评测页（R-03）：设计 #eval 的页头主操作、notice、卡内分段与各段空态。
async function fixture(page: Page) {
	const writes: string[] = [];
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "evaluation-browser",
						displayName: "评测用户",
						roles: ["employee", "system_admin"],
					},
				},
			});
		return route.fulfill({
			status: 404,
			json: {
				schemaVersion: 1,
				code: "RESOURCE_UNAVAILABLE",
				message: "Not part of evaluation fixture",
				retryable: false,
				traceId: "trace-evaluation-fixture",
			},
		});
	});
	return { writes };
}

test("evaluation keeps the design heading, notice and in-card segments without sample data", async ({
	page,
}, info) => {
	const pageErrors = trackPageErrors(page);
	const api = await fixture(page);
	await page.goto("/eval");
	const main = page.locator("#main-content");
	await expect(
		main.getByRole("heading", { level: 1, name: "评测", exact: true }),
	).toBeVisible();

	// 主操作在页头；接口未接入时不可用，说明在卡片底部。
	const create = main.getByRole("button", { name: "创建评测集" });
	await expect(create).toBeDisabled();
	await expect(create).toHaveAttribute(
		"aria-describedby",
		"evaluation-pending-note",
	);
	expect(
		await create.evaluate(
			(element) => element.closest(".page-heading") !== null,
		),
	).toBe(true);
	await expect(main.getByText("评测使用独立授权")).toBeVisible();

	// 分段在卡内：外框无阴影、padding 20，分段 42px / radius 8 / 12px，选中 surface-raised + 650。
	const surface = main.locator(".evaluation-surface");
	expect(
		await computed(surface, [
			"paddingTop",
			"paddingLeft",
			"borderTopLeftRadius",
			"boxShadow",
			"marginTop",
		]),
	).toEqual({
		paddingTop: "20px",
		paddingLeft: "20px",
		borderTopLeftRadius: "14px",
		boxShadow: "none",
		marginTop: info.project.name === "mobile" ? "26px" : "32px",
	});
	const tablist = surface.getByRole("tablist", { name: "评测区域" });
	await expect(tablist.getByRole("tab")).toHaveText(["评测集", "实验", "反馈"]);
	expect(
		await computed(tablist, ["columnGap", "marginBottom", "borderBottomWidth"]),
	).toEqual({
		columnGap: "4px",
		marginBottom: "14px",
		borderBottomWidth: "0px",
	});
	const selected = tablist.getByRole("tab", { name: "评测集" });
	const idle = tablist.getByRole("tab", { name: "实验" });
	await expect(selected).toHaveAttribute("aria-selected", "true");
	expect(
		await computed(selected, [
			"minHeight",
			"height",
			"paddingTop",
			"paddingLeft",
			"borderTopLeftRadius",
			"fontSize",
			"fontWeight",
			"backgroundColor",
			"color",
		]),
	).toEqual({
		minHeight: "42px",
		height: "42px",
		paddingTop: "8px",
		paddingLeft: "12px",
		borderTopLeftRadius: "8px",
		fontSize: "12px",
		fontWeight: "650",
		backgroundColor: await resolved(
			page,
			"backgroundColor",
			"var(--surface-raised)",
		),
		color: await resolved(page, "color", "var(--foreground)"),
	});
	expect(
		await computed(idle, ["fontWeight", "color", "backgroundColor"]),
	).toEqual({
		fontWeight: "400",
		color: await resolved(page, "color", "var(--muted-foreground)"),
		backgroundColor: "rgba(0, 0, 0, 0)",
	});

	// 每段各有空态，不出现设计原型里的示例数据。
	await expect(surface.getByRole("tabpanel", { name: "评测集" })).toContainText(
		"还没有评测集",
	);
	await expect(main).not.toContainText("支持场景回归集");
	await idle.click();
	await expect(surface.getByRole("tabpanel", { name: "实验" })).toContainText(
		"还没有实验",
	);
	await tablist.getByRole("tab", { name: "反馈" }).click();
	const feedback = surface.getByRole("tabpanel", { name: "反馈" });
	await expect(feedback).toContainText("还没有主动反馈");
	// #3037 X-16：标题、说明与操作各占一行均分，取导出稿 eval-feedback-empty 的测量值。
	await expectEmptyRows(feedback.locator('[data-slot="empty"]'), {
		icon: null,
		title: 40.97,
		description: 89.66,
		action: 135.03,
	});
	await expectCleanPage(page, pageErrors);
	await surface.getByRole("link", { name: "查看对话反馈" }).click();
	await expect(page).toHaveURL(/\/agents\?mode=conversation$/);
	expect(api.writes).toEqual([]);
});

// #3242 K7-04：分段面板只包一张 14px 圆角的虚线空态，面板取同一圆角：Tab 键从选中的分段进入面板后，
// 键盘焦点环沿空态外框，不在圆角外露出直角；面板在评测卡片 20px 内边距内，焦点环不越过卡片圆角。
test("evaluation segment panels take the empty state's 14px radius for the keyboard focus ring (K7-04)", async ({
	page,
}, info) => {
	await page.setViewportSize(
		info.project.name === "mobile"
			? { width: 390, height: 844 }
			: { width: 1440, height: 900 },
	);
	const pageErrors = trackPageErrors(page);
	await fixture(page);
	await page.goto("/eval");
	const tablist = page.getByRole("tablist", { name: "评测区域" });
	const tabs = tablist.getByRole("tab");
	await expect(tabs).toHaveText(["评测集", "实验", "反馈"]);
	for (const tab of await tabs.all()) {
		const name = (await tab.textContent()) ?? "";
		await tab.click();
		await expect(tab).toHaveAttribute("aria-selected", "true");
		await tab.focus();
		await page.keyboard.press("Tab");
		// 切换时上一面板在退出动画期间仍挂载（inert），按名称只取当前分段的面板。
		const panel = page.getByRole("tabpanel", { name });
		await expect(panel).toBeFocused();
		const ring = await panel.evaluate((element) => {
			const style = getComputedStyle(element);
			const empty = element.querySelector<HTMLElement>('[data-slot="empty"]');
			const card = element.closest<HTMLElement>(".evaluation-surface");
			if (!empty || !card) throw new Error("Missing evaluation panel parts");
			const panelBox = element.getBoundingClientRect();
			const emptyBox = empty.getBoundingClientRect();
			const cardBox = card.getBoundingClientRect();
			const reach =
				Number.parseFloat(style.outlineOffset) +
				Number.parseFloat(style.outlineWidth);
			return {
				radius: style.borderTopLeftRadius,
				emptyRadius: getComputedStyle(empty).borderTopLeftRadius,
				// 面板与空态同一外框。
				sameBox:
					Math.abs(panelBox.width - emptyBox.width) < 0.5 &&
					Math.abs(panelBox.height - emptyBox.height) < 0.5,
				outline: [style.outlineStyle, style.outlineWidth, style.outlineOffset],
				// 焦点环外缘仍在卡片的内边距之内。
				insideCard:
					panelBox.left - reach >= cardBox.left &&
					panelBox.right + reach <= cardBox.right &&
					panelBox.top - reach >= cardBox.top &&
					panelBox.bottom + reach <= cardBox.bottom,
			};
		});
		expect(ring, `${name} 面板`).toEqual({
			radius: "14px",
			emptyRadius: "14px",
			sameBox: true,
			outline: ["solid", "2px", "3px"],
			insideCard: true,
		});
	}
	await expectNoDuplicateControls(page, "评测（K7-04）");
	await expectCleanPage(page, pageErrors);
});
