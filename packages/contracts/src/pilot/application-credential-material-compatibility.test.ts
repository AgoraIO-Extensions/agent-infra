import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps material endpoint authentication and published operations under compatibility checks", async () => {
	const document = JSON.parse(
		await readFile(
			new URL(
				"../../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const dir = await mkdtemp(join(tmpdir(), "material-compat-"));
	const target =
		"/api/v2/applications/{applicationId}/credential-material-deliveries/{attemptId}/receive";
	try {
		const before = join(dir, "before.json");
		const after = join(dir, "after.json");
		await writeFile(before, JSON.stringify(document));
		for (const mutate of [
			(d: typeof document) => {
				d.paths[target].post.security = [];
			},
			(d: typeof document) => {
				delete d.paths[target];
			},
			(d: typeof document) => {
				d.paths["/api/v2/applications"].post.security = [];
			},
		]) {
			const changed = structuredClone(document);
			mutate(changed);
			await writeFile(after, JSON.stringify(changed));
			const result = spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL("../compatibility.mjs", import.meta.url)),
					"--previous",
					before,
					"--current",
					after,
				],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
