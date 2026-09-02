import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("contracts package surface", () => {
	it("publishes standard artifacts without publishing test-only clients", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

		expect(manifest.types).toBe("dist/index.d.mts");
		expect(manifest.exports["."].types).toBe("./dist/index.d.mts");
		expect(manifest.exports["./pilot"]).toEqual({
			types: "./dist/pilot/index.d.mts",
			import: "./dist/pilot/index.mjs",
		});
		expect(manifest.exports["./workload"]).toEqual({
			types: "./dist/workload/index.d.mts",
			import: "./dist/workload/index.mjs",
		});
		expect(manifest.exports["./runtime"]).toEqual({
			types: "./dist/runtime/index.d.mts",
			import: "./dist/runtime/index.mjs",
		});
		expect(manifest.exports["./openapi/common.v1"]).toBe(
			"./artifacts/openapi/common.v1.openapi.json",
		);
		expect(manifest.exports["./json-schema/common.v1"]).toBe(
			"./artifacts/json-schema/common.v1.schema.json",
		);
		expect(manifest.exports["./json-schema/kubernetes-workload.v1"]).toBe(
			"./artifacts/json-schema/kubernetes-workload.v1.schema.json",
		);
		expect(manifest.exports["./json-schema/pilot-delegated.v1"]).toBe(
			"./artifacts/json-schema/pilot-delegated.v1.schema.json",
		);
		expect(manifest.exports["./json-schema/pilot-sse.v1"]).toBe(
			"./artifacts/json-schema/pilot-sse.v1.schema.json",
		);
		expect(manifest.exports["./json-schema/registry-manifest.v1"]).toBe(
			"./artifacts/json-schema/registry-manifest.v1.schema.json",
		);
		expect(manifest.exports["./json-schema/secret-lifecycle.v1"]).toBe(
			"./artifacts/json-schema/secret-lifecycle.v1.schema.json",
		);
		expect(manifest.exports["./json-schema/worker-result.v1"]).toBe(
			"./artifacts/json-schema/worker-result.v1.schema.json",
		);
		expect(manifest.exports["./openapi/pilot-browser.v1"]).toBe(
			"./artifacts/openapi/pilot-browser.v1.openapi.json",
		);
		expect(manifest.exports["./openapi/pilot-browser.v2"]).toBe(
			"./artifacts/openapi/pilot-browser.v2.openapi.json",
		);
		expect(manifest.exports["./openapi/pilot-delegated.v1"]).toBe(
			"./artifacts/openapi/pilot-delegated.v1.openapi.json",
		);
		expect(manifest.exports["./json-schema/runtime.v1"]).toBe(
			"./artifacts/json-schema/runtime.v1.schema.json",
		);
		expect(manifest.exports["./openapi/runtime-host.v1"]).toBe(
			"./artifacts/openapi/runtime-host.v1.openapi.json",
		);
		expect(manifest.files).toEqual(["dist", "artifacts"]);
		expect(JSON.stringify(manifest.exports)).not.toContain("test");

		const pack = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: packageRoot,
				encoding: "utf8",
			}),
		)[0];
		const packedFiles = pack.files.map((file: { path: string }) => file.path);
		expect(packedFiles).toContain("dist/index.d.mts");
		expect(packedFiles).toContain("dist/pilot/index.d.mts");
		expect(packedFiles).toContain("dist/workload/index.d.mts");
		expect(packedFiles).toContain("dist/runtime/index.d.mts");
		expect(packedFiles).toContain("artifacts/openapi/common.v1.openapi.json");
		expect(packedFiles).toContain(
			"artifacts/json-schema/kubernetes-workload.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/json-schema/pilot-delegated.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/json-schema/pilot-sse.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/json-schema/registry-manifest.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/json-schema/secret-lifecycle.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/json-schema/worker-result.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/openapi/pilot-browser.v1.openapi.json",
		);
		expect(packedFiles).toContain(
			"artifacts/openapi/pilot-browser.v2.openapi.json",
		);
		expect(packedFiles).toContain(
			"artifacts/openapi/pilot-delegated.v1.openapi.json",
		);
		expect(packedFiles).toContain(
			"artifacts/json-schema/runtime.v1.schema.json",
		);
		expect(packedFiles).toContain(
			"artifacts/openapi/runtime-host.v1.openapi.json",
		);
		expect(packedFiles.some((path: string) => path.includes("test"))).toBe(
			false,
		);
	});
});
