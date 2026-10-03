import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/standard-templates.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
