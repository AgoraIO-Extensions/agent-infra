import {
	minimalSkillGrant,
	type SkillBindingStatus,
} from "./agent-skill-binding.js";

/** 测试用：64 位十六进制摘要。 */
export function digest(seed: string) {
	return seed.repeat(64).slice(0, 64);
}

/** 测试用：生成一条契约格式的 Skill 绑定状态。 */
export function skillBinding(
	state: SkillBindingStatus["state"],
	overrides: { name?: string; versionId?: string; version?: string } = {},
): SkillBindingStatus {
	const skillName = overrides.name ?? "workspace-summary";
	const skillVersionId = overrides.versionId ?? `${skillName}-v1`;
	const base = {
		schemaVersion: 1 as const,
		agentId: "agent-pilot-1",
		agentVersion: "agent-version-1",
		skillName,
		skillVersion: {
			schemaVersion: 1 as const,
			skillId: `${skillName}-skill`,
			skillVersionId,
			version: overrides.version ?? "1.0.0",
			provider: "my_library" as const,
			packageDigest: digest("a"),
			manifestDigest: digest("b"),
			signatureDigest: digest("c"),
		},
		grant: minimalSkillGrant(),
		configurationRevision: 3,
		syncRevision: 1,
	};
	switch (state) {
		case "pending_sync":
			return { ...base, state, failureReason: null, appliedReceipt: null };
		case "failed":
			return {
				...base,
				state,
				failureReason: "internal sync detail",
				appliedReceipt: null,
			};
		case "revoked":
			return { ...base, state, failureReason: null, appliedReceipt: null };
		case "synced":
			return {
				...base,
				state,
				failureReason: null,
				appliedReceipt: {
					schemaVersion: 1,
					agentId: base.agentId,
					agentVersion: base.agentVersion,
					skillName,
					configurationRevision: 3,
					syncRevision: 1,
					skillVersionId,
					generationId: digest("d"),
					packageDigest: digest("a"),
					manifestDigest: digest("b"),
					targetPath: `.agents/skills/${skillName}`,
					readOnly: true,
				},
			};
	}
}
