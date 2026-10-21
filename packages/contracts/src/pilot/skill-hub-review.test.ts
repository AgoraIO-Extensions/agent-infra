import { describe, expect, it } from "vitest";
import {
	SkillHubReviewContentV1Schema,
	SkillHubReviewQueueItemV1Schema,
	SkillHubReviewQueuePageV1Schema,
	SkillHubReviewQueueQueryV1Schema,
	skillHubReviewOpenApiPathsV1,
} from "./skill-hub-review.ts";
import { skillHubVersionBodyMaxBytesV1 } from "./skill-hub-version-detail.ts";

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

// 审核正文（#3046）：系统管理员读取他人待审版本的有界正文与资源清单。
const reviewContent = {
	schemaVersion: 1,
	skillVersionId: "version-a",
	content: {
		state: "available",
		body: "# summary\n<script>alert(1)</script>\n",
		bodyTruncated: false,
		resources: [{ path: "scripts/run.sh", kind: "script", sizeBytes: 8 }],
	},
};

describe("Skill Hub review content contract", () => {
	it("accepts bounded text, truncation and unavailable content", () => {
		expect(SkillHubReviewContentV1Schema.parse(reviewContent)).toEqual(
			reviewContent,
		);
		expect(
			SkillHubReviewContentV1Schema.parse({
				...reviewContent,
				content: {
					...reviewContent.content,
					body: "x".repeat(skillHubVersionBodyMaxBytesV1),
					bodyTruncated: true,
				},
			}).content,
		).toMatchObject({ bodyTruncated: true });
		expect(
			SkillHubReviewContentV1Schema.parse({
				...reviewContent,
				content: { state: "unavailable" },
			}).content,
		).toEqual({ state: "unavailable" });
	});

	it("rejects oversized bodies, resource contents and extra fields", () => {
		for (const value of [
			{
				...reviewContent,
				content: {
					...reviewContent.content,
					body: "x".repeat(skillHubVersionBodyMaxBytesV1 + 1),
				},
			},
			{
				...reviewContent,
				content: {
					...reviewContent.content,
					resources: [
						{
							path: "scripts/run.sh",
							kind: "script",
							sizeBytes: 8,
							content: "echo run",
						},
					],
				},
			},
			{ ...reviewContent, packageObjectVersion: "object-1" },
			{ ...reviewContent, reviewReason: "private review text" },
			{ ...reviewContent, installation: { state: "not_installed" } },
			{ ...reviewContent, content: { state: "unavailable", body: "x" } },
			{ ...reviewContent, schemaVersion: 2 },
		])
			expect(SkillHubReviewContentV1Schema.safeParse(value).success).toBe(
				false,
			);
	});

	it("keeps the review queue item free of SKILL.md content", () => {
		expect(
			SkillHubReviewQueueItemV1Schema.safeParse({
				...item,
				content: reviewContent.content,
			}).success,
		).toBe(false);
	});

	it("requires a platform session for the review content read", () => {
		const read =
			skillHubReviewOpenApiPathsV1[
				"/api/v2/skills/reviews/{skillVersionId}/content"
			].get;
		expect(read.operationId).toBe("readSkillHubReviewContentV1");
		expect(read.security).toEqual([{ PlatformSession: [] }]);
		expect(Object.keys(read.responses).sort()).toEqual([
			"200",
			"400",
			"401",
			"403",
			"404",
			"503",
		]);
	});
});
