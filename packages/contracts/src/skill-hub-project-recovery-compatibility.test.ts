import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const route =
	"/api/v2/skills/projects/{projectId}/publications/{operationId}/recover";
const cli = fileURLToPath(new URL("./compatibility.mjs", import.meta.url));
it("admits only the reviewed original-operation recovery and preserves the rest of the contract", {
	timeout: 30_000,
}, async () => {
	const current = JSON.parse(
		await readFile(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const previous = structuredClone(current);
	delete previous.paths[route];
	const dir = await mkdtemp(join(tmpdir(), "skill-recovery-compat-"));
	const compare = async (before: typeof current, after: typeof current) => {
		const a = join(dir, "before.json");
		const b = join(dir, "after.json");
		await writeFile(a, JSON.stringify(before));
		await writeFile(b, JSON.stringify(after));
		return spawnSync(process.execPath, [cli, "--previous", a, "--current", b], {
			encoding: "utf8",
		}).status;
	};
	try {
		expect(await compare(previous, current)).toBe(0);
		expect(await compare(current, current)).toBe(0);
		expect(await compare(current, previous)).toBe(1);
		for (const mutate of [
			(v: typeof current) => {
				v.paths[route].post.security = [];
			},
			(v: typeof current) => {
				v.paths[route].post.security = [{ PersonalApiBearer: [] }];
			},
			(v: typeof current) => {
				v.paths[route].post.operationId = "unreviewedRecovery";
			},
			(v: typeof current) => {
				v.paths[route].post.parameters[1].required = false;
			},
			(v: typeof current) => {
				v.paths[route].post.requestBody = {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: {
									ownerId: { type: "string" },
									idempotencyKey: { type: "string" },
								},
							},
						},
					},
				};
			},
			(v: typeof current) => {
				delete v.paths[route].post.responses["403"];
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			expect(await compare(previous, changed)).toBe(1);
			expect(await compare(changed, changed)).toBe(1);
		}
		const unrelated = structuredClone(current);
		unrelated.paths["/api/v2/unreviewed"] = {
			get: { operationId: "unreviewed" },
		};
		expect(await compare(previous, unrelated)).toBe(1);
		const oldPublish = structuredClone(current);
		oldPublish.paths[
			"/api/v2/skills/projects/{projectId}/versions"
		].post.security = [];
		expect(await compare(previous, oldPublish)).toBe(1);
		const response = structuredClone(current);
		response.components.schemas.SkillHubPublicationResponseV1.properties.ownerId =
			{ type: "string" };
		expect(await compare(previous, response)).toBe(1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
