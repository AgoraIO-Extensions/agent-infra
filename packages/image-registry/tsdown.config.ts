import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/deployment.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
