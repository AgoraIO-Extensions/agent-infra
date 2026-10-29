import { expect, test } from "@playwright/test";
import type { EvaluationBrowserFixture } from "./evaluation-fixture.js";

test("a real completed Web task exposes feedback on its historical reply", async ({
	page,
	context,
}, info) => {
	test.setTimeout(90_000);
	page.setDefaultTimeout(15_000);
	const support = (await import(
		new URL(
			"../../platform-api/src/evaluation-workflow.browser-test-support.ts",
			import.meta.url,
		).href
	)) as {
		startEvaluationWorkflowBrowserFixture: () => Promise<EvaluationBrowserFixture>;
	};
	const fixture = await support.startEvaluationWorkflowBrowserFixture();
	const statuses: { path: string; status: number }[] = [];
	try {
		const task = await fixture.createOnlineTask();
		await context.addCookies([
			{
				name: "session",
				value: fixture.roles.runner,
				domain: "127.0.0.1",
				path: "/",
			},
		]);
		await page.route("**/api/**", async (route) => {
			const req = route.request();
			const url = new URL(req.url());
			const response = await fetch(
				`${fixture.origin}${url.pathname}${url.search}`,
				{
					method: req.method(),
					headers: req.headers(),
					...(req.postDataBuffer()
						? { body: new Uint8Array(req.postDataBuffer() ?? []) }
						: {}),
				},
			);
			statuses.push({ path: url.pathname, status: response.status });
			let body: Buffer;
			if (
				response.headers.get("content-type")?.includes("text/event-stream") &&
				response.body
			) {
				const reader = response.body.getReader();
				try {
					body = Buffer.from((await reader.read()).value ?? []);
				} finally {
					await reader.cancel();
				}
			} else body = Buffer.from(await response.arrayBuffer());
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body,
			});
		});
		await page.goto(`/chat/${fixture.agentId}/${task.conversationId}`);
		await expect(
			page.getByText("Synthetic feedback task", { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: /任务反馈/ }).click();
		await page.getByRole("button", { name: "无用", exact: true }).click();
		await page.getByRole("checkbox", { name: "正确性", exact: true }).check();
		await page.getByRole("button", { name: "提交反馈", exact: true }).click();
		await expect(page.getByText("反馈已保存。")).toBeVisible();
		await page.reload();
		await page.getByRole("button", { name: /任务反馈/ }).click();
		await expect(
			page.getByRole("button", { name: "无用", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(
			page.getByRole("checkbox", { name: "正确性", exact: true }),
		).toBeChecked();
		await page.screenshot({
			path: info.outputPath("task-feedback.png"),
			fullPage: true,
		});
	} catch (error) {
		if (!page.isClosed())
			await info.attach("synthetic-page", {
				body: await page.locator("body").innerText(),
				contentType: "text/plain",
			});
		await info.attach("api-statuses", {
			body: JSON.stringify(statuses),
			contentType: "application/json",
		});
		throw error;
	} finally {
		try {
			if (!page.isClosed()) await page.goto("about:blank");
		} finally {
			try {
				await page.unrouteAll({ behavior: "ignoreErrors" });
			} finally {
				await fixture.close();
			}
		}
	}
});
