import { defineConfig } from "tsdown";
export default defineConfig({
	entry: ["./src/index.ts", "./src/worker.ts", "./src/testing.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
