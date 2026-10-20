import { describe, expect, it } from "vitest";
import {
	SkillHubProjectContentSaveResponseV1Schema,
	SkillHubProjectContentUpdateV1Schema,
	SkillHubProjectContentV1Schema,
	SkillHubProjectPublicationRequestV1Schema,
	skillHubProjectContentLimitsV1,
} from "./skill-hub-project-content.ts";

const update = {
	schemaVersion: 1,
	baseRevision: 0,
	files: [
		{ path: "SKILL.md", encoding: "utf8", content: "# summary\n" },
		{ path: "scripts/run.sh", encoding: "utf8", content: "echo run\n" },
		{ path: "references/guide.md", encoding: "utf8", content: "guide" },
		{ path: "assets/logo.png", encoding: "base64", content: "iVBORw0KGgo=" },
	],
};

describe("Skill Hub project content contract (#2906)", () => {
	it("accepts SKILL.md with scripts, references and assets in text or base64", () => {
		expect(
			SkillHubProjectContentUpdateV1Schema.parse(update).files,
		).toHaveLength(4);
		expect(
			SkillHubProjectContentV1Schema.parse({
				schemaVersion: 1,
				projectId: "project-a",
				revision: 0,
				contentDigest: null,
				fileCount: 0,
				totalBytes: 0,
				updatedAt: null,
				files: [],
			}).revision,
		).toBe(0);
		expect(
			SkillHubProjectContentV1Schema.parse({
				schemaVersion: 1,
				projectId: "project-a",
				revision: 2,
				contentDigest: "a".repeat(64),
				fileCount: 1,
				totalBytes: 10,
				updatedAt: "2026-10-01T08:00:00Z",
				files: [
					{
						path: "SKILL.md",
						encoding: "utf8",
						content: "# summary\n",
						sizeBytes: 10,
					},
				],
			}).files,
		).toHaveLength(1);
	});

	it.each([
		["a path outside the canonical layout", "notes/readme.md"],
		["a nested SKILL.md outside the root", "docs/SKILL.md"],
		["a parent segment", "scripts/../SKILL.md"],
		["a current segment", "references/./guide.md"],
		["an absolute path", "/SKILL.md"],
		["a backslash", "scripts\\run.sh"],
		["a bare directory", "scripts/"],
		["a hidden traversal", "assets/.."],
	])("rejects %s", (_label, path) => {
		expect(
			SkillHubProjectContentUpdateV1Schema.safeParse({
				...update,
				files: [{ path, encoding: "utf8", content: "x" }],
			}).success,
		).toBe(false);
	});

	it("bounds the number of files, their size and base64 encoding", () => {
		const many = Array.from(
			{ length: skillHubProjectContentLimitsV1.maxFiles + 1 },
			(_, index) => ({
				path: `references/${index}.md`,
				encoding: "utf8",
				content: "x",
			}),
		);
		for (const files of [
			[],
			many,
			[
				{
					path: "SKILL.md",
					encoding: "utf8",
					content: "x".repeat(skillHubProjectContentLimitsV1.maxFileBytes + 1),
				},
			],
			[{ path: "assets/a.bin", encoding: "base64", content: "not base64!" }],
			[{ path: "assets/a.bin", encoding: "hex", content: "00" }],
		])
			expect(
				SkillHubProjectContentUpdateV1Schema.safeParse({ ...update, files })
					.success,
			).toBe(false);
	});

	it("never lets the browser submit package facts on publication", () => {
		const request = {
			schemaVersion: 1,
			contentRevision: 3,
			version: "1.0.0",
			visibility: "MEMBER",
		};
		expect(SkillHubProjectPublicationRequestV1Schema.parse(request)).toEqual(
			request,
		);
		for (const extra of [
			{ packageObjectVersion: "object-a" },
			{ packageDigest: "a".repeat(64) },
			{ manifestDigest: "b".repeat(64) },
			{ signatureDigest: "c".repeat(64) },
			{ provider: "github" },
			{ organizationId: "org-a" },
			{ sourceDigest: "d".repeat(64) },
			{ approvalRef: "approved" },
		])
			expect(
				SkillHubProjectPublicationRequestV1Schema.safeParse({
					...request,
					...extra,
				}).success,
			).toBe(false);
		for (const change of [
			{ contentRevision: 0 },
			{ version: "latest version" },
			{ visibility: "PUBLIC" },
		])
			expect(
				SkillHubProjectPublicationRequestV1Schema.safeParse({
					...request,
					...change,
				}).success,
			).toBe(false);
	});

	it("returns only revision facts after saving", () => {
		const saved = {
			replayed: false,
			projectId: "project-a",
			revision: 1,
			contentDigest: "a".repeat(64),
			fileCount: 1,
			totalBytes: 10,
			updatedAt: "2026-10-01T08:00:00Z",
		};
		expect(SkillHubProjectContentSaveResponseV1Schema.parse(saved)).toEqual(
			saved,
		);
		expect(
			SkillHubProjectContentSaveResponseV1Schema.safeParse({
				...saved,
				files: update.files,
			}).success,
		).toBe(false);
	});
});
