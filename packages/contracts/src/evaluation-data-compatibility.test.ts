import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["v1", "v2"])(
	"accepts only the reviewed Eval addition in %s and preserves old authority contracts",
	async (version) => {
		const current = JSON.parse(
			await readFile(
				new URL(
					`../artifacts/openapi/pilot-browser.${version}.openapi.json`,
					import.meta.url,
				),
				"utf8",
			),
		);
		const previous = structuredClone(current);
		for (const path of Object.keys(previous.paths))
			if (path.startsWith("/api/v2/evaluation/")) delete previous.paths[path];
		for (const name of Object.keys(previous.components.schemas))
			if (name.startsWith("Evaluation"))
				delete previous.components.schemas[name];
		const removeScopes = (value: unknown): void => {
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
		};
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
		const directory = await mkdtemp(join(tmpdir(), "evaluation-compat-"));
		const before = join(directory, "before.json");
		const after = join(directory, "after.json");
		const compare = async (value: unknown) => {
			await writeFile(after, JSON.stringify(value));
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
			await writeFile(before, JSON.stringify(previous));
			expect(await compare(current)).toBe(0);
			await writeFile(before, JSON.stringify(current));
			expect(await compare(current)).toBe(0);
			expect(await compare(previous)).toBe(1);
			const scopeRemoved = structuredClone(current);
			removeScopes(scopeRemoved);
			if (JSON.stringify(current).includes("eval:data"))
				expect(await compare(scopeRemoved)).toBe(1);
			if (version === "v2") {
				const pathsRemoved = structuredClone(current);
				for (const path of Object.keys(pathsRemoved.paths))
					if (path.startsWith("/api/v2/evaluation/"))
						delete pathsRemoved.paths[path];
				expect(await compare(pathsRemoved)).toBe(1);
				for (const path of [
					"/api/v2/evaluation/experiments",
					"/api/v2/evaluation/scores/{scoreId}/human",
					"/api/v2/evaluation/scores/{scoreId}/reviews",
				]) {
					const changed = structuredClone(current);
					delete changed.paths[path];
					expect(await compare(changed)).toBe(1);
				}
				for (const name of [
					"EvaluationExperimentPageV1",
					"EvaluationScoreMetadataV1",
					"EvaluationReviewV1",
					"EvaluationReviewPageV1",
				]) {
					const changed = structuredClone(current);
					delete changed.components.schemas[name];
					expect(await compare(changed)).toBe(1);
				}
				for (const scope of ["eval:run", "eval:score", "eval:review"]) {
					const changed = structuredClone(current);
					const item =
						changed.components.schemas.PersonalApiCredentialMetadataV1
							.properties.scopes;
					item.items.enum = item.items.enum.filter(
						(value: string) => value !== scope,
					);
					expect(await compare(changed)).toBe(1);
				}
				const schemaRemoved = structuredClone(current);
				delete schemaRemoved.components.schemas.EvaluationVersionV1;
				expect(await compare(schemaRemoved)).toBe(1);
			} else {
				const actionRemoved = structuredClone(current);
				actionRemoved.components.schemas.ScopedPlatformAuditActionV1.enum =
					actionRemoved.components.schemas.ScopedPlatformAuditActionV1.enum.filter(
						(action: string) => action !== "evaluation.content.read",
					);
				expect(await compare(actionRemoved)).toBe(1);
				const subjectRemoved = structuredClone(current);
				subjectRemoved.components.schemas.ScopedPlatformAuditProjectionV1.properties.subject.properties.kind.enum =
					subjectRemoved.components.schemas.ScopedPlatformAuditProjectionV1.properties.subject.properties.kind.enum.filter(
						(kind: string) => kind !== "evaluation_dataset",
					);
				expect(await compare(subjectRemoved)).toBe(1);
			}
			await writeFile(before, JSON.stringify(previous));
			if (version === "v2")
				for (const mutate of [
					(doc: typeof current) => {
						doc.paths[
							"/api/v2/evaluation/scores/{scoreId}/reviews"
						].get.security = [];
					},
					(doc: typeof current) => {
						doc.paths["/api/v2/evaluation/experiments"].post.security = [];
					},
					(doc: typeof current) => {
						doc.components.schemas.EvaluationScoreSubmitV1.additionalProperties = true;
					},
					(doc: typeof current) => {
						doc.components.schemas.EvaluationExperimentPageV1.properties.items.items.required.pop();
					},
					(doc: typeof current) => {
						doc.components.schemas.PersonalApiCredentialMetadataV1.properties.scopes.items.enum.reverse();
					},
					(doc: typeof current) => {
						doc.paths["/api/v2/evaluation/datasets"].post.security = [];
					},
					(doc: typeof current) => {
						doc.components.schemas.EvaluationGrantCreateV1.additionalProperties = true;
					},
					(doc: typeof current) => {
						doc.components.schemas.EvaluationDatasetContentV1.required.pop();
					},
					(doc: typeof current) => {
						doc.components.schemas.PersonalApiCredentialMetadataV1.properties.scopes.items.enum.push(
							"eval:admin",
						);
					},
					(doc: typeof current) => {
						doc.components.schemas.PersonalApiCredentialIssueRequestV1.properties.scopes.maxItems = 6;
					},
				]) {
					const changed = structuredClone(current);
					mutate(changed);
					expect(await compare(changed)).toBe(1);
				}
			if (version === "v1") {
				const changed = structuredClone(current);
				changed.components.schemas.ScopedPlatformAuditProjectionV1.properties.actor.properties.kind.enum.push(
					"evaluation_dataset",
				);
				expect(await compare(changed)).toBe(1);
				const action = structuredClone(current);
				action.components.schemas.ScopedPlatformAuditActionV1.enum.push(
					"evaluation.unsafe",
				);
				expect(await compare(action)).toBe(1);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	60000,
);
