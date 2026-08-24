import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/migrations.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
});
