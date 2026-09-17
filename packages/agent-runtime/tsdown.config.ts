import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/pi-policy.ts"],
	format: "esm",
	outDir: "./dist",
	clean: true,
	dts: {
		compilerOptions: { stripInternal: true },
	},
});
