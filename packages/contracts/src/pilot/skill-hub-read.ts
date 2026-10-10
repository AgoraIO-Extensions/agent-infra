import { z } from "zod";
import {
	SkillVersionRefV1Schema,
	SkillVisibilityV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

// Public metadata never contains object locations or installation/runtime claims.
export const SkillHubVersionMetadataV1Schema = SkillVersionRefV1Schema.omit({
	packageObjectVersion: true,
}).extend({
	name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	visibility: SkillVisibilityV1Schema,
	state: z.literal("published"),
});
const versionId = SkillVersionRefV1Schema.shape.skillVersionId;
export const SkillHubDirectoryQueryV1Schema = z.strictObject({
	cursor: versionId.optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const SkillHubDirectoryPageV1Schema = z.strictObject({
	items: z.array(SkillHubVersionMetadataV1Schema).max(100),
	nextCursor: versionId.nullable(),
});
export type SkillHubVersionMetadataV1 = z.infer<
	typeof SkillHubVersionMetadataV1Schema
>;
export type SkillHubDirectoryPageV1 = z.infer<
	typeof SkillHubDirectoryPageV1Schema
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
	"503": response("Dependency unavailable", PilotProtocolErrorV1Schema),
};
export const skillHubReadOpenApiPathsV1 = {
	"/api/v2/skills": {
		get: {
			operationId: "listSkillHubVersionsV1",
			security: [{ PlatformSession: [] }],
			requestParams: { query: SkillHubDirectoryQueryV1Schema },
			responses: {
				"200": response(
					"Visible fixed Skill versions",
					SkillHubDirectoryPageV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v2/skills/versions/{skillVersionId}": {
		get: {
			operationId: "readSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: z.strictObject({ skillVersionId: versionId }) },
			responses: {
				"200": response(
					"Visible fixed Skill version",
					SkillHubVersionMetadataV1Schema,
				),
				...errors,
			},
		},
	},
} as const;
export const skillHubReadSchemasV1 = {
	SkillHubVersionMetadataV1: SkillHubVersionMetadataV1Schema,
	SkillHubDirectoryPageV1: SkillHubDirectoryPageV1Schema,
};
