import type { AgentManagementActorContextV1 } from "./agent-management.js";
import type { SkillHubVersionV1 } from "./skill-hub.js";
import {
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";
import type { SkillHubVersionContentV1 } from "./skill-hub-version-detail.js";

/** 待审队列的一页查询；游标是上一页最后一个版本，按提交时间与版本 ID 继续。 */
export type SkillHubReviewQueueQueryV1 = Readonly<{
	cursor?: string;
	limit: number;
}>;

/** Store 回读的待审版本，附父项目名称、ORGANIZATION 目标组织与提交时间。 */
export type SkillHubPendingReviewVersionV1 = SkillHubVersionV1 &
	Readonly<{
		name: string;
		organizationId: string | null;
		submittedAt: string;
	}>;

export function parseSkillHubReviewQueueQueryV1(query: {
	readonly cursor?: unknown;
	readonly limit?: unknown;
}): SkillHubReviewQueueQueryV1 {
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

/** 只投影仍待审的共享版本；不符合不变量的行按依赖不可用处理，不降级显示。 */
function projectSkillHubReviewQueueItemV1(
	version: SkillHubPendingReviewVersionV1,
) {
	if (
		version.state !== "pending_review" ||
		version.visibility === "PRIVATE" ||
		(version.visibility === "ORGANIZATION") !==
			(version.organizationId !== null)
	)
		throw new SkillHubOperationErrorV1("unavailable");
	return {
		schemaVersion: version.schemaVersion,
		skillId: version.skillId,
		skillVersionId: version.skillVersionId,
		name: version.name,
		provider: version.provider,
		version: version.version,
		packageDigest: version.packageDigest,
		manifestDigest: version.manifestDigest,
		signatureDigest: version.signatureDigest,
		visibility: version.visibility,
		organizationId: version.organizationId,
		state: version.state,
		ownerId: version.ownerId,
		submittedAt: version.submittedAt,
	};
}

export function pageSkillHubReviewQueueV1(page: {
	readonly versions: readonly SkillHubPendingReviewVersionV1[];
	readonly nextCursor: string | null;
}) {
	return {
		items: page.versions.map(projectSkillHubReviewQueueItemV1),
		nextCursor: page.nextCursor,
	};
}

/**
 * 审核正文入口的可读性（#3046）：只有当前有效的系统管理员，只限审核队列中仍待审核的
 * 共享版本（ORGANIZATION 须有目标组织），且不是调用者本人发布的。与版本详情的
 * canViewSkillHubVersionDetailV1 相互独立，不放宽详情、目录、安装或绑定的可见性。
 */
export function canReadSkillHubReviewContentV1(
	version: SkillHubVersionV1,
	actor: AgentManagementActorContextV1,
	organizationId: string | null,
): boolean {
	return (
		actor.accountStatus === "active" &&
		actor.isAdministrator &&
		version.state === "pending_review" &&
		version.visibility !== "PRIVATE" &&
		(version.visibility !== "ORGANIZATION" || organizationId !== null) &&
		version.ownerId !== actor.userId
	);
}

/** 审核正文投影只含契约版本、版本 ID 与内容；内容由版本详情的同一实现生成。 */
export function projectSkillHubReviewContentV1(input: {
	readonly version: SkillHubVersionV1;
	readonly content: SkillHubVersionContentV1;
}) {
	return {
		schemaVersion: input.version.schemaVersion,
		skillVersionId: input.version.skillVersionId,
		content: input.content,
	};
}
