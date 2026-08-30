import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("platform-core package surface", () => {
	it("separates the production Interface from deterministic test controls", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/index.d.mts",
				import: "./dist/index.mjs",
			},
			"./testing": {
				types: "./dist/testing.d.mts",
				import: "./dist/testing.mjs",
			},
		});
		expect(manifest.files).toEqual(["dist"]);

		const surface = await import(
			new URL("../dist/index.mjs", import.meta.url).href
		);
		expect(Object.keys(surface).toSorted()).toEqual([
			"ApplicationFoundationError",
			"assertApplicationFoundationCommandV1",
		]);
		const testingSurface = await import(
			new URL("../dist/testing.mjs", import.meta.url).href
		);
		expect(Object.keys(testingSurface)).toEqual([
			"FakeApplicationFoundationTransactionV1",
		]);

		const pack = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: packageRoot,
				encoding: "utf8",
			}),
		)[0];
		const packedFiles = pack.files.map((file: { path: string }) => file.path);
		expect(packedFiles).toEqual(
			expect.arrayContaining([
				"dist/index.d.mts",
				"dist/index.mjs",
				"dist/testing.d.mts",
				"dist/testing.mjs",
			]),
		);
		expect(
			packedFiles.some((path: string) =>
				/conformance|schema|postgres|drizzle|\.test\./.test(path),
			),
		).toBe(false);
	});
});
