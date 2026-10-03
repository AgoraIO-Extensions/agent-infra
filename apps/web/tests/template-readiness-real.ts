// Invoked by the production API/PostgreSQL test. Only Registry/identity/model evidence are fixtures.
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

const apiOrigin = process.env.TEMPLATE_TEST_API_ORIGIN;
const token = process.env.TEMPLATE_TEST_SESSION;
const mode = process.env.TEMPLATE_TEST_MODE;
if (
	!apiOrigin ||
	!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiOrigin) ||
	!token ||
	!["disabled", "ready", "retry"].includes(mode ?? "")
)
	throw new Error("Controlled local API inputs required");
const web = await preview({
	root: fileURLToPath(new URL("..", import.meta.url)),
	preview: { host: "127.0.0.1", port: 0 },
});
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
	});
	let submissions = 0;
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/v2/agent-applications"
		)
			submissions++;
		// Forward to the real running HTTP API; never fabricate a response or mutate its body.
		const response = await route.fetch({
			url:
				apiOrigin +
				new URL(request.url()).pathname +
				new URL(request.url()).search,
			headers: { ...request.headers(), authorization: token },
		});
		await route.fulfill({ response });
	});
	await page.goto(
		`http://127.0.0.1:${(web.httpServer.address() as AddressInfo).port}/my-agents/new`,
	);
	const states = page.getByRole("list", { name: "模板就绪状态" });
	await expect(states).toContainText("Codex");
	for (const name of ["Claude Code", "OpenCode", "Pi"])
		await expect(states).toContainText(name);
	await page
		.getByLabel("Agent 名称", { exact: true })
		.fill(`Readiness browser ${mode}`);
	await page
		.getByLabel("用途说明", { exact: true })
		.fill("Controlled API and PostgreSQL browser acceptance");
	await page.getByRole("combobox", { name: "标准模板 ID" }).click();
	const codex = page.getByRole("option", { name: "Codex", exact: true });
	if (mode === "disabled") {
		await expect(codex).toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "提交申请", exact: true }).click();
		expect(submissions).toBe(0);
		await expect(states).toContainText("模板已停用");
	} else {
		await codex.click();
		const choose = async (label: string, name: string) => {
			await page.getByRole("combobox", { name: label, exact: true }).click();
			await page.getByRole("option", { name, exact: true }).click();
		};
		await choose("模型端点", "endpoint-a");
		await choose("模型", "model-a");
		await page.getByRole("checkbox", { name: "medium", exact: true }).check();
		await page
			.getByLabel("模型凭证", { exact: true })
			.fill("synthetic-browser-model-value");
		await choose("默认模型", "endpoint-a · model-a");
		await choose("默认推理档位", "medium");
		if (mode === "retry") {
			const rejected = page.waitForResponse(
				(r) =>
					new URL(r.url()).pathname === "/api/v2/agent-applications" &&
					r.request().method() === "POST",
			);
			await page.getByRole("button", { name: "提交申请", exact: true }).click();
			expect((await rejected).status()).toBeGreaterThanOrEqual(400);
			await expect(
				page.getByText("模板已更新，请确认后再提交。", { exact: true }),
			).toBeVisible();
			await page
				.getByRole("button", { name: "使用当前模板", exact: true })
				.click();
			// The existing form clears write-only credentials after every attempt.
			await expect(page.getByLabel("模型凭证", { exact: true })).toHaveValue(
				"",
			);
			await page
				.getByLabel("模型凭证", { exact: true })
				.fill("synthetic-browser-model-value");
		}
		const response = page.waitForResponse(
			(r) =>
				new URL(r.url()).pathname === "/api/v2/agent-applications" &&
				r.request().method() === "POST",
		);
		await page.getByRole("button", { name: "提交申请", exact: true }).click();
		expect((await response).status()).toBe(201);
		await expect(
			page.getByRole("heading", { name: "申请已提交", exact: true }),
		).toBeVisible();
		expect(submissions).toBe(mode === "retry" ? 2 : 1);
	}
	const evidence = process.env.TEMPLATE_TEST_EVIDENCE_DIR;
	if (evidence) {
		await mkdir(evidence, { recursive: true });
		await page.screenshot({
			path: `${evidence}/${mode}-desktop.png`,
			fullPage: true,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.screenshot({
			path: `${evidence}/${mode}-mobile.png`,
			fullPage: true,
		});
	}
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	console.log(
		`Controlled browser ${mode}: passed; real API/PostgreSQL, simulated model validation.`,
	);
} finally {
	await browser.close();
	await new Promise<void>((resolve, reject) =>
		web.httpServer.close((error) => (error ? reject(error) : resolve())),
	);
}
