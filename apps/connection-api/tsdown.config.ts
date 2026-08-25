import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"./src/bootstrap-admin.ts",
		"./src/bootstrap-production.ts",
		"./src/index.ts",
	],
	deps: {
		alwaysBundle: [
			"@agent-infra/connection-core",
			"@agent-infra/connection-identity",
			"@agent-infra/connection-store",
			"@agent-infra/connection-store/migrations",
			"@agent-infra/openconnector-adapter",
			"@agent-infra/openconnector-kernel",
			"ldapts",
		],
	},
	format: "esm",
	outDir: "./dist",
	clean: true,
});
