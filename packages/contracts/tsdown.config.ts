import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/runtime/index.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
