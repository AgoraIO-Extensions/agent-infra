import { fileURLToPath } from "node:url";
import { bundleInventory } from "@agent-infra/config/bundle-inventory.ts";
import { defineConfig } from "tsdown";

export default defineConfig({
	plugins: [
		bundleInventory(
			"connection-api",
			fileURLToPath(new URL("../../", import.meta.url)),
		),
	],
	entry: [
		"./src/bootstrap-admin.ts",
		"./src/bootstrap-production.ts",
		"./src/index.ts",
		"./src/provider-egress-control.ts",
	],
	deps: {
		alwaysBundle: [
			"@agent-infra/provider-egress-contracts",
			"@agent-infra/connection-core",
			"@agent-infra/connection-identity",
			"@agent-infra/connection-store",
			"@agent-infra/connection-store/migrations",
			"@agent-infra/openconnector-adapter",
			"@agent-infra/openconnector-adapter/provider-fetch",
			"@agent-infra/openconnector-kernel",
			"ldapts",
		],
	},
	format: "esm",
	outDir: "./dist",
	clean: true,
});
