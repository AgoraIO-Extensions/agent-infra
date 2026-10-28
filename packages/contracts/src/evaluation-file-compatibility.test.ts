import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
	"openapi/files.v1.openapi.json",
	"json-schema/files.v1.schema.json",
	"openapi/pilot-browser.v1.openapi.json",
])(
	"admits only the exact optional signed Eval file binding in %s",
	async (name) => {
		const current = JSON.parse(
			await readFile(new URL(`../artifacts/${name}`, import.meta.url), "utf8"),
		);
		const slot = (doc: typeof current) =>
			(
				doc.$defs ?? doc.components.schemas
			).FileAccessClaimsV1.properties.execution.anyOf.find(
				(x: { type: string }) => x.type === "object",
			);
		const previous = structuredClone(current);
		delete slot(previous).properties.evaluation;
		const dir = await mkdtemp(join(tmpdir(), "eval-files-compat-"));
		const before = join(dir, "before.json");
		const after = join(dir, "after.json");
		const compare = async (a: unknown, b: unknown) => {
			await writeFile(before, JSON.stringify(a));
			await writeFile(after, JSON.stringify(b));
			return spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL("./compatibility.mjs", import.meta.url)),
					"--previous",
					before,
					"--current",
					after,
				],
				{ encoding: "utf8", timeout: 20000 },
			).status;
		};
		try {
			expect(await compare(previous, current)).toBe(0);
			expect(await compare(current, current)).toBe(0);
			expect(await compare(current, previous)).toBe(1);
			for (const mutate of [
				(d: typeof current) => delete slot(d).properties.grantId,
				(d: typeof current) => slot(d).required.push("evaluation"),
				(d: typeof current) =>
					(slot(d).properties.evaluation.additionalProperties = true),
				(d: typeof current) =>
					slot(
						d,
					).properties.evaluation.properties.principal.properties.kind.enum.push(
						"admin",
					),
				(d: typeof current) =>
					delete slot(d).properties.evaluation.properties.deliveryFence.maximum,
				(d: typeof current) => slot(d).properties.evaluation.required.pop(),
			]) {
				const changed = structuredClone(current);
				mutate(changed);
				expect(await compare(previous, changed)).toBe(1);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	60000,
);
