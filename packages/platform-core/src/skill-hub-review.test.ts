import { describe, expect, it } from "vitest";
import { createSkillHubVersionV1 } from "./skill-hub.js";
import {
	canReadSkillHubReviewContentV1,
	pageSkillHubReviewQueueV1,
	parseSkillHubReviewQueueQueryV1,
	projectSkillHubReviewContentV1,
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

// 审核正文（#3046）：与版本详情可见性相互独立，只给系统管理员读取他人待审的共享版本。
describe("Skill Hub review content boundary", () => {
	const admin = {
		schemaVersion: 1 as const,
		userId: "admin",
		accountStatus: "active" as const,
		organizationIds: ["org-b"],
		isAdministrator: true,
	};

	it("lets an active administrator read another publisher's pending shared version", () => {
		for (const [visibility, organizationId] of [
			["MEMBER", null],
			["MARKET", null],
			["ORGANIZATION", "org-a"],
		] as const)
			expect(
				canReadSkillHubReviewContentV1(
					pending(visibility, organizationId),
					admin,
					organizationId,
				),
			).toBe(true);
	});

	it("refuses members, inactive administrators, the publisher and handled or private versions", () => {
		const version = pending("ORGANIZATION", "org-a");
		for (const [candidate, actor, organizationId] of [
			// 同组织普通成员与跨组织成员都不能读。
			[
				version,
				{
					...admin,
					userId: "member-a",
					isAdministrator: false,
					organizationIds: ["org-a"],
				},
				"org-a",
			],
			[
				version,
				{ ...admin, userId: "member-b", isAdministrator: false },
				"org-a",
			],
			[version, { ...admin, accountStatus: "disabled" as const }, "org-a"],
			// 发布者本人即使是系统管理员也走版本详情。
			[version, { ...admin, userId: "owner-a" }, "org-a"],
			[{ ...version, state: "published" as const }, admin, "org-a"],
			[{ ...version, state: "rejected" as const }, admin, "org-a"],
			[{ ...version, state: "revoked" as const }, admin, "org-a"],
			[
				{ ...pending("PRIVATE"), state: "pending_review" as const },
				admin,
				null,
			],
			// ORGANIZATION 已没有目标组织时不在审核队列中。
			[version, admin, null],
		] as const)
			expect(
				canReadSkillHubReviewContentV1(candidate, actor, organizationId),
			).toBe(false);
	});

	it("projects only the contract version, version ID and the shared content", () => {
		const content = {
			state: "available" as const,
			body: "# summary\n",
			bodyTruncated: false,
			resources: [],
		};
		const projected = projectSkillHubReviewContentV1({
			version: pending(),
			content,
		});
		expect(projected).toEqual({
			schemaVersion: 1,
			skillVersionId: "version-a",
			content,
		});
		expect(JSON.stringify(projected)).not.toMatch(
			/internal-object|owner-a|reviewReason/,
		);
	});
});
