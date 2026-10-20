import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import {
	SkillVersionRefV1Schema,
	SkillVisibilityV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";
import { SkillHubPublicationResponseV1Schema } from "./skill-hub-publication.ts";

// 网页编辑的 Skill 项目内容与网页发布（#2906，工程 Spec §11.6）：内容是项目的可变草稿，
// 发布由服务端打包、扫描、签名并生成固定版本；浏览器不提交对象版本、摘要、签名或来源。
// 已发布的项目、版本登记与导入接口保持不变。

/** 网页项目内容上限：低于包上限，并受 1 MiB JSON 请求上限约束。 */
export const skillHubProjectContentLimitsV1 = {
	maxFiles: 100,
	maxFileBytes: 262_144,
	maxTotalBytes: 524_288,
} as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** 根目录 SKILL.md，其余文件只能位于 scripts/、references/、assets/ 下；不允许 . 或 .. 段。 */
const projectFilePath = z
	.string()
	.min(1)
	.max(512)
	.regex(
		/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:SKILL\.md|(?:scripts|references|assets)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/,
	);
const base64Content = z
	.string()
	.max(Math.ceil(skillHubProjectContentLimitsV1.maxFileBytes / 3) * 4)
	.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const utf8File = z.strictObject({
	path: projectFilePath,
	encoding: z.literal("utf8"),
	/** 文本内容；按 UTF-8 字节计的上限由服务端核对。 */
	content: z.string().max(skillHubProjectContentLimitsV1.maxFileBytes),
});
const base64File = z.strictObject({
	path: projectFilePath,
	encoding: z.literal("base64"),
	content: base64Content,
});
const projectFile = z.discriminatedUnion("encoding", [utf8File, base64File]);
const sizeBytes = z
	.number()
	.int()
	.min(0)
	.max(skillHubProjectContentLimitsV1.maxFileBytes);
const storedFile = z.discriminatedUnion("encoding", [
	utf8File.extend({ sizeBytes }),
	base64File.extend({ sizeBytes }),
]);
const revision = z.number().int().min(0).max(2_147_483_647);

export const SkillHubProjectContentUpdateV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	/** 编辑时读取到的修订号；尚未保存过内容时为 0。修订已变化时返回冲突。 */
	baseRevision: revision,
	files: z
		.array(projectFile)
		.min(1)
		.max(skillHubProjectContentLimitsV1.maxFiles),
});
export const SkillHubProjectContentV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	projectId: OpaqueIdV1Schema,
	/** 0 表示还没有保存过内容。 */
	revision,
	contentDigest: sha256.nullable(),
	fileCount: z
		.number()
		.int()
		.min(0)
		.max(skillHubProjectContentLimitsV1.maxFiles),
	totalBytes: z
		.number()
		.int()
		.min(0)
		.max(skillHubProjectContentLimitsV1.maxTotalBytes),
	updatedAt: Rfc3339TimestampV1Schema.nullable(),
	files: z.array(storedFile).max(skillHubProjectContentLimitsV1.maxFiles),
});
export const SkillHubProjectContentSaveResponseV1Schema = z.strictObject({
	replayed: z.boolean(),
	projectId: OpaqueIdV1Schema,
	revision: revision.min(1),
	contentDigest: sha256,
	fileCount: z
		.number()
		.int()
		.min(1)
		.max(skillHubProjectContentLimitsV1.maxFiles),
	totalBytes: z
		.number()
		.int()
		.min(1)
		.max(skillHubProjectContentLimitsV1.maxTotalBytes),
	updatedAt: Rfc3339TimestampV1Schema,
});
export const SkillHubProjectPublicationRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	/** 要发布的内容修订；必须等于项目当前修订。 */
	contentRevision: revision.min(1),
	version: SkillVersionRefV1Schema.shape.version,
	visibility: SkillVisibilityV1Schema,
});
export type SkillHubProjectContentV1 = z.infer<
	typeof SkillHubProjectContentV1Schema
>;
export type SkillHubProjectContentUpdateV1 = z.infer<
	typeof SkillHubProjectContentUpdateV1Schema
>;
export type SkillHubProjectContentSaveResponseV1 = z.infer<
	typeof SkillHubProjectContentSaveResponseV1Schema
>;
export type SkillHubProjectPublicationRequestV1 = z.infer<
	typeof SkillHubProjectPublicationRequestV1Schema
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
	"404": response("Resource is unavailable", PilotProtocolErrorV1Schema),
	"409": response(
		"Request conflicts with current state",
		PilotProtocolErrorV1Schema,
	),
	"503": response("Dependency unavailable", PilotProtocolErrorV1Schema),
};
const projectPath = z.strictObject({ projectId: OpaqueIdV1Schema });
const idempotency = z.strictObject({
	"Idempotency-Key": IdempotencyKeyV1Schema,
});
export const skillHubProjectContentOpenApiPathsV1 = {
	"/api/v2/skills/projects/{projectId}/content": {
		get: {
			operationId: "readSkillHubProjectContentV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: projectPath },
			responses: {
				"200": response(
					"The owner's current Skill project content",
					SkillHubProjectContentV1Schema,
				),
				"400": errors["400"],
				"401": errors["401"],
				"403": errors["403"],
				"404": errors["404"],
				"503": errors["503"],
			},
		},
		put: {
			operationId: "saveSkillHubProjectContentV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: projectPath, header: idempotency },
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: SkillHubProjectContentUpdateV1Schema },
				},
			},
			responses: {
				"200": response(
					"Skill project content saved or replayed",
					SkillHubProjectContentSaveResponseV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v2/skills/projects/{projectId}/versions": {
		post: {
			operationId: "publishSkillHubProjectVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: projectPath, header: idempotency },
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: SkillHubProjectPublicationRequestV1Schema,
					},
				},
			},
			responses: {
				"201": response(
					"Skill version packaged, admitted and registered",
					SkillHubPublicationResponseV1Schema,
				),
				"200": response(
					"Replayed Skill project publication",
					SkillHubPublicationResponseV1Schema,
				),
				...errors,
			},
		},
	},
} as const;
export const skillHubProjectContentSchemasV1 = {
	SkillHubProjectContentV1: SkillHubProjectContentV1Schema,
	SkillHubProjectContentUpdateV1: SkillHubProjectContentUpdateV1Schema,
	SkillHubProjectContentSaveResponseV1:
		SkillHubProjectContentSaveResponseV1Schema,
	SkillHubProjectPublicationRequestV1:
		SkillHubProjectPublicationRequestV1Schema,
};
