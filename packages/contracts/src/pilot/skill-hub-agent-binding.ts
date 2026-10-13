import { z } from "zod";
import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	SchemaVersionV1Schema,
} from "../index.ts";
import {
	SkillGrantV1Schema,
	SkillHubAppliedReceiptV1Schema,
	SkillVersionRefV1Schema,
} from "../skill-hub.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

export const SkillHubAgentBindingRequestV1Schema = z.strictObject({
	skillVersionId: OpaqueIdV1Schema,
	grant: SkillGrantV1Schema,
});

export const SkillHubAgentBindingCommandV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	expectedConfigurationRevision: z
		.number()
		.int()
		.min(1)
		.max(Number.MAX_SAFE_INTEGER),
	bindings: z.array(SkillHubAgentBindingRequestV1Schema).min(1).max(32),
});

export const SkillHubAgentBindingResultV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	agentVersion: OpaqueIdV1Schema,
	configurationRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	changedFields: z.array(z.literal("skills")).length(1),
	replayed: z.boolean(),
});

const publicSkillVersionRefV1Schema = SkillVersionRefV1Schema.omit({
	packageObjectVersion: true,
});
const publicSyncBindingBase = {
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	agentVersion: OpaqueIdV1Schema,
	skillName: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
	skillVersion: publicSkillVersionRefV1Schema,
	grant: SkillGrantV1Schema,
	configurationRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	syncRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
const publicPendingBinding = z.strictObject({
	...publicSyncBindingBase,
	state: z.literal("pending_sync"),
	failureReason: z.null(),
	appliedReceipt: z.null(),
});
const publicSyncedBinding = z.strictObject({
	...publicSyncBindingBase,
	state: z.literal("synced"),
	failureReason: z.null(),
	appliedReceipt: SkillHubAppliedReceiptV1Schema,
});
const publicFailedBinding = z.strictObject({
	...publicSyncBindingBase,
	state: z.literal("failed"),
	failureReason: z.string().min(1).max(256),
	appliedReceipt: z.null(),
});
const publicRevokedBinding = z.strictObject({
	...publicSyncBindingBase,
	state: z.literal("revoked"),
	failureReason: z.null(),
	appliedReceipt: z.null(),
});
export const SkillHubAgentBindingStatusV1Schema = z.discriminatedUnion(
	"state",
	[
		publicPendingBinding,
		publicSyncedBinding,
		publicFailedBinding,
		publicRevokedBinding,
	],
);
export const SkillHubAgentBindingStatusResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	agentId: OpaqueIdV1Schema,
	agentVersion: OpaqueIdV1Schema,
	configurationRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	bindings: z.array(SkillHubAgentBindingStatusV1Schema).max(32),
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

export const skillHubAgentBindingOpenApiPathsV1 = {
	"/api/v2/agents/{agentId}/versions/{agentVersion}/skills": {
		put: {
			operationId: "bindSkillHubAgentVersionV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({
					agentId: OpaqueIdV1Schema,
					agentVersion: OpaqueIdV1Schema,
				}),
				header: z.strictObject({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: SkillHubAgentBindingCommandV1Schema },
				},
			},
			responses: {
				"200": response(
					"Replayed Skill binding",
					SkillHubAgentBindingResultV1Schema,
				),
				"201": response(
					"Skill binding committed",
					SkillHubAgentBindingResultV1Schema,
				),
				...errors,
			},
		},
		get: {
			operationId: "readSkillHubAgentBindingsV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({
					agentId: OpaqueIdV1Schema,
					agentVersion: OpaqueIdV1Schema,
				}),
			},
			responses: {
				"200": response(
					"Current Skill binding status",
					SkillHubAgentBindingStatusResponseV1Schema,
				),
				...errors,
			},
		},
	},
} as const;

export const skillHubAgentBindingSchemasV1 = {
	SkillHubAgentBindingRequestV1: SkillHubAgentBindingRequestV1Schema,
	SkillHubAgentBindingCommandV1: SkillHubAgentBindingCommandV1Schema,
	SkillHubAgentBindingResultV1: SkillHubAgentBindingResultV1Schema,
	SkillHubAgentBindingStatusV1: SkillHubAgentBindingStatusV1Schema,
	SkillHubAgentBindingStatusResponseV1:
		SkillHubAgentBindingStatusResponseV1Schema,
};
