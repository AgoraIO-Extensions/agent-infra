import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"./src/index.ts",
		"./src/http.ts",
		"./src/worker.ts",
		"./src/operations.ts",
	],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
