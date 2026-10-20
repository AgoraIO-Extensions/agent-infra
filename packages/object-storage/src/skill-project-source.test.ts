import { describe, expect, it } from "vitest";
import {
	canonicalSkillPackageSourceProofV1,
	SkillPackageAdmissionErrorV1,
} from "./skill-package-admission.js";
import { createSkillProjectSourceVerifierV1 } from "./skill-project-source.js";

const digest = "a".repeat(64);
const input = {
	provider: "my_library",
	sourceVersion: "project:0f8b6c2e-1d0a-4c5e-9b8f-2a7d6c5e4f3a:r3",
	sourceDigest: digest,
	archiveDigest: digest,
	manifestDigest: "b".repeat(64),
	trustRevision: "trust-1",
	approvalRef: null,
	ownerId: "owner-a",
};

describe("Skill project source proof (#2906)", () => {
	it("proves the platform project snapshot with the owner as publisher", async () => {
		const proof = await createSkillProjectSourceVerifierV1().verify(input);
		expect(proof).toEqual({
			schemaVersion: 1,
			provider: "my_library",
			publisherId: "owner-a",
			sourceVersion: input.sourceVersion,
			sourceDigest: digest,
			approvalRef: null,
			trustRevision: "trust-1",
		});
		// 证明满足既有 canonical 来源证明合同。
		expect(
			canonicalSkillPackageSourceProofV1(proof).byteLength,
		).toBeGreaterThan(0);
	});

	it.each([
		["an external provider", { provider: "github" }],
		["an approval reference", { approvalRef: "approval-1" }],
		[
			"a source digest different from the actual ZIP",
			{ sourceDigest: "c".repeat(64) },
		],
		["a non-project source version", { sourceVersion: "snapshot-1" }],
		["a zero revision", { sourceVersion: "project:p:r0" }],
		["an empty owner", { ownerId: "" }],
	])("rejects %s", async (_label, change) => {
		await expect(
			createSkillProjectSourceVerifierV1().verify({ ...input, ...change }),
		).rejects.toEqual(new SkillPackageAdmissionErrorV1("source_untrusted"));
	});
});
