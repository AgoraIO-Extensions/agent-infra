import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("platform-store package surface", () => {
	it("keeps migration configuration out of CLI failures", () => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("../dist/migrate-cli.mjs", import.meta.url))],
			{
				encoding: "utf8",
				env: {
					...process.env,
					PLATFORM_DATABASE_URL: "https://user:secret@example.com/platform",
				},
			},
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Platform migration failed\n");
	});

	it("publishes only the Store interface and packaged migrations", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/index.d.mts",
				import: "./dist/index.mjs",
			},
		});
		expect(manifest.files).toEqual(["dist"]);

		const surface = await import(
			new URL("../dist/index.mjs", import.meta.url).href
		);
		expect(Object.keys(surface).toSorted()).toEqual([
			"OutboxStoreError",
			"createPostgresOutboxStore",
			"migratePlatformDatabase",
			"platformDatabaseUrlFromEnvironment",
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
				"dist/migrations/0000_platform_infrastructure.sql",
				"dist/migrations/meta/0000_snapshot.json",
				"dist/migrations/meta/_journal.json",
			]),
		);
		expect(
			packedFiles.some((path: string) =>
				/schema|postgres|drizzle|test/.test(path),
			),
		).toBe(false);
	});
});
