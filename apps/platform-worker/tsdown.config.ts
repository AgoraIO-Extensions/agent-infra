import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "./src/index.ts",
		deployment: "./src/deployment-entry.ts",
		workspaceSnapshotInit: "./src/workspace-snapshot-init.ts",
		workspaceSnapshot: "./src/workspace-snapshot-resolver.ts",
		skillHubInit: "./src/skill-hub-init.ts",
		kubernetesClient: "./src/kubernetes-client.ts",
		runtimeDemandImages: "./src/runtime-demand-images-readonly.ts",
	},
	format: "esm",
	outDir: "./dist",
	clean: true,
});
