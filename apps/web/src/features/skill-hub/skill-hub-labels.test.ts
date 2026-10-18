import { describe, expect, it } from "vitest";
import {
	compareSkillVersions,
	latestVersionPerSkill,
	skillHubProviderLabels,
	skillHubVersionStateLabels,
	skillHubVersionStateTones,
	skillHubVisibilityLabels,
	versionsOfSkill,
} from "./skill-hub-labels.js";

describe("Skill Hub labels", () => {
	it("uses the design wording for sources, scopes and version states", () => {
		expect(Object.values(skillHubProviderLabels)).toEqual([
			"平台预置",
			"我的库",
			"内部市场",
			"ClawHub",
			"SkillHub",
			"npx",
			"GitHub",
		]);
		// MEMBER 在服务端对全部在职成员可见，确认前不写「指定成员」。
		expect(skillHubVisibilityLabels).toEqual({
			PRIVATE: "仅自己",
			MEMBER: "成员",
			ORGANIZATION: "组织共享",
			MARKET: "内部市场",
		});
		expect(skillHubVersionStateLabels).toEqual({
			published: "已发布",
			pending_review: "待审核",
			rejected: "已驳回",
			revoked: "已撤销",
		});
		expect(skillHubVersionStateTones).toEqual({
			published: "gray",
			pending_review: "amber",
			rejected: "red",
			revoked: "red",
		});
	});
});

describe("Skill version ordering", () => {
	it("compares semver numerically and puts pre-releases below the release", () => {
		expect(compareSkillVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
		expect(compareSkillVersions("v2.0.0", "1.99.99")).toBeGreaterThan(0);
		expect(compareSkillVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
		expect(compareSkillVersions("1.2.0", "1.2.0")).toBe(0);
		// 无法解析时按字符串比较。
		expect(compareSkillVersions("beta", "alpha")).toBeGreaterThan(0);
	});

	it("keeps one highest version per Skill in first-seen order", () => {
		const versions = [
			{ skillId: "a", version: "1.0.0" },
			{ skillId: "b", version: "0.1.0" },
			{ skillId: "a", version: "1.10.0" },
			{ skillId: "a", version: "1.2.0" },
		];
		expect(latestVersionPerSkill(versions)).toEqual([
			{ skillId: "a", version: "1.10.0" },
			{ skillId: "b", version: "0.1.0" },
		]);
		expect(versionsOfSkill(versions, "a").map((item) => item.version)).toEqual([
			"1.10.0",
			"1.2.0",
			"1.0.0",
		]);
	});
});
