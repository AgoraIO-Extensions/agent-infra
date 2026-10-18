import { expect, type Page, test } from "@playwright/test";
import { computed, resolved } from "./primitive-styles";

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
	await expect(surface.getByRole("tabpanel", { name: "反馈" })).toContainText(
		"还没有主动反馈",
	);
	await surface.getByRole("link", { name: "查看对话反馈" }).click();
	await expect(page).toHaveURL(/\/agents\?mode=conversation$/);
	expect(api.writes).toEqual([]);
});
