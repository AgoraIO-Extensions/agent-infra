import type { SkillHubVersionV1 } from "./skill-hub.js";
import {
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";

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
export function projectSkillHubReviewQueueItemV1(
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
