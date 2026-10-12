import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
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
};
