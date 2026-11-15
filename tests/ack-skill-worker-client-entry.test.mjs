import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The Worker entry awaits deployment.mjs, which awaits the mounted configuration.mjs.
// A module mounted under /app that imports the package name self-references dist/index.mjs,
// so the Worker deadlocks on its own top-level await and exits 13 with only an unsettled-await warning.
test("the Skill Worker module imports the Kubernetes client from its own image entry", async () => {
	const guide = await readFile("deploy/ack/SKILL-HUB.md", "utf8");
	const imports = [
		...guide.matchAll(/^import\s+\{([^}]*)\}\s+from\s+"([^"]+)";$/gmu),
	];
	const client = imports.filter(([, names]) =>
		names.includes("createWorkerKubernetesClientV1"),
	);
	assert.equal(client.length, 1);
	assert.equal(client[0][2], "file:///app/dist/kubernetesClient.mjs");
	assert.equal(
		imports.some(([, , source]) => source === "@agent-infra/platform-worker"),
		false,
	);

	const build = await readFile("apps/platform-worker/tsdown.config.ts", "utf8");
	assert.match(
		build,
		/^\s*kubernetesClient: "\.\/src\/kubernetes-client\.ts",$/mu,
	);
	const clientSource = await readFile(
		"apps/platform-worker/src/kubernetes-client.ts",
		"utf8",
	);
	assert.match(
		clientSource,
		/^export function createWorkerKubernetesClientV1\(/mu,
	);
});
