import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { ScopedPlatformAuditProjectionV1 } from "@agent-infra/contracts/pilot";
import { chromium, expect } from "@playwright/test";
import { preview } from "vite";

// Called with records from the still-running packaged Worker/native/API harness.
export async function verifyNativeModelAuditBrowser(input: {
	apiOrigin: string;
	userModel: ScopedPlatformAuditProjectionV1;
	applicationModel: ScopedPlatformAuditProjectionV1;
	evidenceDirectory: string;
}) {
	const server = await preview({
		configFile: false,
		root: resolve(import.meta.dirname, ".."),
		preview: { host: "127.0.0.1", port: 0 },
	});
	let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
	const screenshots: string[] = [];
	try {
		browser = await chromium.launch();
		await mkdir(input.evidenceDirectory, { recursive: true });
		const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
		for (const viewport of [
			{ width: 1440, height: 960 },
			{ width: 390, height: 844 },
		]) {
			for (const scope of ["own", "administrator"] as const) {
				const record =
					scope === "own" ? input.userModel : input.applicationModel;
				const fact = record.operation?.fact;
				if (fact?.kind !== "model" || fact.phase !== "completed")
					throw new Error("TASK_NATIVE_MODEL_AUDIT_REQUIRED");
				const context = await browser.newContext({ viewport });
				try {
					const page = await context.newPage();
					await page.route(/\/api\//, async (route) => {
						const url = new URL(route.request().url());
						const response = await route.fetch({
							url: `${input.apiOrigin}${url.pathname}${url.search}`,
							headers: {
								...route.request().headers(),
								cookie:
									scope === "own"
										? "synthetic-owner-session"
										: "synthetic-admin-session",
							},
						});
						await route.fulfill({ response });
					});
					await page.goto(
						`${origin}${scope === "own" ? "/audit" : "/admin/audit"}`,
					);
					await page
						.getByLabel("Execution ID", { exact: true })
						.fill(record.executionId ?? "");
					await page
						.getByLabel("动作", { exact: true })
						.selectOption("execution.operation.observed");
					const listing = page.waitForResponse((response) => {
						const url = new URL(response.url());
						return (
							url.pathname.endsWith("/audit") &&
							url.searchParams.get("executionId") === record.executionId &&
							url.searchParams.get("action") === record.action
						);
					});
					await page.getByRole("button", { name: "查询", exact: true }).click();
					const response = await listing;
					expect(response.status()).toBe(200);
					const items = (await response.json())
						.items as ScopedPlatformAuditProjectionV1[];
					const index = items.findIndex(
						(item) => item.auditId === record.auditId,
					);
					expect(index).toBeGreaterThanOrEqual(0);
					await expect(
						page.getByRole("button", { name: "查看审计详情" }),
					).toHaveCount(items.length);
					await page
						.getByRole("button", { name: "查看审计详情" })
						.nth(index)
						.click();
					const detail = page.getByRole("dialog");
					await expect(detail).toContainText(record.auditId);
					await expect(detail).toContainText(record.executionId ?? "");
					await expect(detail).toContainText(record.operation?.eventId ?? "");
					await expect(detail).toContainText(fact.model.modelId);
					await expect(detail).toContainText(fact.model.modelOptionId);
					await expect(detail).toContainText("操作已完成");
					await expect(detail).toContainText("platform_worker");
					for (const secret of [
						"synthetic native input",
						"synthetic native task answer",
						"synthetic-native-model",
					])
						await expect(page.locator("body")).not.toContainText(secret);
					expect(
						await page.evaluate(
							"document.documentElement.scrollWidth <= window.innerWidth",
						),
					).toBe(true);
					const name = `native-model-audit-${scope}-${viewport.width}.png`;
					await page.screenshot({
						path: join(input.evidenceDirectory, name),
						animations: "disabled",
					});
					screenshots.push(name);
				} finally {
					await context.close();
				}
			}
		}
		return {
			cases: screenshots.length,
			screenshots,
			source: "packaged-worker-native-model-controlled-provider",
		};
	} finally {
		try {
			await browser?.close();
		} finally {
			await new Promise<void>((done, reject) =>
				server.httpServer.close((error) => (error ? reject(error) : done())),
			);
		}
	}
}
