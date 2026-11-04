import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		deployment: "./src/deployment-entry.ts",
		workspaceSnapshot: "./src/workspace-snapshot-resolver.ts",
	},
	format: "esm",
	outDir: "./dist",
	clean: true,
});
