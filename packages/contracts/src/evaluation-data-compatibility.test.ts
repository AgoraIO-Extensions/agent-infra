import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readEvaluationBaseline } from "./test/evaluation-baseline.js";

type Contract = Awaited<ReturnType<typeof readEvaluationBaseline>>;
type Mutation = readonly [string, (document: Contract) => void];
const comparisonTimeout = 30000;

function removeScopes(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const object = value as Record<string, unknown>;
	if (
		Array.isArray(object.enum) &&
		object.enum.some(
			(item) => typeof item === "string" && item.startsWith("eval:"),
		)
	)
		object.enum = object.enum.filter(
			(item) => typeof item !== "string" || !item.startsWith("eval:"),
		);
	const properties = object.properties as
		| Record<string, { maxItems?: number; items?: { enum?: string[] } }>
		| undefined;
	if (
		properties?.scopes?.maxItems === 8 &&
		properties.scopes.items?.enum?.includes("eval:data")
	)
		properties.scopes.maxItems = 4;
	for (const child of Object.values(object)) removeScopes(child);
}

async function compare(previous: Contract, current: Contract) {
	const directory = await mkdtemp(join(tmpdir(), "evaluation-compat-"));
	const before = join(directory, "before.json");
	const after = join(directory, "after.json");
	try {
		await writeFile(before, JSON.stringify(previous));
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
			{ encoding: "utf8", timeout: 20000 },
		).status;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe.each(["v1", "v2"] as const)("Eval %s compatibility", (version) => {
	let current: Contract;
	let previous: Contract;
	beforeAll(async () => {
		current = JSON.parse(
			await readFile(
				new URL(
					`../artifacts/openapi/pilot-browser.${version}.openapi.json`,
					import.meta.url,
				),
				"utf8",
			),
		);
		previous = await readEvaluationBaseline(version);
		for (const path of Object.keys(previous.paths))
			if (path.startsWith("/api/v2/evaluation/")) delete previous.paths[path];
		for (const name of Object.keys(previous.components.schemas))
			if (name.startsWith("Evaluation"))
				delete previous.components.schemas[name];
		removeScopes(previous);
		const audit = previous.components.schemas.ScopedPlatformAuditActionV1;
		if (audit)
			audit.enum = audit.enum.filter(
				(value: string) => !value.startsWith("evaluation."),
			);
		for (const name of [
			"ScopedPlatformAuditProjectionV1",
			"ScopedPlatformAuditProjectionV2",
		]) {
			const subject =
				previous.components.schemas[name]?.properties.subject.properties.kind;
			if (subject)
				subject.enum = subject.enum.filter(
					(value: string) => !value.startsWith("evaluation_"),
				);
		}
	}, 60000);

	// Each comparison keeps its own deadline instead of accumulating dozens of
	// subprocesses under one timeout on a contended CI runner.
	it(
		"accepts the reviewed addition",
		async () => {
			expect(await compare(previous, current)).toBe(0);
		},
		comparisonTimeout,
	);
	it(
		"accepts the unchanged contract",
		async () => {
			expect(await compare(current, current)).toBe(0);
		},
		comparisonTimeout,
	);
	it(
		"rejects rolling back the reviewed addition",
		async () => {
			expect(await compare(current, previous)).toBe(1);
		},
		comparisonTimeout,
	);
	it(
		"rejects removing Eval scopes",
		async () => {
			if (!JSON.stringify(current).includes("eval:data")) return;
			const changed = structuredClone(current);
			removeScopes(changed);
			expect(await compare(current, changed)).toBe(1);
		},
		comparisonTimeout,
	);

	const removals: Mutation[] =
		version === "v2"
			? [
					[
						"all Eval paths",
						(doc) => {
							for (const path of Object.keys(doc.paths))
								if (path.startsWith("/api/v2/evaluation/"))
									delete doc.paths[path];
						},
					],
					...[
						"/api/v2/evaluation/experiments",
						"/api/v2/evaluation/scores/{scoreId}/human",
						"/api/v2/evaluation/scores/{scoreId}/reviews",
					].map(
						(path): Mutation => [
							path,
							(doc) => {
								delete doc.paths[path];
							},
						],
					),
					...[
						"EvaluationExperimentPageV1",
						"EvaluationScoreMetadataV1",
						"EvaluationReviewV1",
						"EvaluationReviewPageV1",
						"EvaluationVersionV1",
					].map(
						(name): Mutation => [
							name,
							(doc) => {
								delete doc.components.schemas[name];
							},
						],
					),
					...["eval:run", "eval:score", "eval:review"].map(
						(scope): Mutation => [
							scope,
							(doc) => {
								const item =
									doc.components.schemas.PersonalApiCredentialMetadataV1
										.properties.scopes;
								item.items.enum = item.items.enum.filter(
									(value: string) => value !== scope,
								);
							},
						],
					),
				]
			: [
					[
						"content read audit action",
						(doc) => {
							doc.components.schemas.ScopedPlatformAuditActionV1.enum =
								doc.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
									(action: string) => action !== "evaluation.content.read",
								);
						},
					],
					[
						"dataset audit subject",
						(doc) => {
							doc.components.schemas.ScopedPlatformAuditProjectionV1.properties.subject.properties.kind.enum =
								doc.components.schemas.ScopedPlatformAuditProjectionV1.properties.subject.properties.kind.enum.filter(
									(kind: string) => kind !== "evaluation_dataset",
								);
						},
					],
				];
	it.each(removals)(
		"rejects removal of %s",
		async (_name, mutate) => {
			const changed = structuredClone(current);
			mutate(changed);
			expect(await compare(current, changed)).toBe(1);
		},
		comparisonTimeout,
	);

	const unreviewed: Mutation[] =
		version === "v2"
			? [
					[
						"review read security",
						(doc) => {
							doc.paths[
								"/api/v2/evaluation/scores/{scoreId}/reviews"
							].get.security = [];
						},
					],
					[
						"experiment write security",
						(doc) => {
							doc.paths["/api/v2/evaluation/experiments"].post.security = [];
						},
					],
					[
						"score submission extra fields",
						(doc) => {
							doc.components.schemas.EvaluationScoreSubmitV1.additionalProperties = true;
						},
					],
					[
						"experiment required metadata",
						(doc) => {
							doc.components.schemas.EvaluationExperimentPageV1.properties.items.items.required.pop();
						},
					],
					[
						"credential scope order",
						(doc) => {
							doc.components.schemas.PersonalApiCredentialMetadataV1.properties.scopes.items.enum.reverse();
						},
					],
					[
						"dataset write security",
						(doc) => {
							doc.paths["/api/v2/evaluation/datasets"].post.security = [];
						},
					],
					[
						"grant extra fields",
						(doc) => {
							doc.components.schemas.EvaluationGrantCreateV1.additionalProperties = true;
						},
					],
					[
						"dataset content requirements",
						(doc) => {
							doc.components.schemas.EvaluationDatasetContentV1.required.pop();
						},
					],
					[
						"administrator credential scope",
						(doc) => {
							doc.components.schemas.PersonalApiCredentialMetadataV1.properties.scopes.items.enum.push(
								"eval:admin",
							);
						},
					],
					[
						"credential scope limit",
						(doc) => {
							doc.components.schemas.PersonalApiCredentialIssueRequestV1.properties.scopes.maxItems = 6;
						},
					],
				]
			: [
					[
						"audit actor kind",
						(doc) => {
							doc.components.schemas.ScopedPlatformAuditProjectionV1.properties.actor.properties.kind.enum.push(
								"evaluation_dataset",
							);
						},
					],
					[
						"unreviewed audit action",
						(doc) => {
							doc.components.schemas.ScopedPlatformAuditActionV1.enum.push(
								"evaluation.unsafe",
							);
						},
					],
				];
	it.each(unreviewed)(
		"rejects unreviewed change to %s",
		async (_name, mutate) => {
			const changed = structuredClone(current);
			mutate(changed);
			expect(await compare(previous, changed)).toBe(1);
		},
		comparisonTimeout,
	);
});
