import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const port = Number(process.env.WEB_TEST_PORT ?? 43189);

export default defineConfig({
	testDir: "./tests",
	fullyParallel: true,
	workers: 2,
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
		{ name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
		{
			name: "mobile",
			use: {
				viewport: { width: 390, height: 844 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],
	webServer: {
		command: `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
	},
});
