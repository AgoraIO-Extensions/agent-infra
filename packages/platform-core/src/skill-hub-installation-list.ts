import type { SkillHubVersionV1 } from "./skill-hub.js";
import type { SkillHubInstallationV1 } from "./skill-hub-installation.js";
import {
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";

/** 「我的安装」的一页查询；游标是上一页最后一个安装记录 ID。 */
export type SkillHubInstallationQueryV1 = Readonly<{
	cursor?: string;
	limit: number;
}>;

export function parseSkillHubInstallationQueryV1(query: {
	readonly cursor?: unknown;
	readonly limit?: unknown;
}): SkillHubInstallationQueryV1 {
	const limit = query.limit ?? 50;
	if (
		typeof limit !== "number" ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 100
	)
		throw new SkillHubOperationErrorV1("invalid_input");
	return Object.freeze({
		limit,
		...(query.cursor === undefined
			? {}
			: { cursor: parseSkillHubIdV1(query.cursor) }),
	});
}

/**
 * Store 读出的一条本人安装。version 只在当前主体按版本详情规则可见时给出，
 * 否则为 null，由投影标记为不可用。
 */
export type SkillHubInstallationListEntryV1 = Readonly<{
	installation: SkillHubInstallationV1;
	version: (SkillHubVersionV1 & { readonly name: string }) | null;
}>;

/**
 * 只投影请求者本人 user 主体、仍处于 installed 的安装；混入其他主体、其他状态或
 * 与安装不对应的版本时按依赖不可用失败关闭。
 */
export function pageSkillHubInstallationsV1(
	page: {
		readonly entries: readonly SkillHubInstallationListEntryV1[];
		readonly nextCursor: string | null;
	},
	userId: string,
) {
	return {
		items: page.entries.map(({ installation, version }) => {
			if (
				installation.principalType !== "user" ||
				installation.principalId !== userId ||
				installation.state !== "installed" ||
				(version !== null &&
					version.skillVersionId !== installation.skillVersionId)
			)
				throw new SkillHubOperationErrorV1("unavailable");
			return {
				installationId: installation.installationId,
				skillVersionId: installation.skillVersionId,
				needUpgrade: installation.needUpgrade,
				installedAt: installation.installedAt,
				updatedAt: installation.updatedAt,
				// 安装只接受已发布版本，之后只可能被撤销；其他状态不应出现，按不可见处理。
				version:
					version &&
					(version.state === "published" || version.state === "revoked")
						? {
								access: "visible" as const,
								skillId: version.skillId,
								name: version.name,
								version: version.version,
								provider: version.provider,
								visibility: version.visibility,
								state: version.state,
							}
						: { access: "unavailable" as const },
			};
		}),
		nextCursor: page.nextCursor,
	};
}
