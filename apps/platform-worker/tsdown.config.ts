import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		deployment: "../../deploy/platform-worker/deployment.mjs",
	},
	deps: { neverBundle: ["@agent-infra/platform-worker"] },
	format: "esm",
	outDir: "./dist",
	clean: true,
});
