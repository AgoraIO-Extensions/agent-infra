import { describe, expect, it } from "vitest";
import type { SkillHubVersionV1 } from "./skill-hub.js";
import type { SkillHubInstallationV1 } from "./skill-hub-installation.js";
import {
	pageSkillHubInstallationsV1,
	parseSkillHubInstallationQueryV1,
} from "./skill-hub-installation-list.js";
import { SkillHubOperationErrorV1 } from "./skill-hub-management.js";

const installation = (
	change: Partial<SkillHubInstallationV1> = {},
): SkillHubInstallationV1 => ({
	schemaVersion: 1,
	installationId: "install-a",
	principalType: "user",
	principalId: "user-a",
	skillVersionId: "version-a",
	state: "installed",
	needUpgrade: true,
	installedAt: "2026-10-01T08:00:00.000Z",
	updatedAt: "2026-10-02T08:00:00.000Z",
	...change,
});
const version = (
	state: SkillHubVersionV1["state"] = "published",
): SkillHubVersionV1 & { name: string } => ({
	schemaVersion: 1,
	skillId: "skill-a",
	skillVersionId: "version-a",
	ownerId: "owner-a",
	visibility: "MARKET",
	provider: "my_library",
	version: "1.0.0",
	packageObjectVersion: "object-a",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	state,
	needUpgrade: false,
	reviewedBy: null,
	reviewReason: "private review text",
	revokedAt: null,
	name: "summary",
});

describe("Skill Hub installation list (#2953)", () => {
	it("projects visible versions without object locations or review reasons", () => {
		const page = pageSkillHubInstallationsV1(
			{
				entries: [
					{ installation: installation(), version: version(), visible: true },
				],
				nextCursor: "install-a",
			},
			"user-a",
		);
		expect(page).toEqual({
			items: [
				{
					installationId: "install-a",
					skillVersionId: "version-a",
					needUpgrade: true,
					installedAt: "2026-10-01T08:00:00.000Z",
					updatedAt: "2026-10-02T08:00:00.000Z",
					version: {
						access: "visible",
						skillId: "skill-a",
						name: "summary",
						version: "1.0.0",
						provider: "my_library",
						visibility: "MARKET",
						state: "published",
					},
				},
			],
			nextCursor: "install-a",
		});
		expect(JSON.stringify(page)).not.toMatch(
			/object-a|private review text|owner-a|aaaa/,
		);
		expect(
			pageSkillHubInstallationsV1(
				{
					entries: [
						{
							installation: installation(),
							version: version("revoked"),
							visible: true,
						},
					],
					nextCursor: null,
				},
				"user-a",
			).items[0]?.version,
		).toMatchObject({ access: "visible", state: "revoked" });
	});

	it("marks versions the user can no longer view as unavailable without a name", () => {
		for (const [current, visible] of [
			[version(), false],
			[version("revoked"), false],
			[version("pending_review"), true],
			[version("rejected"), true],
		] as const)
			expect(
				pageSkillHubInstallationsV1(
					{
						entries: [
							{ installation: installation(), version: current, visible },
						],
						nextCursor: null,
					},
					"user-a",
				).items[0]?.version,
			).toEqual({ access: "unavailable" });
	});

	it.each([
		["another user's installation", { principalId: "user-b" }],
		[
			"an organization installation",
			{ principalType: "organization" as const, principalId: "user-a" },
		],
		["a removed installation", { state: "uninstalled" as const }],
		["a mismatched version", { skillVersionId: "version-b" }],
	])("fails closed for %s", (_label, change) => {
		// 不可见的版本也必须与安装对应，不能借不可见投影带过错配记录。
		for (const visible of [true, false])
			expect(() =>
				pageSkillHubInstallationsV1(
					{
						entries: [
							{
								installation: installation(change),
								version: version(),
								visible,
							},
						],
						nextCursor: null,
					},
					"user-a",
				),
			).toThrow(SkillHubOperationErrorV1);
	});

	it("parses bounded page queries", () => {
		expect(parseSkillHubInstallationQueryV1({})).toEqual({ limit: 50 });
		expect(
			parseSkillHubInstallationQueryV1({ cursor: "install-a", limit: 2 }),
		).toEqual({ cursor: "install-a", limit: 2 });
		for (const query of [
			{ limit: 0 },
			{ limit: 101 },
			{ limit: "2" },
			{ cursor: "../a" },
		])
			expect(() => parseSkillHubInstallationQueryV1(query)).toThrow(
				SkillHubOperationErrorV1,
			);
	});
});
