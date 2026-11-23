import { expect, test } from "@playwright/test";

test("管理员登记、验证并启用实例，刷新后看见生效版本", async ({ page }) => {
	let revision = 0;
	let verified: number | null = null;
	let active: number | null = null;
	const url = "https://relay.example.test";
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/api/v1/session")
			return route.fulfill({
				json: {
					schemaVersion: 1,
					user: {
						userId: "admin",
						displayName: "管理员",
						roles: ["employee", "system_admin"],
					},
				},
			});
		if (path === "/api/v2/admin/external-services/commands") {
			const { action } = request.postDataJSON();
			if (action === "test") {
				verified = revision;
				return route.fulfill({
					json: {
						revision,
						manifest: {
							schemaVersion: 1,
							instanceId: "relay",
							capabilities: ["model-authorization"],
						},
					},
				});
			}
			active = revision;
			return route.fulfill({ json: { revision } });
		}
		if (path === "/api/v2/admin/external-services") {
			if (request.method() === "POST") {
				expect(request.postDataJSON()).toMatchObject({
					id: "relay",
					url,
					modelEndpointId: "models",
					expectedRevision: 0,
				});
				revision++;
				return route.fulfill({ json: { revision } });
			}
			return route.fulfill({
				json: {
					services: revision
						? [
								{
									id: "relay",
									url,
									modelEndpointId: "models",
									revision,
									verified,
									active,
									activeUrl: active ? url : null,
								},
							]
						: [],
					history: [],
				},
			});
		}
		return route.fulfill({ status: 404 });
	});
	await page.goto("/admin/external-services");
	await page.getByLabel(/关联的模型端点 ID/).fill("models");
	await page.getByLabel("服务地址", { exact: true }).fill(url);
	await page.getByLabel("该地址的服务凭据").fill("browser-fixture-credential");
	await page.getByRole("button", { name: "保存候选配置" }).click();
	await expect(page.getByLabel("该地址的服务凭据")).toHaveValue("");
	await page.getByRole("button", { name: "测试连接" }).click();
	await expect(
		page.getByText("连接成功 · 协议 v1 · model-authorization", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "启用候选版本" }).click();
	await expect(page.getByText("生效 v1", { exact: false })).toBeVisible();
	await page.reload();
	await expect(page.getByText("生效 v1", { exact: false })).toBeVisible();
});
