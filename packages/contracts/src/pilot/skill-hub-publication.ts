import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import {
	SkillProviderIdV1Schema,
	SkillVersionRefV1Schema,
	SkillVisibilityV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

export const SkillHubPublicationRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	skillId: OpaqueIdV1Schema,
	skillVersionId: OpaqueIdV1Schema,
	visibility: SkillVisibilityV1Schema,
	provider: SkillProviderIdV1Schema,
	version: OpaqueIdV1Schema,
	packageObjectVersion: z.string().min(1).max(1024),
	packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
	manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	signatureDigest: z.string().regex(/^[a-f0-9]{64}$/),
	organizationId: OpaqueIdV1Schema.optional(),
});

export const SkillHubPublicationVersionV1Schema = SkillVersionRefV1Schema.omit({
	packageObjectVersion: true,
}).extend({
	visibility: SkillVisibilityV1Schema,
	state: z.enum(["published", "pending_review", "rejected", "revoked"]),
	needUpgrade: z.boolean(),
	reviewedBy: OpaqueIdV1Schema.nullable(),
	reviewReason: z.string().nullable(),
	revokedAt: z.string().nullable(),
});

export const SkillHubPublicationResponseV1Schema = z.strictObject({
	replayed: z.boolean(),
	version: SkillHubPublicationVersionV1Schema,
});

export const SkillHubReviewRequestV1Schema = z.strictObject({
	decision: z.enum(["approve", "reject"]),
	reason: z.string().min(1).max(1024).optional(),
});

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

export const skillHubPublicationOpenApiPathsV1 = {
	"/api/v2/skills/versions": {
		post: {
			operationId: "publishSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: body(SkillHubPublicationRequestV1Schema),
			responses: {
				"201": {
					description: "Skill version published",
					content: {
						"application/json": { schema: SkillHubPublicationResponseV1Schema },
					},
				},
				"200": {
					description: "Replayed publication",
					content: {
						"application/json": { schema: SkillHubPublicationResponseV1Schema },
					},
				},
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
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: body(SkillHubReviewRequestV1Schema),
			responses: {
				"200": {
					description: "Review applied",
					content: {
						"application/json": { schema: SkillHubPublicationResponseV1Schema },
					},
				},
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
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			responses: {
				"200": {
					description: "Version revoked",
					content: {
						"application/json": { schema: SkillHubPublicationResponseV1Schema },
					},
				},
				...errors,
			},
		},
	},
} as const;

export const skillHubPublicationSchemasV1 = {
	SkillHubPublicationRequestV1: SkillHubPublicationRequestV1Schema,
	SkillHubPublicationVersionV1: SkillHubPublicationVersionV1Schema,
	SkillHubPublicationResponseV1: SkillHubPublicationResponseV1Schema,
	SkillHubReviewRequestV1: SkillHubReviewRequestV1Schema,
};
