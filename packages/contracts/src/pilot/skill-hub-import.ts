import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import { SkillProviderIdV1Schema } from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";
import {
	SkillHubPublicationResponseV1Schema,
	SkillHubPublicationVersionV1Schema,
} from "./skill-hub-publication.ts";

export const SkillHubProviderImportRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	provider: SkillProviderIdV1Schema,
	version: OpaqueIdV1Schema,
});

export const SkillHubProviderImportResponseV1Schema =
	SkillHubPublicationResponseV1Schema;

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
		description: "Request is not authorized",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"409": {
		description: "Request conflicts with current state",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
	"503": {
		description: "Dependency is temporarily unavailable",
		content: { "application/json": { schema: PilotProtocolErrorV1Schema } },
	},
};

export const skillHubImportOpenApiPathsV1 = {
	"/api/v2/skills/imports": {
		post: {
			operationId: "importSkillHubVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: SkillHubProviderImportRequestV1Schema },
				},
			},
			responses: {
				"201": {
					description: "Skill version imported",
					content: {
						"application/json": {
							schema: SkillHubProviderImportResponseV1Schema,
						},
					},
				},
				"200": {
					description: "Replayed import",
					content: {
						"application/json": {
							schema: SkillHubProviderImportResponseV1Schema,
						},
					},
				},
				...errors,
			},
		},
	},
} as const;

export const skillHubImportSchemasV1 = {
	SkillHubProviderImportRequestV1: SkillHubProviderImportRequestV1Schema,
	SkillHubProviderImportResponseV1: SkillHubProviderImportResponseV1Schema,
	SkillHubPublicationVersionV1: SkillHubPublicationVersionV1Schema,
};
