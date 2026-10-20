import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import {
	SkillFileEntryV1Schema,
	SkillVersionRefV1Schema,
	SkillVisibilityV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

// 版本详情与本人版本目录：已发布目录与原版本读取（skill-hub-read.ts）保持不变。
// 投影不含对象存储位置、审核原因、资源内容或运行态。
const versionId = SkillVersionRefV1Schema.shape.skillVersionId;
const versionMetadata = SkillVersionRefV1Schema.omit({
	packageObjectVersion: true,
}).extend({
	name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	visibility: SkillVisibilityV1Schema,
	/** 非 published 状态只会出现在发布者本人的读取结果中。 */
	state: z.enum(["published", "pending_review", "rejected", "revoked"]),
});

/** SKILL.md 正文按 UTF-8 字节的上限；超出部分不返回。 */
export const skillHubVersionBodyMaxBytesV1 = 65_536;

export const SkillHubOwnedVersionQueryV1Schema = z.strictObject({
	cursor: versionId.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const SkillHubOwnedVersionV1Schema = versionMetadata;
export const SkillHubOwnedVersionPageV1Schema = z.strictObject({
	items: z.array(SkillHubOwnedVersionV1Schema).max(100),
	nextCursor: versionId.nullable(),
});

const resource = z.strictObject({
	path: SkillFileEntryV1Schema.shape.path,
	/** 按包内顶层目录归类：scripts/、references/、assets/，其余为 file。 */
	kind: z.enum(["script", "reference", "asset", "file"]),
	sizeBytes: z.number().int().nonnegative(),
});
const content = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("available"),
		/** 以文本返回的 SKILL.md 开头部分；调用方只能按纯文本显示。 */
		body: z.string().max(skillHubVersionBodyMaxBytesV1),
		bodyTruncated: z.boolean(),
		/** 除 SKILL.md 外的包内文件清单，不含内容。 */
		resources: z.array(resource).max(1999),
	}),
	z.strictObject({ state: z.literal("unavailable") }),
]);
const installation = z.discriminatedUnion("state", [
	z.strictObject({
		state: z.literal("installed"),
		installationId: OpaqueIdV1Schema,
	}),
	z.strictObject({ state: z.literal("not_installed") }),
]);
export const SkillHubVersionDetailV1Schema = versionMetadata.extend({
	/** 发布者；显示名由界面按目录读取。 */
	ownerId: versionId,
	/** 只反映当前用户本人（principalType user）的安装。 */
	installation,
	content,
});
export type SkillHubOwnedVersionV1 = z.infer<
	typeof SkillHubOwnedVersionV1Schema
>;
export type SkillHubOwnedVersionPageV1 = z.infer<
	typeof SkillHubOwnedVersionPageV1Schema
>;
export type SkillHubVersionDetailV1 = z.infer<
	typeof SkillHubVersionDetailV1Schema
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
export const skillHubVersionDetailOpenApiPathsV1 = {
	"/api/v2/skills/owned-versions": {
		get: {
			operationId: "listOwnedSkillHubVersionsV1",
			security: [{ PlatformSession: [] }],
			requestParams: { query: SkillHubOwnedVersionQueryV1Schema },
			responses: {
				"200": response(
					"The current user's Skill versions in every state",
					SkillHubOwnedVersionPageV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v2/skills/versions/{skillVersionId}/detail": {
		get: {
			operationId: "readSkillHubVersionDetailV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: z.strictObject({ skillVersionId: versionId }) },
			responses: {
				"200": response(
					"Visible Skill version with bounded content and installation state",
					SkillHubVersionDetailV1Schema,
				),
				...errors,
				"404": response("Resource is unavailable", PilotProtocolErrorV1Schema),
			},
		},
	},
} as const;
export const skillHubVersionDetailSchemasV1 = {
	SkillHubOwnedVersionV1: SkillHubOwnedVersionV1Schema,
	SkillHubOwnedVersionPageV1: SkillHubOwnedVersionPageV1Schema,
	SkillHubVersionDetailV1: SkillHubVersionDetailV1Schema,
};
