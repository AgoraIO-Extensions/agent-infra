import { describe, expect, it } from "vitest";
import type { SkillHubVersionV1 } from "./skill-hub.js";
import { canInstallSkillHubVersionV1 } from "./skill-hub-installation.js";
import { SkillHubOperationErrorV1 } from "./skill-hub-management.js";
import {
	canViewSkillHubVersionDetailV1,
	pageSkillHubOwnedVersionsV1,
	parseSkillHubOwnedVersionQueryV1,
	projectSkillHubVersionContentV1,
	projectSkillHubVersionDetailV1,
} from "./skill-hub-version-detail.js";

const version = (
	state: SkillHubVersionV1["state"],
	visibility: SkillHubVersionV1["visibility"] = "MARKET",
): SkillHubVersionV1 & { name: string } => ({
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
	state,
	needUpgrade: false,
	reviewedBy: null,
	reviewReason: "private review text",
	revokedAt: null,
	name: "summary",
});
const actor = (
	userId: string,
	isAdministrator = false,
	accountStatus: "active" | "disabled" = "active",
) => ({
	schemaVersion: 1 as const,
	userId,
	accountStatus: accountStatus as "active",
	organizationIds: ["org-a"],
	isAdministrator,
});
const encoder = new TextEncoder();

describe("Skill Hub version detail visibility", () => {
	it("lets only the publisher read unpublished versions", () => {
		for (const state of ["pending_review", "rejected", "revoked"] as const) {
			expect(
				canViewSkillHubVersionDetailV1(version(state), actor("owner-a")),
			).toBe(true);
			// 他人（含系统管理员）、停用账号与停用项目都读不到未发布版本。
			expect(
				canViewSkillHubVersionDetailV1(version(state), actor("other")),
			).toBe(false);
			expect(
				canViewSkillHubVersionDetailV1(version(state), actor("admin", true)),
			).toBe(false);
			expect(
				canViewSkillHubVersionDetailV1(
					version(state),
					actor("owner-a", false, "disabled"),
				),
			).toBe(false);
			expect(
				canViewSkillHubVersionDetailV1(
					version(state),
					actor("owner-a"),
					null,
					"disabled",
				),
			).toBe(false);
			// 回读不等于可安装：安装仍只认已发布版本。
			expect(
				canInstallSkillHubVersionV1(
					version(state),
					{
						principalType: "user",
						principalId: "owner-a",
						skillVersionId: "version-a",
					},
					actor("owner-a"),
				),
			).toBe(false);
		}
	});

	it("keeps published visibility on the existing publication scopes", () => {
		expect(
			canViewSkillHubVersionDetailV1(version("published"), actor("other")),
		).toBe(true);
		expect(
			canViewSkillHubVersionDetailV1(
				version("published", "PRIVATE"),
				actor("other"),
			),
		).toBe(false);
		expect(
			canViewSkillHubVersionDetailV1(
				version("published", "ORGANIZATION"),
				actor("other"),
				"org-b",
			),
		).toBe(false);
	});
});

describe("Skill Hub version detail projection", () => {
	it("bounds SKILL.md by UTF-8 bytes without splitting a character and lists resources without content", () => {
		const short = projectSkillHubVersionContentV1({
			entry: encoder.encode("# 摘要\n"),
			files: [
				{ path: "SKILL.md", sizeBytes: 9 },
				{ path: "scripts/run.sh", sizeBytes: 4 },
				{ path: "references/guide.md", sizeBytes: 5 },
				{ path: "assets/logo.png", sizeBytes: 6 },
				{ path: "LICENSE", sizeBytes: 7 },
				{ path: "scripts", sizeBytes: 8 },
			],
		});
		expect(short).toEqual({
			state: "available",
			body: "# 摘要\n",
			bodyTruncated: false,
			resources: [
				{ path: "scripts/run.sh", kind: "script", sizeBytes: 4 },
				{ path: "references/guide.md", kind: "reference", sizeBytes: 5 },
				{ path: "assets/logo.png", kind: "asset", sizeBytes: 6 },
				{ path: "LICENSE", kind: "file", sizeBytes: 7 },
				{ path: "scripts", kind: "file", sizeBytes: 8 },
			],
		});
		// 65,535 个 ASCII 后接一个三字节汉字：上限落在汉字中间，退到汉字之前。
		const long = projectSkillHubVersionContentV1({
			entry: encoder.encode(`${"a".repeat(65_535)}汉${"b".repeat(10)}`),
			files: [],
		});
		expect(long.state === "available" && long.bodyTruncated).toBe(true);
		expect(long.state === "available" && long.body).toBe("a".repeat(65_535));
		const exact = projectSkillHubVersionContentV1({
			entry: encoder.encode("x".repeat(65_536)),
			files: [],
		});
		expect(exact).toMatchObject({ bodyTruncated: false });
	});

	it("projects only the requester's installation and never the review reason or object location", () => {
		const content = { state: "unavailable" } as const;
		const installation = {
			schemaVersion: 1 as const,
			installationId: "install-a",
			principalType: "user" as const,
			principalId: "owner-a",
			skillVersionId: "version-a",
			state: "installed" as const,
			needUpgrade: false,
			installedAt: "2026-10-01T00:00:00.000Z",
			updatedAt: "2026-10-01T00:00:00.000Z",
		};
		const installed = projectSkillHubVersionDetailV1({
			version: version("published"),
			installation,
			content,
		});
		expect(installed.installation).toEqual({
			state: "installed",
			installationId: "install-a",
		});
		expect(installed.ownerId).toBe("owner-a");
		expect(JSON.stringify(installed)).not.toMatch(
			/private review text|object-a/,
		);
		for (const state of ["uninstalled", "failed"] as const)
			expect(
				projectSkillHubVersionDetailV1({
					version: version("published"),
					installation: { ...installation, state },
					content,
				}).installation,
			).toEqual({ state: "not_installed" });
		expect(
			projectSkillHubVersionDetailV1({
				version: version("published"),
				installation: null,
				content,
			}).installation,
		).toEqual({ state: "not_installed" });
	});

	it("pages only the owner's versions and validates the query", () => {
		expect(
			pageSkillHubOwnedVersionsV1(
				{ versions: [version("rejected")], nextCursor: "version-a" },
				"owner-a",
			),
		).toMatchObject({
			items: [{ skillVersionId: "version-a", state: "rejected" }],
			nextCursor: "version-a",
		});
		expect(() =>
			pageSkillHubOwnedVersionsV1(
				{ versions: [version("published")], nextCursor: null },
				"other",
			),
		).toThrow(SkillHubOperationErrorV1);
		expect(parseSkillHubOwnedVersionQueryV1({})).toEqual({ limit: 50 });
		for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: "../a" }])
			expect(() => parseSkillHubOwnedVersionQueryV1(query)).toThrow(
				SkillHubOperationErrorV1,
			);
	});
});
