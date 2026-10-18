import type { ChipTone } from "@/lib/status-tone";
import type {
	SkillHubPublicationVersionV1,
	SkillHubVersionMetadataV1,
} from "../../pilot/generated-v2/types.gen.js";

/** 三条 Skill 路由共用的来源、范围与版本状态文案；页面不直接显示英文枚举。 */
export const skillHubProviderLabels = {
	system: "平台预置",
	my_library: "我的库",
	market: "内部市场",
	clawhub: "ClawHub",
	skillhub: "SkillHub",
	npx: "npx",
	github: "GitHub",
} satisfies Record<SkillHubVersionMetadataV1["provider"], string>;

/**
 * 发布范围。MEMBER 在服务端对全部在职成员可见，契约也没有成员名单；
 * 设计稿的「指定成员」会误导发布者，产品确认前保持「成员」。
 */
export const skillHubVisibilityLabels = {
	PRIVATE: "仅自己",
	MEMBER: "成员",
	ORGANIZATION: "组织共享",
	MARKET: "内部市场",
} satisfies Record<SkillHubVersionMetadataV1["visibility"], string>;

export type SkillHubVersionState = SkillHubPublicationVersionV1["state"];

export const skillHubVersionStateLabels = {
	published: "已发布",
	pending_review: "待审核",
	rejected: "已驳回",
	revoked: "已撤销",
} satisfies Record<SkillHubVersionState, string>;

/** 与设计 skillBadge 一致：已发布为灰色，待审核琥珀，驳回与撤销为红色。 */
export const skillHubVersionStateTones = {
	published: "gray",
	pending_review: "amber",
	rejected: "red",
	revoked: "red",
} satisfies Record<SkillHubVersionState, ChipTone>;

const semverPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** 按 semver 比较版本号；任一方无法解析时按字符串比较。返回值同 Array.sort。 */
export function compareSkillVersions(left: string, right: string): number {
	const a = semverPattern.exec(left);
	const b = semverPattern.exec(right);
	if (!a || !b) return left < right ? -1 : left > right ? 1 : 0;
	for (const index of [1, 2, 3]) {
		const difference = Number(a[index]) - Number(b[index]);
		if (difference !== 0) return difference;
	}
	// 带预发布标识的版本低于同号正式版本。
	if (a[4] === b[4]) return 0;
	if (a[4] === undefined) return 1;
	if (b[4] === undefined) return -1;
	return a[4] < b[4] ? -1 : 1;
}

/** 同一 Skill 的版本按版本号从高到低排列。 */
export function versionsOfSkill<T extends { skillId: string; version: string }>(
	versions: readonly T[],
	skillId: string,
): T[] {
	return versions
		.filter((version) => version.skillId === skillId)
		.sort((a, b) => compareSkillVersions(b.version, a.version));
}

/** 一个 Skill 一行：取其版本号最高的版本，行顺序沿用服务端返回的首次出现顺序。 */
export function latestVersionPerSkill<
	T extends { skillId: string; version: string },
>(versions: readonly T[]): T[] {
	const latest = new Map<string, T>();
	for (const version of versions) {
		const current = latest.get(version.skillId);
		if (!current || compareSkillVersions(version.version, current.version) > 0)
			latest.set(version.skillId, version);
	}
	return [...latest.values()];
}
