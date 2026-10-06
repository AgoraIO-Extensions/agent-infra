import { describe, expect, it } from "vitest";
import {
	MagicSkillProviderOrderV1,
	SkillPackageValidationErrorV1,
	validateSkillPackageEntriesV1,
} from "./skill-hub.ts";

describe("Skill Hub package boundary", () => {
	it("keeps Magic provider order", () => {
		expect(MagicSkillProviderOrderV1).toEqual([
			"system",
			"my_library",
			"market",
			"clawhub",
			"skillhub",
			"npx",
			"github",
		]);
	});

	it("accepts a bounded package with SKILL.md", () => {
		expect(
			validateSkillPackageEntriesV1([
				{ path: "SKILL.md", kind: "file", sizeBytes: 10 },
				{ path: "references/guide.md", kind: "file", sizeBytes: 20 },
				{ path: "references", kind: "directory", sizeBytes: 0 },
			]),
		).toEqual({ fileCount: 2, totalBytes: 30 });
	});

	it.each([
		"../SKILL.md",
		"/SKILL.md",
		"references/../SKILL.md",
		"references\\guide.md",
	])("rejects unsafe path %s", (path) => {
		expect(() =>
			validateSkillPackageEntriesV1([{ path, kind: "file", sizeBytes: 1 }]),
		).toThrowError(SkillPackageValidationErrorV1);
	});

	it("rejects symlinks, duplicates, missing entry, and limits", () => {
		expect(() =>
			validateSkillPackageEntriesV1([
				{ path: "SKILL.md", kind: "symlink", sizeBytes: 1 },
			]),
		).toThrowError(SkillPackageValidationErrorV1);
		expect(() =>
			validateSkillPackageEntriesV1([
				{ path: "SKILL.md", kind: "file", sizeBytes: 1 },
				{ path: "SKILL.md", kind: "file", sizeBytes: 1 },
			]),
		).toThrowError(SkillPackageValidationErrorV1);
		expect(() =>
			validateSkillPackageEntriesV1([
				{ path: "README.md", kind: "file", sizeBytes: 1 },
			]),
		).toThrowError(SkillPackageValidationErrorV1);
		expect(() =>
			validateSkillPackageEntriesV1(
				[{ path: "SKILL.md", kind: "file", sizeBytes: 2 }],
				{ maxBytes: 1 },
			),
		).toThrowError(SkillPackageValidationErrorV1);
	});
});
