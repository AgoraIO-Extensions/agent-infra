import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_TEST_PORT ?? 43189);
// 登录与退出用例需要配置了同源登录入口的生产构建（NI-113）；单独构建、单独端口，
// 其他用例仍使用未配置入口的默认构建。
const authPort = Number(process.env.WEB_AUTH_TEST_PORT ?? port + 1000);
const authSpecs = /(?:^|[/\\])(?:auth|collection-session)\.spec\.ts$/;
const integrationSpecs =
	/(?:^|[/\\])(?:evaluation-data|evaluation-workflow|task-feedback)\.spec\.ts$/;
const desktop = { viewport: { width: 1440, height: 1000 } };
const mobile = {
	viewport: { width: 390, height: 844 },
	isMobile: true,
	hasTouch: true,
};

export default defineConfig({
	testDir: "./tests",
	fullyParallel: true,
	// CI 使用 4 vCPU 的 ubuntu-24.04 标准 runner；浏览器用例以等待 UI/网络为主，
	// 4 workers 可缩短墙钟时间，串行项目仍单独覆盖 workers。
	workers: 4,
	forbidOnly: !!process.env.CI,
	reporter: [["list"], ["html", { open: "never" }]],
	metadata: {
		head: execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
		worktree: execFileSync("git", ["status", "--porcelain"], {
			encoding: "utf8",
		}).trim()
			? "dirty"
			: "clean",
	},
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		browserName: "chromium",
		// Request assertions use synthetic fixtures; do not persist request bodies.
		trace: "off",
	},
	projects: [
		{
			name: "desktop",
			testIgnore: [authSpecs, integrationSpecs],
			use: desktop,
		},
		{ name: "mobile", testIgnore: [authSpecs, integrationSpecs], use: mobile },
		{
			name: "auth-desktop",
			testMatch: authSpecs,
			use: { ...desktop, baseURL: `http://127.0.0.1:${authPort}` },
		},
		{
			name: "auth-mobile",
			testMatch: authSpecs,
			use: { ...mobile, baseURL: `http://127.0.0.1:${authPort}` },
		},
		// Docker fixture start/stop changes Linux interfaces; keep it away from other Chromium requests.
		{
			name: "integration-desktop",
			testMatch: integrationSpecs,
			dependencies: ["desktop", "mobile", "auth-desktop", "auth-mobile"],
			workers: 1,
			use: desktop,
		},
		{
			name: "integration-mobile",
			testMatch: integrationSpecs,
			dependencies: ["integration-desktop"],
			workers: 1,
			use: mobile,
		},
	],
	webServer: [
		{
			command: `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
			url: `http://127.0.0.1:${port}`,
			reuseExistingServer: false,
		},
		{
			command: `pnpm exec vite build --outDir dist/auth-browser --emptyOutDir && pnpm exec vite preview --outDir dist/auth-browser --host 127.0.0.1 --port ${authPort} --strictPort`,
			url: `http://127.0.0.1:${authPort}`,
			reuseExistingServer: false,
			timeout: 240_000,
			env: {
				VITE_PLATFORM_LOGIN_URL: "/auth/login",
				VITE_PLATFORM_LOGOUT_URL: "/auth/logout",
				VITE_PLATFORM_DEVELOPMENT_MODE: "",
			},
		},
	],
});
