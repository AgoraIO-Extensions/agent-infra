import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/migrate-cli.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: true,
});
