import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { serve: "./src/serve.ts" },
	format: "esm",
	outDir: "./dist",
	clean: true,
});
