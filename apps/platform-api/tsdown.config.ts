import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		deployment: "../../deploy/platform-api/deployment.mjs",
	},
	deps: { neverBundle: ["@agent-infra/platform-api"] },
	format: "esm",
	outDir: "./dist",
	clean: true,
});
