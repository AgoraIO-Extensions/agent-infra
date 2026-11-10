import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"./src/index.ts",
		"./src/legacy-migration-cli.ts",
		"./src/runtime-oauth-provisioning-cli.ts",
		"./src/session-executor-runner.ts",
	],
	format: "esm",
	outDir: "./dist",
	clean: true,
});
