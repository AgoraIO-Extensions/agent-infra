import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("admits only optional true recovery metadata without changing old authentication or response fields", async () => {
	const after = JSON.parse(
		await readFile(
			new URL(
				"../../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const path = "/api/v2/agents/{agentId}/connection-association";
	const schema = (doc: typeof after, method = "get") =>
		doc.paths[path][method].responses["200"].content["application/json"].schema;
	const before = structuredClone(after);
	for (const method of ["get", "put", "delete"])
		delete schema(before, method).properties.credentialRecoveryAvailable;
	const dir = await mkdtemp(join(tmpdir(), "connection-recovery-compat-"));
	try {
		async function compare(current: typeof after) {
			await writeFile(join(dir, "before.json"), JSON.stringify(before));
			await writeFile(join(dir, "after.json"), JSON.stringify(current));
			return spawnSync(
				process.execPath,
				[
					new URL("../compatibility.mjs", import.meta.url).pathname,
					"--previous",
					join(dir, "before.json"),
					"--current",
					join(dir, "after.json"),
				],
				{ encoding: "utf8" },
			).status;
		}
		expect(await compare(after)).toBe(0);
		for (const mutate of [
			(doc: typeof after) => {
				doc.paths[path].put.security = [];
			},
			(doc: typeof after) => {
				schema(doc).required.push("credentialRecoveryAvailable");
			},
			(doc: typeof after) => {
				schema(doc).properties.credentialRecoveryAvailable = {
					type: "boolean",
				};
			},
			(doc: typeof after) => {
				delete schema(doc).properties.status;
			},
		]) {
			const changed = structuredClone(after);
			mutate(changed);
			expect(await compare(changed)).not.toBe(0);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 30000);
