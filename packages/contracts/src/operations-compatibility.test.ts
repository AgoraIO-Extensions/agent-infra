import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("admits only the bounded administrator operations addition and preserves existing authority", {
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
	const paths = ["/api/v2/ops/history", "/api/v2/ops/resources"] as const;
	const previous = structuredClone(current);
	for (const path of paths) delete previous.paths[path];
	for (const name of ["OperationsHistoryV2", "OperationsResourcesV2"])
		delete previous.components.schemas[name];
	const directory = await mkdtemp(join(tmpdir(), "ops-compat-"));
	const compare = async (before: typeof current, after: typeof current) => {
		const a = join(directory, "before.json");
		const b = join(directory, "after.json");
		await writeFile(a, JSON.stringify(before));
		await writeFile(b, JSON.stringify(after));
		return spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("./compatibility.mjs", import.meta.url)),
				"--previous",
				a,
				"--current",
				b,
			],
			{ encoding: "utf8" },
		).status;
	};
	const beforeSessionCoverage = structuredClone(current);
	beforeSessionCoverage.paths[paths[1]].get.parameters =
		beforeSessionCoverage.paths[paths[1]].get.parameters.filter(
			(parameter: { in: string }) => parameter.in !== "header",
		);
	delete beforeSessionCoverage.components.schemas.OperationsResourcesV2
		.properties.budget.anyOf[0].properties.sessionRequestCoverage;
	const historical = structuredClone(beforeSessionCoverage);
	const operations = historical.components.schemas.OperationsResourcesV2;
	delete operations.properties.resources.items.properties.placement;
	delete operations.properties.resources.items.properties.ownershipReason;
	delete operations.properties.quotas.items.properties.source;
	delete operations.properties.quotaSource;
	try {
		expect(await compare(historical, current)).toBe(0);
		expect(await compare(beforeSessionCoverage, current)).toBe(0);
		expect(await compare(current, beforeSessionCoverage)).toBe(1);
		expect(await compare(previous, current)).toBe(0);
		expect(await compare(current, current)).toBe(0);
		expect(await compare(current, previous)).toBe(1);
		for (const mutate of [
			(value: typeof current) => {
				value.paths[paths[0]].get.security = [];
			},
			(value: typeof current) => {
				value.paths[paths[1]].post = value.paths[paths[1]].get;
			},
			(value: typeof current) => {
				value.components.schemas.OperationsResourcesV2.properties.resources.maxItems = 1000000;
			},
			(value: typeof current) => {
				delete value.paths[paths[0]].get.responses["403"];
			},
			(value: typeof current) => {
				value.paths["/api/v2/unreviewed"] = {
					get: { operationId: "unreviewed" },
				};
			},
			(value: typeof current) => {
				value.paths["/api/v2/agents"].get.security = [];
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			expect(await compare(previous, changed)).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
