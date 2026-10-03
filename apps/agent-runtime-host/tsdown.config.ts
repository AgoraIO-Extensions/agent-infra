import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/legacy-migration-cli.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
});
