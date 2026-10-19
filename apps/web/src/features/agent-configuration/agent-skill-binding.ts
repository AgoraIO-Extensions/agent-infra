import type {
	AgentProjectionV2,
	SkillHubAgentBindingCommandV1,
	SkillHubAgentBindingStatusV1,
} from "../../pilot/generated-v2/types.gen.js";

/**
 * Agent 维度的 Skill 绑定（O-02）：服务端绑定状态 + Runtime 装配摘要 → 四阶段展示，以及
 * 写入时的完整集合组装。这里只放纯函数。
 */

export type SkillBindingStatus = SkillHubAgentBindingStatusV1;
export type RuntimeSkill = NonNullable<
	AgentProjectionV2["capabilities"]["skills"]
>[number];
type SkillGrant = SkillHubAgentBindingCommandV1["bindings"][number]["grant"];

export const skillBindingStageLabels = [
	"固定版本绑定",
	"内容同步",
	"装配确认",
	"对话可用",
] as const;

export type SkillStageState = "完成" | "进行中" | "等待" | "失败" | "未开始";

export type SkillBindingStage = {
	readonly label: (typeof skillBindingStageLabels)[number];
	readonly state: SkillStageState;
	readonly current: boolean;
	readonly failed: boolean;
};

export type SkillBindingView = {
	readonly chip: {
		readonly label: "等待确认" | "对话可用" | "同步失败" | "版本已撤销";
		readonly tone: "gray" | "red";
	};
	/** 撤销的版本不显示阶段。 */
	readonly stages: readonly SkillBindingStage[] | null;
	readonly error?: string;
	/** 已同步、已装配且出现在 Runtime 装配摘要中：可在对话中选择。 */
	readonly usable: boolean;
	/** 仍可能前进的中间态，页面据此轮询。 */
	readonly settling: boolean;
};

function stages(
	states: readonly SkillStageState[],
	currentIndex: number | null,
): SkillBindingStage[] {
	return skillBindingStageLabels.map((label, index) => ({
		label,
		state: states[index] ?? "未开始",
		current: currentIndex === index,
		failed: states[index] === "失败",
	}));
}

/**
 * Runtime 是否已装配这个绑定：只有 `capabilities.skills` 中同名且包摘要一致才算，
 * 不在没有回读证据时显示「对话可用」（待确认 3 的默认规则）。
 */
export function isSkillBindingAssembled(
	binding: SkillBindingStatus,
	runtimeSkills: readonly RuntimeSkill[] | undefined,
) {
	return (runtimeSkills ?? []).some(
		(skill) =>
			skill.name === binding.skillName &&
			skill.packageDigest === binding.skillVersion.packageDigest,
	);
}

export function skillBindingView(
	binding: SkillBindingStatus,
	runtimeSkills: readonly RuntimeSkill[] | undefined,
): SkillBindingView {
	switch (binding.state) {
		case "pending_sync":
			return {
				chip: { label: "等待确认", tone: "gray" },
				stages: stages(["完成", "等待", "未开始", "未开始"], 1),
				usable: false,
				settling: true,
			};
		case "synced":
			return isSkillBindingAssembled(binding, runtimeSkills)
				? {
						chip: { label: "对话可用", tone: "gray" },
						stages: stages(["完成", "完成", "完成", "完成"], null),
						usable: true,
						settling: false,
					}
				: {
						chip: { label: "等待确认", tone: "gray" },
						stages: stages(["完成", "完成", "完成", "进行中"], 3),
						usable: false,
						settling: true,
					};
		case "failed":
			// failureReason 是否可直接展示待确认，确认前只给固定文案。
			return {
				chip: { label: "同步失败", tone: "red" },
				stages: stages(["完成", "失败", "未开始", "未开始"], 1),
				error: "内容同步失败，这个版本不会在对话中提供。",
				usable: false,
				settling: false,
			};
		case "revoked":
			return {
				chip: { label: "版本已撤销", tone: "red" },
				stages: null,
				error: "新的调用已被阻止，已保存的执行记录保持原版本。",
				usable: false,
				settling: false,
			};
	}
}

/** 新绑定使用最小授权：不额外授予工具、Connection、文件或网络权限，脚本禁用（待确认 6）。 */
export function minimalSkillGrant(): SkillGrant {
	return {
		schemaVersion: 1,
		tools: [],
		connections: [],
		fileRoots: [],
		networkOrigins: [],
		scripts: false,
	};
}

/** 卡片上的授权摘要；不显示内部 ID。 */
export function skillGrantSummary(grant: SkillGrant) {
	const parts = [
		grant.tools.length ? `${grant.tools.length} 个工具` : "",
		grant.connections.length ? `${grant.connections.length} 个 Connection` : "",
		grant.fileRoots.length ? `${grant.fileRoots.length} 个文件范围` : "",
		grant.networkOrigins.length
			? `${grant.networkOrigins.length} 个网络来源`
			: "",
	].filter(Boolean);
	return `${parts.length ? `授予 ${parts.join("、")}` : "不额外授予工具、Connection、文件或网络权限"} · 脚本禁用`;
}

export type SkillBindingCandidate = {
	readonly skillVersionId: string;
	readonly skillName: string;
};

/**
 * 绑定写入是完整集合：保留现有项（版本与授权不变），同名 Skill 已绑定其他版本时替换该项，
 * 否则追加新项。撤销的版本不再是已发布版本，服务端不会接受，所以不带回。
 * 同一版本已绑定时返回 null，页面不发请求。
 */
export function nextSkillBindingCollection(
	bindings: readonly SkillBindingStatus[],
	candidate: SkillBindingCandidate,
): SkillHubAgentBindingCommandV1["bindings"] | null {
	const active = bindings.filter((binding) => binding.state !== "revoked");
	if (
		active.some(
			(binding) =>
				binding.skillVersion.skillVersionId === candidate.skillVersionId,
		)
	)
		return null;
	const replaced = active.some(
		(binding) => binding.skillName === candidate.skillName,
	);
	const next = active.map((binding) =>
		binding.skillName === candidate.skillName
			? { skillVersionId: candidate.skillVersionId, grant: binding.grant }
			: {
					skillVersionId: binding.skillVersion.skillVersionId,
					grant: binding.grant,
				},
	);
	return replaced
		? next
		: [
				...next,
				{
					skillVersionId: candidate.skillVersionId,
					grant: minimalSkillGrant(),
				},
			];
}
