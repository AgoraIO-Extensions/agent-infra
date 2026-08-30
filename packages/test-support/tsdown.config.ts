import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/pilot/index.ts", "./src/workload/index.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
