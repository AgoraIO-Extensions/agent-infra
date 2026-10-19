import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	AgentDefaultRelayKeyCandidatesV1Schema,
	AgentDefaultRelayKeyDisplayCandidatesV2Schema,
	AgentDefaultRelayKeySavedCandidatesV1Schema,
	AgentDefaultRelayKeySavedDisplayCandidatesV2Schema,
} from "./pilot/agent-default-relay-key.ts";

const candidate = {
	endpointId: "endpoint-a",
	modelId: "opaque-model",
	reasoningLevels: ["medium"],
};

it("keeps old strict candidates exact and gives display responses a distinct version", () => {
	for (const saved of [false, true]) {
		const old = {
			schemaVersion: 1,
			configurationRevision: 2,
			...(saved ? { keyVersion: 3 } : {}),
			candidates: [candidate],
		};
		const legacy = saved
			? AgentDefaultRelayKeySavedCandidatesV1Schema
			: AgentDefaultRelayKeyCandidatesV1Schema;
		const display = saved
			? AgentDefaultRelayKeySavedDisplayCandidatesV2Schema
			: AgentDefaultRelayKeyDisplayCandidatesV2Schema;
		expect(legacy.parse(old)).toEqual(old);
		const enriched = {
			...old,
			schemaVersion: 2,
			candidates: [{ ...candidate, displayName: "部署模型" }],
		};
		expect(display.parse(enriched)).toEqual(enriched);
		expect(legacy.safeParse(enriched).success).toBe(false);
		expect(legacy.safeParse({ ...enriched, schemaVersion: 1 }).success).toBe(
			false,
		);
		expect(display.safeParse(old).success).toBe(false);
		for (const displayName of ["", " ", "x".repeat(129), "bad\nname"]) {
			expect(
				display.safeParse({
					...enriched,
					candidates: [{ ...candidate, displayName }],
				}).success,
			).toBe(false);
		}
	}
});

it("admits only the exact separate display path without weakening legacy contracts", async () => {
	const current = JSON.parse(
		await readFile(
			new URL(
				"../artifacts/openapi/pilot-browser.v2.openapi.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const path = "/api/v2/agents/{agentId}/default-relay-key/display-candidates";
	const oldPath = "/api/v2/agents/{agentId}/default-relay-key/candidates";
	const schema = (document: typeof current, method = "post") =>
		document.paths[path][method].responses[200].content["application/json"]
			.schema;
	for (const method of ["get", "post"]) {
		expect(current.paths[path][method].security).toEqual([
			{ PlatformSession: [] },
		]);
		expect(schema(current, method).additionalProperties).toBe(false);
		expect(schema(current, method).properties.schemaVersion.const).toBe(2);
		expect(
			schema(current, method).properties.candidates.items.required,
		).toContain("displayName");
		expect(
			current.paths[oldPath][method].responses[200].content["application/json"]
				.schema.properties.schemaVersion.const,
		).toBe(1);
	}
	const previous = structuredClone(current);
	delete previous.paths[path];
	const directory = await mkdtemp(resolve(tmpdir(), "model-display-compat-"));
	const before = resolve(directory, "previous.json");
	const after = resolve(directory, "current.json");
	const compare = () =>
		spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("./compatibility.mjs", import.meta.url)),
				"--previous",
				before,
				"--current",
				after,
			],
			{ encoding: "utf8" },
		);
	try {
		await writeFile(before, JSON.stringify(previous));
		await writeFile(after, JSON.stringify(current));
		expect(compare().status).toBe(0);
		for (const mutate of [
			(d: typeof current) => {
				schema(d).properties.schemaVersion.const = 1;
			},
			(d: typeof current) => {
				schema(d).additionalProperties = true;
			},
			(d: typeof current) => {
				schema(d).properties.candidates.items.additionalProperties = true;
			},
			(d: typeof current) => {
				schema(d).properties.candidates.items.required = [
					"endpointId",
					"modelId",
					"reasoningLevels",
				];
			},
			(d: typeof current) => {
				schema(d).properties.candidates.items.properties.credential = {
					type: "string",
				};
			},
			(d: typeof current) => {
				d.paths[path].post.security = [];
			},
			(d: typeof current) => {
				d.paths[path].get.requestBody = d.paths[path].post.requestBody;
			},
			(d: typeof current) => {
				d.paths[path].post.requestBody.content[
					"application/json"
				].schema.properties.keyValue.writeOnly = false;
			},
			(d: typeof current) => {
				d.paths[oldPath].post.responses[200].content[
					"application/json"
				].schema.properties.schemaVersion.const = 2;
			},
			(d: typeof current) => {
				d.paths[oldPath].get.responses[200].content[
					"application/json"
				].schema.properties.candidates.items.properties.displayName = {
					type: "string",
				};
			},
			(d: typeof current) => {
				d.paths["/api/v2/unreviewed"] = d.paths[path];
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			await writeFile(after, JSON.stringify(changed));
			expect(compare().status).toBe(1);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
