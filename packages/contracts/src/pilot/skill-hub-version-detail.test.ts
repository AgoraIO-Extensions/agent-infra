import { describe, expect, it } from "vitest";
import {
	SkillHubOwnedVersionPageV1Schema,
	SkillHubOwnedVersionQueryV1Schema,
	SkillHubVersionDetailV1Schema,
	skillHubVersionBodyMaxBytesV1,
} from "./skill-hub-version-detail.ts";

const version = {
	schemaVersion: 1,
	skillId: "skill-a",
	skillVersionId: "version-a",
	name: "summary",
	provider: "my_library",
	version: "1.0.0",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	visibility: "PRIVATE",
	state: "rejected",
};
const detail = {
	...version,
	ownerId: "owner-a",
	installation: { state: "not_installed" },
	content: {
		state: "available",
		body: "# summary\n",
		bodyTruncated: false,
		resources: [
			{ path: "references/info.txt", kind: "reference", sizeBytes: 8 },
		],
	},
};

describe("Skill Hub version detail contract", () => {
	it("accepts every lifecycle state, bounded text content and the user's installation", () => {
		for (const state of ["published", "pending_review", "rejected", "revoked"])
			expect(
				SkillHubVersionDetailV1Schema.parse({ ...detail, state }).state,
			).toBe(state);
		expect(
			SkillHubVersionDetailV1Schema.parse({
				...detail,
				installation: { state: "installed", installationId: "install-a" },
				content: { state: "unavailable" },
			}).content,
		).toEqual({ state: "unavailable" });
		expect(
			SkillHubVersionDetailV1Schema.parse({
				...detail,
				content: {
					...detail.content,
					body: "x".repeat(skillHubVersionBodyMaxBytesV1),
					bodyTruncated: true,
				},
			}).content,
		).toMatchObject({ bodyTruncated: true });
	});

	it.each([
		["object storage location", { packageObjectVersion: "object-a" }],
		["review reason", { reviewReason: "private-review-text" }],
		["unknown state", { state: "draft" }],
		["unbounded owner", { ownerId: "../owner" }],
		[
			"another principal's installation",
			{
				installation: {
					state: "installed",
					installationId: "install-a",
					principalId: "other-user",
				},
			},
		],
		[
			"unbounded body",
			{
				content: {
					...detail.content,
					body: "x".repeat(skillHubVersionBodyMaxBytesV1 + 1),
				},
			},
		],
		[
			"resource content",
			{
				content: {
					...detail.content,
					resources: [
						{
							path: "scripts/run.sh",
							kind: "script",
							sizeBytes: 4,
							content: "echo",
						},
					],
				},
			},
		],
		[
			"escaping resource path",
			{
				content: {
					...detail.content,
					resources: [{ path: "../secret", kind: "file", sizeBytes: 1 }],
				},
			},
		],
		[
			"partial unavailable content",
			{ content: { state: "unavailable", body: "# summary" } },
		],
	])("rejects %s", (_label, change) => {
		expect(
			SkillHubVersionDetailV1Schema.safeParse({ ...detail, ...change }).success,
		).toBe(false);
	});

	it("pages the owner's versions in any state without extra fields", () => {
		expect(
			SkillHubOwnedVersionPageV1Schema.parse({
				items: [version, { ...version, state: "pending_review" }],
				nextCursor: null,
			}).items,
		).toHaveLength(2);
		expect(
			SkillHubOwnedVersionPageV1Schema.safeParse({
				items: [{ ...version, ownerId: "owner-a" }],
				nextCursor: null,
			}).success,
		).toBe(false);
		expect(SkillHubOwnedVersionQueryV1Schema.parse({ limit: "20" }).limit).toBe(
			20,
		);
		for (const query of [{ limit: "0" }, { limit: "101" }, { owner: "a" }])
			expect(SkillHubOwnedVersionQueryV1Schema.safeParse(query).success).toBe(
				false,
			);
	});
});
