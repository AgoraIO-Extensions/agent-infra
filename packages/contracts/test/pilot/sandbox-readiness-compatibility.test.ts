import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(
	new URL("../../src/compatibility.mjs", import.meta.url),
);
it.each([1, 2])(
	"admits only the optional server readiness boolean in browser V%s",
	async (version) => {
		const current = JSON.parse(
			await readFile(
				new URL(
					`../../artifacts/openapi/pilot-browser.v${version}.openapi.json`,
					import.meta.url,
				),
				"utf8",
			),
		);
		const projection = (document: typeof current) =>
			version === 1
				? document.components.schemas.ConversationProjectionV1
				: document.components.schemas.ConversationDetailProjectionV2.properties
						.conversation;
		const previous = structuredClone(current);
		delete projection(previous).properties.sandboxReady;
		if (version === 2)
			delete previous.paths["/api/v2/me/conversations/recent"].get.responses[
				"200"
			].content["application/json"].schema.properties.items.items.properties
				.sandboxReady;
		const directory = await mkdtemp(
			join(tmpdir(), "sandbox-readiness-compatibility-"),
		);
		const beforePath = join(directory, "previous.json");
		const afterPath = join(directory, "current.json");
		const compare = async (value: typeof current) => {
			await writeFile(afterPath, JSON.stringify(value));
			return spawnSync(
				process.execPath,
				[cli, "--previous", beforePath, "--current", afterPath],
				{ encoding: "utf8" },
			);
		};
		try {
			await writeFile(beforePath, JSON.stringify(previous));
			expect((await compare(current)).status).toBe(0);
			for (const mutate of [
				(d: typeof current) => {
					projection(d).properties.sandboxReady = { type: "string" };
				},
				(d: typeof current) => {
					projection(d).required.push("sandboxReady");
				},
				(d: typeof current) => {
					projection(d).properties.sandboxId = { type: "string" };
				},
				(d: typeof current) => {
					projection(d).properties.status = { type: "string" };
				},
				(d: typeof current) => {
					delete d.paths[Object.keys(d.paths)[0]];
				},
				(d: typeof current) => {
					d.components.securitySchemes = {};
				},
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				expect((await compare(changed)).status).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
