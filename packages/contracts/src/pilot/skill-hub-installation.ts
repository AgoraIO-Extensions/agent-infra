import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import {
	SkillProviderIdV1Schema,
	SkillVersionRefV1Schema,
	SkillVisibilityV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

export const SkillHubInstallationCommandV1Schema = z.strictObject({
	principalType: z.enum(["user", "organization"]),
	principalId: OpaqueIdV1Schema,
	skillVersionId: OpaqueIdV1Schema,
});

export const SkillHubInstallationV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	installationId: OpaqueIdV1Schema,
	principalType: z.enum(["user", "organization"]),
	principalId: OpaqueIdV1Schema,
	skillVersionId: OpaqueIdV1Schema,
	state: z.enum(["installed", "uninstalled", "failed"]),
	needUpgrade: z.boolean(),
	installedAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
});

export const SkillHubInstallationResponseV1Schema = z.strictObject({
	replayed: z.boolean(),
	installation: SkillHubInstallationV1Schema,
});

// 「我的安装」：独立的版本化只读投影，只列当前会话用户（user 主体）仍处于 installed 的安装；
// 已发布的安装命令、安装记录与响应保持不变。投影不含主体、对象存储位置或审核原因。
export const SkillHubInstallationQueryV1Schema = z.strictObject({
	/** 上一页最后一个安装记录 ID。 */
	cursor: OpaqueIdV1Schema.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
const installedVersion = z.discriminatedUnion("access", [
	z.strictObject({
		access: z.literal("visible"),
		skillId: SkillVersionRefV1Schema.shape.skillId,
		name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
		version: SkillVersionRefV1Schema.shape.version,
		provider: SkillProviderIdV1Schema,
		visibility: SkillVisibilityV1Schema,
		/** 安装只接受已发布版本；之后只可能被撤销。 */
		state: z.enum(["published", "revoked"]),
	}),
	/** 版本当前对本人不可见（例如已撤销的他人版本、失去组织成员身份），不返回名称。 */
	z.strictObject({ access: z.literal("unavailable") }),
]);
export const SkillHubInstallationListItemV1Schema = z.strictObject({
	installationId: OpaqueIdV1Schema,
	skillVersionId: SkillVersionRefV1Schema.shape.skillVersionId,
	needUpgrade: z.boolean(),
	installedAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
	version: installedVersion,
});
export const SkillHubInstallationPageV1Schema = z.strictObject({
	items: z.array(SkillHubInstallationListItemV1Schema).max(100),
	nextCursor: OpaqueIdV1Schema.nullable(),
});
export type SkillHubInstallationListItemV1 = z.infer<
	typeof SkillHubInstallationListItemV1Schema
>;
export type SkillHubInstallationPageV1 = z.infer<
	typeof SkillHubInstallationPageV1Schema
>;

const body = (schema: z.ZodType) => ({
	required: true,
	content: { "application/json": { schema } },
});
const errors = {
	"400": {
		description: "Invalid request",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"401": {
		description: "Authentication required",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"403": {
		description: "Authorization is no longer valid",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"404": {
		description: "Resource is unavailable",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"409": {
		description: "Request conflicts with current state",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"503": {
		description: "Dependency unavailable",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
};
export const skillHubInstallationOpenApiPathsV1 = {
	"/api/v2/skills/installations": {
		get: {
			operationId: "listSkillHubInstallationsV1",
			security: [{ PlatformSession: [] }],
			requestParams: { query: SkillHubInstallationQueryV1Schema },
			responses: {
				"200": {
					description: "The current user's installed Skill versions",
					content: {
						"application/json": { schema: SkillHubInstallationPageV1Schema },
					},
				},
				"400": errors["400"],
				"401": errors["401"],
				"403": errors["403"],
				"503": errors["503"],
			},
		},
		post: {
			operationId: "installSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: body(SkillHubInstallationCommandV1Schema),
			responses: {
				"201": {
					description: "Installation accepted",
					content: {
						"application/json": {
							schema: SkillHubInstallationResponseV1Schema,
						},
					},
				},
				"200": {
					description: "Replayed installation",
					content: {
						"application/json": {
							schema: SkillHubInstallationResponseV1Schema,
						},
					},
				},
				...errors,
			},
		},
	},
	"/api/v2/skills/installations/{installationId}": {
		delete: {
			operationId: "uninstallSkillHubInstallationV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ installationId: OpaqueIdV1Schema }),
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			responses: {
				"200": {
					description: "Installation removed",
					content: {
						"application/json": {
							schema: SkillHubInstallationResponseV1Schema,
						},
					},
				},
				...errors,
			},
		},
	},
} as const;
export const skillHubInstallationSchemasV1 = {
	SkillHubInstallationCommandV1: SkillHubInstallationCommandV1Schema,
	SkillHubInstallationV1: SkillHubInstallationV1Schema,
	SkillHubInstallationResponseV1: SkillHubInstallationResponseV1Schema,
	SkillHubInstallationListItemV1: SkillHubInstallationListItemV1Schema,
	SkillHubInstallationPageV1: SkillHubInstallationPageV1Schema,
};
