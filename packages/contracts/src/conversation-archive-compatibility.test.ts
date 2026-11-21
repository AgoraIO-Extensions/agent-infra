import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readEvaluationBaseline } from "./test/evaluation-baseline.js";

it("admits only the pinned negotiated archive addition and preserves cursor/authority contracts", async () => {
	const repo = resolve(import.meta.dirname, "../../..");
	const after = JSON.parse(
		await readFile(
			join(
				repo,
				"packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json",
			),
			"utf8",
		),
	);
	const before = await readEvaluationBaseline("v2");
	const dir = await mkdtemp(join(tmpdir(), "conversation-archive-compat-"));
	async function compare(a: unknown, b: unknown) {
		await writeFile(join(dir, "before.json"), JSON.stringify(a));
		await writeFile(join(dir, "after.json"), JSON.stringify(b));
		return spawnSync(
			process.execPath,
			[
				join(repo, "packages/contracts/src/compatibility.mjs"),
				"--previous",
				join(dir, "before.json"),
				"--current",
				join(dir, "after.json"),
			],
			{ encoding: "utf8" },
		).status;
	}
	try {
		expect(await compare(before, after)).toBe(0);
		expect(await compare(after, after)).toBe(0);
		for (const mutate of [
			(v: typeof after) => {
				delete v.components.schemas.ExecutionDetailProjectionV2.oneOf[0]
					.properties.archive;
			},
			(v: typeof after) => {
				v.components.schemas.ConversationSseMessageV2.anyOf[0].properties.executionId.minLength = 0;
			},
			(v: typeof after) => {
				v.paths[
					"/api/v2/conversations/{conversationId}/events"
				].get.parameters = v.paths[
					"/api/v2/conversations/{conversationId}/events"
				].get.parameters.filter(
					(p: { name: string }) => p.name !== "Last-Event-ID",
				);
			},
			(v: typeof after) => {
				v.paths["/api/v2/conversations/{conversationId}"].get.security = [];
			},
		]) {
			const invalid = structuredClone(after);
			mutate(invalid);
			expect(await compare(after, invalid)).toBe(1);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 60000);
