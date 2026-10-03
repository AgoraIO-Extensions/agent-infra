import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		deployment: "./src/deployment-entry.ts",
	},
	format: "esm",
	outDir: "./dist",
	clean: true,
});
