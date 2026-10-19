import { describe, expect, it } from "vitest";
import { createSkillHubVersionV1 } from "./skill-hub.js";
import {
	pageSkillHubReviewQueueV1,
	parseSkillHubReviewQueueQueryV1,
	type SkillHubPendingReviewVersionV1,
} from "./skill-hub-review.js";

const pending = (
	visibility: "PRIVATE" | "MEMBER" | "ORGANIZATION" | "MARKET" = "MEMBER",
	organizationId: string | null = null,
): SkillHubPendingReviewVersionV1 => ({
	...createSkillHubVersionV1({
		skillId: "skill-a",
		skillVersionId: "version-a",
		ownerId: "owner-a",
		visibility,
		provider: "github",
		version: "1.0.0",
		packageObjectVersion: "internal-object",
		packageDigest: "a".repeat(64),
		manifestDigest: "b".repeat(64),
		signatureDigest: "c".repeat(64),
	}),
	name: "summary",
	organizationId,
	submittedAt: "2026-10-01T00:00:00.000Z",
});

describe("Skill Hub review queue boundary", () => {
	it("defaults and bounds the page size and parses the cursor as an opaque id", () => {
		expect(parseSkillHubReviewQueueQueryV1({})).toEqual({ limit: 50 });
		expect(
			parseSkillHubReviewQueueQueryV1({ cursor: "version-a", limit: 100 }),
		).toEqual({ cursor: "version-a", limit: 100 });
		for (const query of [
			{ limit: 0 },
			{ limit: 101 },
			{ limit: 1.5 },
			{ limit: "10" },
			{ cursor: "../version" },
		])
			expect(() => parseSkillHubReviewQueueQueryV1(query)).toThrow(
				expect.objectContaining({ code: "invalid_input" }),
			);
	});

	it("projects the publisher, scope, source and submission time without object locations", () => {
		const page = pageSkillHubReviewQueueV1({
			versions: [pending("ORGANIZATION", "org-a")],
			nextCursor: "version-a",
		});
		expect(page).toEqual({
			items: [
				{
					schemaVersion: 1,
					skillId: "skill-a",
					skillVersionId: "version-a",
					name: "summary",
					provider: "github",
					version: "1.0.0",
					packageDigest: "a".repeat(64),
					manifestDigest: "b".repeat(64),
					signatureDigest: "c".repeat(64),
					visibility: "ORGANIZATION",
					organizationId: "org-a",
					state: "pending_review",
					ownerId: "owner-a",
					submittedAt: "2026-10-01T00:00:00.000Z",
				},
			],
			nextCursor: "version-a",
		});
		expect(JSON.stringify(page)).not.toContain("internal-object");
	});

	it("fails closed on rows that are not pending shared versions", () => {
		for (const version of [
			{ ...pending(), state: "published" as const },
			{ ...pending("PRIVATE"), state: "pending_review" as const },
			pending("ORGANIZATION", null),
			pending("MARKET", "org-a"),
		])
			expect(() =>
				pageSkillHubReviewQueueV1({ versions: [version], nextCursor: null }),
			).toThrow(expect.objectContaining({ code: "unavailable" }));
	});
});
