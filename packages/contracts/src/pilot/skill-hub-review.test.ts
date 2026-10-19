import { describe, expect, it } from "vitest";
import {
	SkillHubReviewQueuePageV1Schema,
	SkillHubReviewQueueQueryV1Schema,
} from "./skill-hub-review.ts";

const item = {
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
};

describe("Skill Hub review queue contract", () => {
	it("accepts a bounded page of pending shared versions", () => {
		expect(
			SkillHubReviewQueuePageV1Schema.parse({
				items: [item, { ...item, visibility: "MARKET", organizationId: null }],
				nextCursor: "version-a",
			}).items,
		).toHaveLength(2);
	});

	it.each([
		["published state", { state: "published" }],
		["PRIVATE visibility", { visibility: "PRIVATE" }],
		["object storage location", { packageObjectVersion: "object-a" }],
		["review reason", { reviewReason: "private-review-text" }],
		["unbounded owner", { ownerId: "../owner" }],
		["missing submission time", { submittedAt: undefined }],
	])("rejects %s", (_name, change) => {
		expect(
			SkillHubReviewQueuePageV1Schema.safeParse({
				items: [{ ...item, ...change }],
				nextCursor: null,
			}).success,
		).toBe(false);
	});

	it("rejects oversized pages and unknown query fields", () => {
		expect(
			SkillHubReviewQueuePageV1Schema.safeParse({
				items: Array.from({ length: 101 }, () => item),
				nextCursor: null,
			}).success,
		).toBe(false);
		expect(
			SkillHubReviewQueueQueryV1Schema.safeParse({ limit: "101" }).success,
		).toBe(false);
		expect(
			SkillHubReviewQueueQueryV1Schema.safeParse({ ownerId: "owner-a" })
				.success,
		).toBe(false);
		expect(SkillHubReviewQueueQueryV1Schema.parse({ limit: "20" })).toEqual({
			limit: 20,
		});
	});
});
