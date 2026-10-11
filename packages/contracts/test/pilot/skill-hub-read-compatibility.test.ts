import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("admits only the exact Skill metadata read addition and preserves all prior contracts", async () => {
	const current = JSON.parse(
		await readFile(
			new URL(
				"../../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const previous = structuredClone(current);
	for (const path of [
		"/api/v2/skills",
		"/api/v2/skills/versions/{skillVersionId}",
	])
		delete previous.paths[path];
	for (const name of ["SkillHubVersionMetadataV1", "SkillHubDirectoryPageV1"])
		delete previous.components.schemas[name];
	const directory = await mkdtemp(join(tmpdir(), "skill-hub-read-compat-"));
	const before = join(directory, "previous.json");
	const after = join(directory, "current.json");
	const cli = fileURLToPath(
		new URL("../../src/compatibility.mjs", import.meta.url),
	);
	async function compare(document: typeof current) {
		await writeFile(after, JSON.stringify(document));
		return spawnSync(
			process.execPath,
			[cli, "--previous", before, "--current", after],
			{ encoding: "utf8" },
		).status;
	}
	try {
		await writeFile(before, JSON.stringify(previous));
		expect(await compare(current)).toBe(0);
		for (const mutate of [
			(document: typeof current) => {
				document.paths["/api/v2/skills"].get.security = [];
			},
			(document: typeof current) => {
				document.paths["/api/v2/skills"].get.parameters.find(
					(parameter: { name: string }) => parameter.name === "limit",
				).schema.maximum = 1000;
			},
			(document: typeof current) => {
				document.components.schemas.SkillHubVersionMetadataV1.properties.packageObjectVersion =
					{ type: "string" };
			},
			(document: typeof current) => {
				document.components.schemas.SkillHubVersionMetadataV1.properties.state.const =
					"revoked";
			},
			(document: typeof current) => {
				document.paths["/api/v2/admin/audit"].get.security = [];
			},
			(document: typeof current) => {
				document.paths["/api/v2/skills/unreviewed"] = {};
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			expect(await compare(changed)).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
