import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseDocument } from "yaml";
import { createClaudeDeploymentPlugin } from "./claude-deployment-skills.js";

it("keeps the native plugin read-only and accepts descriptions and paths as data", async () => {
	const tmp = await mkdtemp(join(tmpdir(), "claude-skill-catalog-"));
	try {
		const plugin = await createClaudeDeploymentPlugin(tmp);
		const entry = {
			name: "weekly-report",
			description: '每周 "R&D" \n摘要',
			path: "/published/研发 周报/SKILL.md",
		};
		await plugin.register([entry]);
		const relativeFile = "skills/weekly-report/SKILL.md";
		const paths = (await readdir(plugin.path, { recursive: true })).sort();
		expect(paths).toEqual([
			".claude-plugin",
			".claude-plugin/plugin.json",
			"skills",
			"skills/weekly-report",
			relativeFile,
		]);
		for (const path of ["", ...paths]) {
			expect((await stat(join(plugin.path, path))).mode & 0o222).toBe(0);
		}
		const [, metadata, navigation] = (
			await readFile(join(plugin.path, relativeFile), "utf8")
		).split("---\n");
		expect(parseDocument(metadata ?? "").toJS()).toEqual({
			name: entry.name,
			description: entry.description,
			"user-invocable": false,
		});
		expect(JSON.parse(navigation?.trim().split("\n").at(-1) ?? "null")).toEqual(
			{ file_path: entry.path },
		);
		await plugin.close();
		expect(await readdir(tmp)).toEqual([]);
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
});
