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

/** The package supplier supplies the fixed immutable version reference; the API never derives it from caller identity. */
export const SkillHubVersionPublicationRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	skillId: OpaqueIdV1Schema,
	skillVersionId: OpaqueIdV1Schema,
	visibility: SkillVisibilityV1Schema,
	provider: SkillProviderIdV1Schema,
	version: OpaqueIdV1Schema,
	packageObjectVersion: z
		.string()
		.min(1)
		.max(1024)
		.refine(
			(value) =>
				value !== "null" &&
				value.isWellFormed() &&
				new TextEncoder().encode(value).byteLength <= 1024,
		),
	packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
	manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	signatureDigest: z.string().regex(/^[a-f0-9]{64}$/),
	organizationId: OpaqueIdV1Schema.nullable().optional(),
});

export const SkillHubVersionReviewRequestV1Schema = z
	.strictObject({
		decision: z.enum(["approve", "reject"]),
		reason: z.string().min(1).max(1024).optional(),
	})
	.superRefine((value, context) => {
		if (value.decision === "reject" && value.reason === undefined)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["reason"],
				message: "A rejection requires a reason",
			});
	});

export const SkillHubVersionLifecycleMetadataV1Schema =
	SkillVersionRefV1Schema.omit({ packageObjectVersion: true }).extend({
		visibility: SkillVisibilityV1Schema,
		state: z.enum(["published", "pending_review", "rejected", "revoked"]),
		needUpgrade: z.boolean(),
		reviewedBy: OpaqueIdV1Schema.nullable(),
		reviewReason: z.string().max(1024).nullable(),
		revokedAt: Rfc3339TimestampV1Schema.nullable(),
	});

export const SkillHubVersionLifecycleResponseV1Schema = z.strictObject({
	replayed: z.boolean(),
	version: SkillHubVersionLifecycleMetadataV1Schema,
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
const idempotentHeader = {
	header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
};

export const skillHubPublicationOpenApiPathsV1 = {
	"/api/v2/skills/versions": {
		post: {
			operationId: "publishSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: idempotentHeader,
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: SkillHubVersionPublicationRequestV1Schema,
					},
				},
			},
			responses: {
				"201": response(
					"Skill version published",
					SkillHubVersionLifecycleResponseV1Schema,
				),
				"200": response(
					"Replayed publication",
					SkillHubVersionLifecycleResponseV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v2/skills/versions/{skillVersionId}/review": {
		post: {
			operationId: "reviewSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ skillVersionId: OpaqueIdV1Schema }),
				...idempotentHeader,
			},
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: SkillHubVersionReviewRequestV1Schema,
					},
				},
			},
			responses: {
				"201": response(
					"Skill version review recorded",
					SkillHubVersionLifecycleResponseV1Schema,
				),
				"200": response(
					"Replayed review",
					SkillHubVersionLifecycleResponseV1Schema,
				),
				...errors,
			},
		},
	},
	"/api/v2/skills/versions/{skillVersionId}/revoke": {
		post: {
			operationId: "revokeSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ skillVersionId: OpaqueIdV1Schema }),
				...idempotentHeader,
			},
			responses: {
				"201": response(
					"Skill version revoked",
					SkillHubVersionLifecycleResponseV1Schema,
				),
				"200": response(
					"Replayed revocation",
					SkillHubVersionLifecycleResponseV1Schema,
				),
				...errors,
			},
		},
	},
} as const;

export const skillHubPublicationSchemasV1 = {
	SkillHubVersionPublicationRequestV1:
		SkillHubVersionPublicationRequestV1Schema,
	SkillHubVersionReviewRequestV1: SkillHubVersionReviewRequestV1Schema,
	SkillHubVersionLifecycleMetadataV1: SkillHubVersionLifecycleMetadataV1Schema,
	SkillHubVersionLifecycleResponseV1: SkillHubVersionLifecycleResponseV1Schema,
};

export type SkillHubVersionLifecycleMetadataV1 = z.infer<
	typeof SkillHubVersionLifecycleMetadataV1Schema
>;
export type SkillHubVersionLifecycleResponseV1 = z.infer<
	typeof SkillHubVersionLifecycleResponseV1Schema
>;
