import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("test-support package surface", () => {
	it("packs declarations without tests or source fixtures", async () => {
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
		const pilotSurface = await import(
			new URL("../dist/pilot/index.mjs", import.meta.url).href
		);
		expect(pilotSurface.fakeDelegatedActionSuccessV1).toBeTypeOf("function");
		expect(pilotSurface.fakeDelegatedActionFailureV1).toBeTypeOf("function");
		const workloadSurface = await import(
			new URL("../dist/workload/index.mjs", import.meta.url).href
		);
		expect(workloadSurface.createFakeImageRegistryAdapterV1).toBeTypeOf(
			"function",
		);
		expect(workloadSurface.createFakeSecretActivationAdapterV1).toBeTypeOf(
			"function",
		);

		const pack = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: packageRoot,
				encoding: "utf8",
			}),
		)[0];
		const packedFiles = pack.files.map((file: { path: string }) => file.path);
		expect(packedFiles).toContain("dist/index.d.mts");
		expect(packedFiles).toContain("dist/pilot/index.d.mts");
		expect(packedFiles).toContain("dist/pilot/index.mjs");
		expect(packedFiles).toContain("dist/workload/index.d.mts");
		expect(packedFiles).toContain("dist/workload/index.mjs");
		expect(packedFiles.some((path: string) => path.includes("test"))).toBe(
			false,
		);
	});
});
