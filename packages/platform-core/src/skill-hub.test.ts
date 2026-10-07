import { describe, expect, it } from "vitest";
import {
	bindSkillHubVersionToAgentVersionV1,
	createSkillHubVersionV1,
	MagicSkillProviderOrderV1,
	markSkillHubUpgradeV1,
	reviewSkillHubVersionV1,
	revokeSkillHubVersionV1,
	SkillHubLifecycleErrorV1,
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
		"./SKILL.md",
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
				{ path: "SKILL.md", kind: "directory", sizeBytes: 0 },
			]),
		).toThrowError(SkillPackageValidationErrorV1);
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

describe("Skill Hub lifecycle", () => {
	const input = {
		skillId: "skill-1",
		skillVersionId: "skill-version-1",
		ownerId: "owner-1",
		visibility: "ORGANIZATION" as const,
		provider: "market" as const,
		version: "1.0.0",
		packageObjectVersion: "object-1",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
	};

	it("requires review for shared visibility and publishes private versions", async () => {
		const pending = createSkillHubVersionV1(input);
		expect(pending.state).toBe("pending_review");
		expect(() =>
			reviewSkillHubVersionV1(pending, {
				reviewerId: "owner-1",
				decision: "approve",
			}),
		).toThrowError(SkillHubLifecycleErrorV1);
		const published = reviewSkillHubVersionV1(pending, {
			reviewerId: "reviewer-1",
			decision: "approve",
		});
		expect(published.state).toBe("published");
		expect(
			createSkillHubVersionV1({ ...input, visibility: "PRIVATE" }).state,
		).toBe("published");
	});

	it("keeps upgrade explicit and revocation terminal", async () => {
		const current = reviewSkillHubVersionV1(createSkillHubVersionV1(input), {
			reviewerId: "reviewer-1",
			decision: "approve",
		});
		const latest = reviewSkillHubVersionV1(
			createSkillHubVersionV1({
				...input,
				skillVersionId: "skill-version-2",
				version: "2.0.0",
				packageObjectVersion: "object-2",
			}),
			{ reviewerId: "reviewer-1", decision: "approve" },
		);
		expect(markSkillHubUpgradeV1(current, latest).needUpgrade).toBe(true);
		expect(
			bindSkillHubVersionToAgentVersionV1(current, {
				agentId: "agent-1",
				agentVersion: "agent-version-1",
			}).state,
		).toBe("pending_sync");
		const revoked = revokeSkillHubVersionV1(current, "2026-10-07T00:00:00Z");
		expect(revoked.state).toBe("revoked");
		expect(() =>
			bindSkillHubVersionToAgentVersionV1(revoked, {
				agentId: "agent-1",
				agentVersion: "agent-version-1",
			}),
		).toThrowError(SkillHubLifecycleErrorV1);
	});
});
