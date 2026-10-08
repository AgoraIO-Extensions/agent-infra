import { describe, expect, it } from "vitest";
import { parseSkillPackagePublicationSelectionV1 } from "./skill-package-publication.js";

const selection = {
	schemaVersion: 1,
	name: "summary",
	skillId: "skill-a",
	skillVersionId: "version-a",
	visibility: "PRIVATE",
	provider: "my_library",
	version: "1.0.0",
	sourceVersion: "source-1",
	sourceDigest: "a".repeat(64),
	approvalRef: null,
	trustRevision: "trust-1",
	policyRevision: "policy-1",
	archiveDigest: "b".repeat(64),
};

describe("Skill package publication input", () => {
	it("freezes only bounded selection metadata, not package body or caller ownership", () => {
		const parsed = parseSkillPackagePublicationSelectionV1(selection);
		expect(parsed).toEqual(selection);
		expect(Object.isFrozen(parsed)).toBe(true);
		for (const field of [
			"ownerId",
			"path",
			"url",
			"verified",
			"clean",
			"archiveBytes",
		])
			expect(() =>
				parseSkillPackagePublicationSelectionV1({
					...selection,
					[field]: "untrusted",
				}),
			).toThrow();
	});
});
