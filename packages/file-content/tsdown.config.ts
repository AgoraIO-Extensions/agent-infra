import { defineConfig } from "tsdown";
export default defineConfig({
	entry: ["./src/index.ts", "./src/text.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
