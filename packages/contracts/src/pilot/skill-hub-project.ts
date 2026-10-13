import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const packageName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/);
export const SkillHubProjectCreateV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	name: packageName,
	organizationId: OpaqueIdV1Schema.nullable().optional(),
});
export const SkillHubProjectUpdateV1Schema = z
	.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		name: packageName.optional(),
		organizationId: OpaqueIdV1Schema.nullable().optional(),
		status: z.enum(["active", "disabled"]).optional(),
	})
	.refine((value) => Object.keys(value).length > 1);
export const SkillHubProjectV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	projectId: OpaqueIdV1Schema,
	name: packageName,
	ownerId: OpaqueIdV1Schema,
	organizationId: OpaqueIdV1Schema.nullable(),
	status: z.enum(["active", "disabled"]),
	createdAt: Rfc3339TimestampV1Schema,
	updatedAt: Rfc3339TimestampV1Schema,
});
export const SkillHubProjectPageV1Schema = z.strictObject({
	items: z.array(SkillHubProjectV1Schema),
	nextCursor: OpaqueIdV1Schema.nullable(),
});
const body = (schema: z.ZodType) => ({
	required: true,
	content: { "application/json": { schema } },
});
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
export const skillHubProjectOpenApiPathsV1 = {
	"/api/v2/skills/projects": {
		get: {
			operationId: "listSkillHubProjectsV1",
			security: [{ PlatformSession: [] }],
			responses: {
				"200": response("Skill projects", SkillHubProjectPageV1Schema),
				...errors,
			},
		},
		post: {
			operationId: "createSkillHubProjectV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: body(SkillHubProjectCreateV1Schema),
			responses: {
				"201": response("Project created", SkillHubProjectV1Schema),
				"200": response("Replayed project", SkillHubProjectV1Schema),
				...errors,
			},
		},
	},
	"/api/v2/skills/projects/{projectId}": {
		get: {
			operationId: "readSkillHubProjectV1",
			security: [{ PlatformSession: [] }],
			requestParams: { path: z.strictObject({ projectId: OpaqueIdV1Schema }) },
			responses: {
				"200": response("Skill project", SkillHubProjectV1Schema),
				...errors,
			},
		},
		patch: {
			operationId: "updateSkillHubProjectV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ projectId: OpaqueIdV1Schema }),
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: body(SkillHubProjectUpdateV1Schema),
			responses: {
				"200": response("Project updated", SkillHubProjectV1Schema),
				...errors,
			},
		},
	},
} as const;
export const skillHubProjectSchemasV1 = {
	SkillHubProjectCreateV1: SkillHubProjectCreateV1Schema,
	SkillHubProjectUpdateV1: SkillHubProjectUpdateV1Schema,
	SkillHubProjectV1: SkillHubProjectV1Schema,
	SkillHubProjectPageV1: SkillHubProjectPageV1Schema,
};
