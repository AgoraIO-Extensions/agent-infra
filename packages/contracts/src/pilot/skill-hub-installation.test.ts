import { describe, expect, it } from "vitest";
import {
	SkillHubInstallationListItemV1Schema,
	SkillHubInstallationPageV1Schema,
	SkillHubInstallationQueryV1Schema,
} from "./skill-hub-installation.ts";

const visible = {
	installationId: "8f1c2b8e-1d0a-4c5e-9b8f-2a7d6c5e4f3a",
	skillVersionId: "release-notes-v1",
	needUpgrade: false,
	installedAt: "2026-10-01T08:00:00Z",
	updatedAt: "2026-10-01T08:00:00Z",
	version: {
		access: "visible",
		skillId: "release-notes",
		name: "release-notes",
		version: "1.2.0",
		provider: "my_library",
		visibility: "MARKET",
		state: "published",
	},
};

describe("Skill Hub installation list contract (#2953)", () => {
	it("accepts visible published or revoked versions and an unavailable version", () => {
		for (const state of ["published", "revoked"])
			expect(
				SkillHubInstallationListItemV1Schema.parse({
					...visible,
					version: { ...visible.version, state },
				}).version,
			).toMatchObject({ access: "visible", state });
		expect(
			SkillHubInstallationListItemV1Schema.parse({
				...visible,
				version: { access: "unavailable" },
			}).version,
		).toEqual({ access: "unavailable" });
	});

	it.each([
		["the principal", { principalId: "other-user" }],
		["the principal type", { principalType: "organization" }],
		["the installation state", { state: "uninstalled" }],
		["an object storage version", { packageObjectVersion: "object-a" }],
		["a review reason", { reviewReason: "private review text" }],
	])("rejects %s on the item", (_label, change) => {
		expect(
			SkillHubInstallationListItemV1Schema.safeParse({ ...visible, ...change })
				.success,
		).toBe(false);
	});

	it.each([
		["a name for an unavailable version", { access: "unavailable", name: "x" }],
		[
			"a never installable state",
			{ ...visible.version, state: "pending_review" },
		],
		["a digest", { ...visible.version, packageDigest: "a".repeat(64) }],
		["an unbounded name", { ...visible.version, name: "../secret" }],
	])("rejects %s on the version", (_label, version) => {
		expect(
			SkillHubInstallationListItemV1Schema.safeParse({ ...visible, version })
				.success,
		).toBe(false);
	});

	it("bounds pages and the query", () => {
		expect(
			SkillHubInstallationPageV1Schema.parse({
				items: [visible],
				nextCursor: null,
			}).items,
		).toHaveLength(1);
		expect(
			SkillHubInstallationPageV1Schema.safeParse({
				items: Array.from({ length: 101 }, () => visible),
				nextCursor: null,
			}).success,
		).toBe(false);
		expect(SkillHubInstallationQueryV1Schema.parse({ limit: "20" }).limit).toBe(
			20,
		);
		for (const query of [
			{ limit: "0" },
			{ limit: "101" },
			{ principalId: "other-user" },
		])
			expect(SkillHubInstallationQueryV1Schema.safeParse(query).success).toBe(
				false,
			);
	});
});
