import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("permits only the V3 addition and still rejects changes to authority, old variants and responses", async () => {
	const artifact = JSON.parse(
		await readFile(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const route =
		"/api/v2/conversations/{conversationId}/native-capability/invoke";
	const previous = structuredClone(artifact);
	delete previous.components.schemas.NativeCapabilityInvocationRequestV3;
	previous.paths[route].post.requestBody.content[
		"application/json"
	].schema.anyOf.pop();
	const directory = await mkdtemp(join(tmpdir(), "native-v3-compat-"));
	const before = join(directory, "previous.json");
	const after = join(directory, "current.json");
	const compare = async (current: unknown) => {
		await writeFile(after, JSON.stringify(current));
		return spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("./compatibility.mjs", import.meta.url)),
				"--previous",
				before,
				"--current",
				after,
			],
			{ encoding: "utf8" },
		).status;
	};
	try {
		await writeFile(before, JSON.stringify(previous));
		expect(await compare(artifact)).toBe(0);
		for (const mutation of [
			(doc: typeof artifact) => {
				doc.components.schemas.NativeCapabilityInvocationRequestV3.additionalProperties = true;
			},
			(doc: typeof artifact) => {
				doc.components.schemas.NativeCapabilityInvocationRequestV3.properties.selection.additionalProperties = true;
			},
			(doc: typeof artifact) => {
				doc.components.schemas.NativeCapabilityInvocationRequestV3.required.pop();
			},
			(doc: typeof artifact) => {
				doc.components.schemas.NativeCapabilityInvocationRequestV1.properties.parameters.maxLength = 1;
			},
			(doc: typeof artifact) => {
				doc.components.schemas.NativeCapabilityInvocationRequestV2.properties.attachments.maxItems = 1;
			},
			(doc: typeof artifact) => {
				doc.paths[route].post.security = [];
			},
			(doc: typeof artifact) => {
				delete doc.paths[route].post.responses["403"];
			},
		]) {
			const current = structuredClone(artifact);
			mutation(current);
			expect(await compare(current)).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
