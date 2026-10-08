import { describe, expect, it } from "vitest";
import type { SkillHubVersionV1 } from "./skill-hub.js";
import {
	canInstallSkillHubVersionV1,
	canViewSkillHubVersionV1,
	parseSkillHubInstallationCommandV1,
} from "./skill-hub-installation.js";

const version = (
	visibility: SkillHubVersionV1["visibility"],
): SkillHubVersionV1 => ({
	schemaVersion: 1,
	skillId: "skill-a",
	skillVersionId: "version-a",
	ownerId: "owner-a",
	visibility,
	provider: "my_library",
	version: "1.0.0",
	packageObjectVersion: "object-a",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	state: "published",
	needUpgrade: false,
	reviewedBy: "owner-a",
	reviewReason: null,
	revokedAt: null,
});
const actor = (
	userId: string,
	organizationIds = ["org-a"],
	isAdministrator = false,
) => ({
	schemaVersion: 1 as const,
	userId,
	accountStatus: "active" as const,
	organizationIds,
	isAdministrator,
});

describe("Skill Hub installation authorization", () => {
	it("accepts only strict installation commands", () => {
		expect(
			parseSkillHubInstallationCommandV1({
				principalType: "user",
				principalId: "owner-a",
				skillVersionId: "version-a",
			}),
		).toEqual({
			principalType: "user",
			principalId: "owner-a",
			skillVersionId: "version-a",
		});
		expect(() =>
			parseSkillHubInstallationCommandV1({
				principalType: "user",
				principalId: "owner-a",
				skillVersionId: "version-a",
				verified: true,
			}),
		).toThrow();
	});

	it.each([
		["PRIVATE", "owner-a", true],
		["PRIVATE", "member", false],
		["MEMBER", "member", true],
		["ORGANIZATION", "owner-a", true],
		["MARKET", "member", true],
	] as const)(
		"applies %s visibility and install ownership",
		(visibility, userId, expected) => {
			const current = actor(userId);
			const target =
				visibility === "ORGANIZATION"
					? {
							principalType: "organization" as const,
							principalId: "org-a",
							skillVersionId: "version-a",
						}
					: {
							principalType: "user" as const,
							principalId: userId,
							skillVersionId: "version-a",
						};
			expect(
				canViewSkillHubVersionV1(
					version(visibility),
					current,
					visibility === "ORGANIZATION" ? "org-a" : null,
				),
			).toBe(expected);
			expect(
				canInstallSkillHubVersionV1(
					version(visibility),
					target,
					current,
					visibility === "ORGANIZATION" ? "org-a" : null,
				),
			).toBe(expected);
		},
	);

	it("rejects revoked and inactive versions before installation", () => {
		const revoked = { ...version("MARKET"), state: "revoked" as const };
		const disabled = { ...actor("member"), accountStatus: "disabled" as const };
		const command = {
			principalType: "user" as const,
			principalId: "member",
			skillVersionId: "version-a",
		};
		expect(canViewSkillHubVersionV1(revoked, actor("member"), null)).toBe(
			false,
		);
		expect(
			canInstallSkillHubVersionV1(version("MARKET"), command, disabled),
		).toBe(false);
	});

	it("does not cross-install an organization version into another member organization", () => {
		const command = {
			principalType: "organization" as const,
			principalId: "org-b",
			skillVersionId: "version-a",
		};
		const memberOfBoth = actor("member", ["org-a", "org-b"]);
		expect(
			canInstallSkillHubVersionV1(
				version("ORGANIZATION"),
				command,
				memberOfBoth,
				"org-a",
			),
		).toBe(false);
	});
});
