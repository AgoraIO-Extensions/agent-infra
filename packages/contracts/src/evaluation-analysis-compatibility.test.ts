import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([1, 2])(
	"only admits the approved analysis/feedback addition for pilot v%s",
	async (version) => {
		const repo = resolve(import.meta.dirname, "../../..");
		const name = `packages/contracts/artifacts/openapi/pilot-browser.v${version}.openapi.json`;
		const before = JSON.parse(
			execFileSync(
				"git",
				["show", `b1049e631f9e8b6e69c8dc791867894aac779531:${name}`],
				{ cwd: repo, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			),
		);
		const after = JSON.parse(await readFile(join(repo, name), "utf8"));
		const dir = await mkdtemp(join(tmpdir(), "evaluation-analysis-compat-"));
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
			expect(await compare(after, before)).toBe(1);
			if (version === 1) {
				const malformed = structuredClone(after);
				malformed.components.schemas.ScopedPlatformAuditActionV1.enum.push(
					"invented.audit",
				);
				expect(await compare(before, malformed)).toBe(1);
			}
			if (version === 2) {
				const scope = structuredClone(after);
				scope.components.schemas.PersonalApiCredentialIssueRequestV1.properties.scopes.items.enum.push(
					"invented:all",
				);
				expect(await compare(before, scope)).toBe(1);
				const old = structuredClone(after);
				delete old.components.schemas.PersonalApiCredentialMetadataV1.properties
					.credentialId;
				expect(await compare(before, old)).toBe(1);

				const missing = structuredClone(after);
				delete missing.paths["/api/v2/evaluation/history"];
				expect(await compare(after, missing)).toBe(1);
				const required = structuredClone(after);
				required.components.schemas.EvaluationExperimentCreateV1.required.push(
					"comparisonTargets",
				);
				expect(await compare(before, required)).toBe(1);
				const mutated = structuredClone(after);
				mutated.components.schemas.EvaluationAnalysisSummaryV1.properties.fixedSamples.minimum =
					-1;
				expect(await compare(before, mutated)).toBe(1);
				const removal = structuredClone(after);
				delete removal.components.schemas.EvaluationExperimentPageV1.properties
					.items.items.properties.requestedEvidence;
				expect(await compare(after, removal)).toBe(1);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
	60000,
);
