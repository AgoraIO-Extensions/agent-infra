import { expect, test } from "@playwright/test";
import { startEvaluationBrowserFixture } from "../../platform-api/src/evaluation-data.browser-test-support.js";

test("uses the real API, PostgreSQL and S3 for explicit grants, import, revoke and deletion", async ({
	page,
	context,
}) => {
	test.setTimeout(120000);
	const fixture = await startEvaluationBrowserFixture();
	try {
		await context.addCookies([
			{
				name: "session",
				value: "browser-admin",
				domain: "127.0.0.1",
				path: "/",
			},
		]);
		await page.route("**/api/**", async (route) => {
			const incoming = route.request();
			const url = new URL(incoming.url());
			const response = await fetch(
				`${fixture.origin}${url.pathname}${url.search}`,
				{
					method: incoming.method(),
					headers: incoming.headers(),
					...(incoming.postDataBuffer()
						? { body: new Uint8Array(incoming.postDataBuffer() ?? []) }
						: {}),
					redirect: "manual",
				},
			);
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: Buffer.from(await response.arrayBuffer()),
			});
		});
		await page.goto("/eval");
		await expect(page.getByText("当前没有可见评测集。")).toBeVisible();
		await page
			.getByLabel("评测集名称", { exact: true })
			.fill("Browser data fixture");
		await page.getByLabel("部署批准的范围").fill("test");
		await page.getByRole("button", { name: "创建空评测集" }).click();
		await page.getByRole("button", { name: "预留新版本" }).click();
		await page.getByRole("button", { name: "选择此版本" }).click();
		await page.getByLabel("接收主体稳定 ID").fill("browser-admin");
		await page
			.getByLabel("授权到期时间（UTC ISO）")
			.fill(new Date(Date.now() + 300000).toISOString());
		await page.getByRole("button", { name: "显式授予用途权限" }).click();
		const content = {
			schemaVersion: 1,
			provenance: { approvalId: "browser-synthetic" },
			samples: [
				{
					id: "s",
					input: "SYNTHETIC-BROWSER-CONTENT",
					context: null,
					taskType: "answer",
					expectedResult: null,
				},
			],
			rubric: [{ id: "r", description: "Synthetic rubric" }],
		};
		await page
			.getByLabel("获准的样本与判定标准 JSON")
			.fill(JSON.stringify(content));
		await page.getByRole("button", { name: "导入所选版本" }).click();
		await page.getByRole("button", { name: "读取内容" }).click();
		await expect(page.locator("pre")).toContainText(
			"SYNTHETIC-BROWSER-CONTENT",
		);
		await page.getByRole("button", { name: "撤销授权" }).click();
		await expect(page.locator("pre")).toHaveCount(0);
		await page.getByRole("button", { name: "读取内容" }).click();
		await expect(page.getByText("内容不可用或用途授权已撤销。")).toBeVisible();
		await page.getByRole("button", { name: "显式授予用途权限" }).click();
		await page.getByRole("button", { name: "删除内容" }).click();
		await expect(page.getByRole("button", { name: "确认删除" })).toBeVisible();
		await page.getByRole("button", { name: "确认删除" }).click();
		await expect(page.getByRole("button", { name: "读取内容" })).toBeDisabled();
	} finally {
		await page.goto("about:blank");
		await page.unrouteAll({ behavior: "wait" });
		await fixture.close();
	}
});
