import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/testing.ts"],
	deps: { neverBundle: true },
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
