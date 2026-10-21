import { z } from "zod";
import { Rfc3339TimestampV1Schema } from "../index.ts";
import {
	SkillVersionRefV1Schema,
	SkillVisibilityV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";
import { SkillHubVersionContentV1Schema } from "./skill-hub-version-detail.ts";

// 系统管理员的待审队列：只含审核所需的有界 metadata，不含对象存储位置、审核原因或运行态。
const versionId = SkillVersionRefV1Schema.shape.skillVersionId;
export const SkillHubReviewQueueQueryV1Schema = z.strictObject({
	cursor: versionId.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const SkillHubReviewQueueItemV1Schema = SkillVersionRefV1Schema.omit({
	packageObjectVersion: true,
}).extend({
	name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	/** 只有共享发布需要审核。 */
	visibility: SkillVisibilityV1Schema.exclude(["PRIVATE"]),
	/** ORGANIZATION 范围的目标组织；其他范围为 null。 */
	organizationId: versionId.nullable(),
	state: z.literal("pending_review"),
	/** 发布者；界面据此解析显示名并隐藏自审入口，服务端仍独立拒绝自审。 */
	ownerId: versionId,
	submittedAt: Rfc3339TimestampV1Schema,
});
export const SkillHubReviewQueuePageV1Schema = z.strictObject({
	items: z.array(SkillHubReviewQueueItemV1Schema).max(100),
	nextCursor: versionId.nullable(),
});
/**
 * 审核正文（#3046）：系统管理员读取他人仍待审核的共享版本。正文上限、截断标记与资源清单
 * 沿用版本详情；不含对象存储位置、审核原因、资源内容或安装状态。
 */
export const SkillHubReviewContentV1Schema = z.strictObject({
	schemaVersion: SkillVersionRefV1Schema.shape.schemaVersion,
	skillVersionId: versionId,
	content: SkillHubVersionContentV1Schema,
});
export type SkillHubReviewQueueItemV1 = z.infer<
	typeof SkillHubReviewQueueItemV1Schema
>;
export type SkillHubReviewQueuePageV1 = z.infer<
	typeof SkillHubReviewQueuePageV1Schema
>;
export type SkillHubReviewContentV1 = z.infer<
	typeof SkillHubReviewContentV1Schema
>;

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});
const errors = {
	"400": response("Invalid request", PilotProtocolErrorV1Schema),
	"401": response("Authentication required", PilotProtocolErrorV1Schema),
	"403": response(
		"Authorization is no longer valid",
		PilotProtocolErrorV1Schema,
	),
	"503": response("Dependency unavailable", PilotProtocolErrorV1Schema),
};
export const skillHubReviewOpenApiPathsV1 = {
	"/api/v2/skills/reviews": {
		get: {
			operationId: "listSkillHubReviewQueueV1",
			security: [{ PlatformSession: [] }],
			requestParams: { query: SkillHubReviewQueueQueryV1Schema },
			responses: {
				"200": response(
					"Skill versions waiting for administrator review",
					SkillHubReviewQueuePageV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v2/skills/reviews/{skillVersionId}/content": {
		get: {
			operationId: "readSkillHubReviewContentV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: z.strictObject({ skillVersionId: versionId }) },
			responses: {
				"200": response(
					"Bounded content of another publisher's version waiting for review",
					SkillHubReviewContentV1Schema,
				),
				...errors,
				"404": response("Resource is unavailable", PilotProtocolErrorV1Schema),
			},
		},
	},
} as const;
export const skillHubReviewSchemasV1 = {
	SkillHubReviewQueueItemV1: SkillHubReviewQueueItemV1Schema,
	SkillHubReviewQueuePageV1: SkillHubReviewQueuePageV1Schema,
	SkillHubReviewContentV1: SkillHubReviewContentV1Schema,
};
