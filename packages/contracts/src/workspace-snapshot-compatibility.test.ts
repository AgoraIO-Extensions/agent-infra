import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("admits only the approved V2 snapshot addition and preserves its published authority", async () => {
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
	for (const path of [
		"/api/v2/me/workspace-snapshots",
		"/api/v2/workspace-snapshots",
		"/api/v2/workspace-snapshots/{snapshotId}",
	])
		delete previous.paths[path];
	for (const name of [
		"WorkspaceSnapshotBindingV1",
		"WorkspaceSnapshotSourceV1",
		"WorkspaceSnapshotMetadataV1",
		"WorkspaceSnapshotUploadRequestV1",
	])
		delete previous.components.schemas[name];
	for (const name of [
		"AgentApplicationCreateRequestV2",
		"AgentApplicationUpdateRequestV2",
		"AgentApplicationProjectionV2",
		"AgentProjectionV2",
		"AgentDetailProjectionV1",
	])
		for (const option of previous.components.schemas[name].properties.source
			.anyOf)
			delete option.properties.workspaceSnapshots;
	for (const option of previous.components.schemas.AgentApiCreationRequestV1
		.anyOf[0].properties.source.anyOf)
		delete option.properties.workspaceSnapshots;
	const directory = await mkdtemp(join(tmpdir(), "snapshot-compatibility-"));
	const before = join(directory, "before.json");
	const after = join(directory, "after.json");
	async function compare(base: unknown, next: unknown) {
		await writeFile(before, JSON.stringify(base));
		await writeFile(after, JSON.stringify(next));
		return spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("./compatibility.mjs", import.meta.url)),
				"--previous",
				before,
				"--current",
				after,
			],
			{ encoding: "utf8", timeout: 20_000 },
		);
	}
	try {
		const added = await compare(previous, current);
		expect(added.status, added.stderr).toBe(0);
		expect((await compare(current, current)).status).toBe(0);
		expect((await compare(current, previous)).status).toBe(1);
		for (const mutate of [
			(doc: typeof current) => {
				doc.paths["/api/v2/workspace-snapshots"].post.security = [];
			},
			(doc: typeof current) => {
				doc.components.schemas.WorkspaceSnapshotMetadataV1.properties.content =
					{ type: "string" };
			},
			(doc: typeof current) => {
				doc.components.schemas.WorkspaceSnapshotBindingV1.properties.name.maxLength = 128;
			},
			(doc: typeof current) => {
				doc.components.schemas.AgentProjectionV2.properties.source.anyOf[1].properties.workspaceSnapshots.maxItems = 5;
			},
			(doc: typeof current) => {
				doc.components.schemas.AgentProjectionV2.properties.source.anyOf[1].required.push(
					"workspaceSnapshots",
				);
			},
			(doc: typeof current) => {
				doc.components.schemas.AgentProjectionV2.properties.source.anyOf[0].properties.workspaceSnapshots =
					doc.components.schemas.AgentProjectionV2.properties.source.anyOf[1].properties.workspaceSnapshots;
			},
			(doc: typeof current) => {
				delete doc.components.schemas.AgentProjectionV2.properties.source
					.anyOf[1].properties.workspaceSnapshots;
			},
			(doc: typeof current) => {
				delete doc.paths["/api/v2/workspace-snapshots/{snapshotId}"].delete;
			},
			(doc: typeof current) => {
				doc.paths["/api/v2/agents"].get.security = [];
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			expect((await compare(previous, changed)).status).toBe(1);
			expect((await compare(current, changed)).status).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
