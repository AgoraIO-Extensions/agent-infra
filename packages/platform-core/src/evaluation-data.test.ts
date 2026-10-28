import { describe, expect, it } from "vitest";
import {
	evaluationRetainedMetadataFieldsV1,
	parseEvaluationPolicyV1,
	validateEvaluationDatasetContentV1,
} from "./evaluation-data.js";

const retention = {
	contentMs: 100000,
	metadataMs: 200000,
	deleteWithinMs: 10000,
};
export const evaluationPolicyFixture = () => ({
	schemaVersion: 1,
	policyId: "eval-test",
	revision: 1,
	validUntil: new Date(Date.now() + 600000).toISOString(),
	retainedMetadataFields: evaluationRetainedMetadataFieldsV1,
	materialApprovals: [
		{
			approvalId: "synthetic-fixture",
			scope: "team",
			kind: "synthetic",
			redactionRef: null,
		},
		{
			approvalId: "approved-fixture",
			scope: "team",
			kind: "approved",
			redactionRef: "redaction-fixture",
		},
	],
	managers: [
		{
			principal: { kind: "user", id: "admin" },
			scopes: ["team"],
			operations: ["create", "import", "read", "manage_grants", "delete"],
			maxGrantMs: 60000,
		},
	],
	retention: {
		samples: { ...retention, startsAt: "version_reserved" },
		rubric: { ...retention, startsAt: "version_reserved" },
		output: { ...retention, startsAt: "content_created" },
		score: { ...retention, startsAt: "content_created" },
		review: { ...retention, startsAt: "content_created" },
	},
	maxContentBytes: 65536,
	transferTimeoutMs: 5000,
	pendingMs: 30000,
});
describe("Eval independent data input", () => {
	it("parses deployment manager scopes and exact-version grant operations without Array.from index arguments", () => {
		const p = parseEvaluationPolicyV1(evaluationPolicyFixture());
		expect(p.managers[0]?.scopes).toEqual(["team"]);
		expect(p.managers[0]?.operations).toContain("import");
	});
	it("retains multiline samples and rubric while rejecting NUL and unpaired surrogates", () => {
		const input = {
			schemaVersion: 1,
			provenance: { approvalId: "synthetic-fixture" },
			samples: [
				{
					id: "sample-a",
					input: "code\n  return 1;\t",
					context: "a,b\n1,2",
					taskType: "code",
					expectedResult: "line1\nline2",
				},
			],
			rubric: [{ id: "format", description: "First line\nSecond line" }],
		};
		const bytes = (value: unknown) =>
			new TextEncoder().encode(JSON.stringify(value));
		expect(validateEvaluationDatasetContentV1(bytes(input))).toEqual(input);
		for (const bad of ["text\0value", "\ud800"])
			expect(() =>
				validateEvaluationDatasetContentV1(
					bytes({ ...input, samples: [{ ...input.samples[0], input: bad }] }),
				),
			).toThrow();
	});
	it("rejects missing policy, extra authority, duplicate managers and unsafe retention", () => {
		for (const value of [
			undefined,
			{ ...evaluationPolicyFixture(), admin: true },
			{
				...evaluationPolicyFixture(),
				managers: [
					...evaluationPolicyFixture().managers,
					...evaluationPolicyFixture().managers,
				],
			},
			{ ...evaluationPolicyFixture(), retention: {} },
			{ ...evaluationPolicyFixture(), retainedMetadataFields: ["datasetId"] },
			{
				...evaluationPolicyFixture(),
				materialApprovals: [
					{
						approvalId: "real",
						scope: "team",
						kind: "approved",
						redactionRef: null,
					},
				],
			},
			{
				...evaluationPolicyFixture(),
				materialApprovals: [
					{
						approvalId: "synthetic",
						scope: "team",
						kind: "synthetic",
						redactionRef: "self-declared",
					},
				],
			},
			{
				...evaluationPolicyFixture(),
				retention: {
					...evaluationPolicyFixture().retention,
					samples: { ...retention, startsAt: "confirmation" },
				},
			},
		])
			expect(() => parseEvaluationPolicyV1(value)).toThrow();
	});
});
