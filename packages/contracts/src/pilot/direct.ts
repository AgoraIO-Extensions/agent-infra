import { z } from "zod";

import {
	IdempotencyKeyV1Schema,
	OpaqueIdV1Schema,
	RequestIdV1Schema,
	Rfc3339TimestampV1Schema,
	SchemaVersionV1Schema,
	TraceIdV1Schema,
} from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const nonEmptyString = () => z.string().min(1);
const jsonSchemaDocument = z.record(z.string().min(1), z.unknown());

// The payload is intentionally bounded and rejects credential or caller-authority
// selectors before it can cross the Connection contract boundary.
type DirectJson =
	| null
	| boolean
	| number
	| string
	| DirectJson[]
	| { [key: string]: DirectJson };

const credentialSafeKeyPattern =
	/^(?!.*[Tt][Oo][Kk][Ee][Nn])(?!.*(?:[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Jj][Ww][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee].*[Kk][Ee][Yy]|[Aa][Cc][Cc][Ee][Ss][Ss].*[Kk][Ee][Yy]|[Aa][Pp][Ii].*[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt].*[Kk][Ee][Yy])).+$/;
const authoritySelectorKeyPattern =
	/^(?!.*(?:[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn]|[Pp][Rr][Ii][Nn][Cc][Ii][Pp][Aa][Ll].*[Ii][Dd]|[Cc][Oo][Nn][Ss][Uu][Mm][Ee][Rr].*[Ii][Dd]|[Ii][Nn][Ss][Tt][Aa][Nn][Cc][Ee].*[Ii][Dd]|[Ee][Xx][Tt][Ee][Rr][Nn][Aa][Ll].*[Aa][Cc][Cc][Oo][Uu][Nn][Tt]|[Aa][Cc][Tt][Oo][Rr].*[Ii][Dd]|[Oo][Rr][Gg][Aa][Nn][Ii][Zz][Aa][Tt][Ii][Oo][Nn].*[Ii][Dd]|[Aa][Gg][Ee][Nn][Tt].*[Ii][Dd]|[Cc][Oo][Nn][Vv][Ee][Rr][Ss][Aa][Tt][Ii][Oo][Nn].*[Ii][Dd]|[Tt][Uu][Rr][Nn].*[Ii][Dd]|[Ee][Xx][Ee][Cc][Uu][Tt][Ii][Oo][Nn].*[Ii][Dd]|[Gg][Rr][Aa][Nn][Tt].*[Ii][Dd]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn].*[Gg][Ee][Nn][Ee][Rr][Aa][Tt][Ii][Oo][Nn]|[Hh][Oo][Ss][Tt].*[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Nn][Aa][Tt][Ii][Vv][Ee].*[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Ii][Dd][Ee][Nn][Tt][Ii][Tt][Yy].*[Cc][Oo][Nn][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Tt][Ff][Oo][Rr][Mm].*(?:[Uu][Ss][Ee][Rr]|[Aa][Cc][Cc][Oo][Uu][Nn][Tt]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Ii][Dd][Ee][Nn][Tt][Ii][Tt][Yy]).*[Ii][Dd]|[Aa][Tt][Tt][Aa][Cc][Hh][Mm][Ee][Nn][T])).+$/;

const directJsonPrimitiveV1Schema: z.ZodType<DirectJson> = z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z.string(),
]);

function boundedDirectJsonSchema(key: z.ZodType<string>, maximumDepth: number) {
	let schema = directJsonPrimitiveV1Schema;
	for (let depth = 0; depth < maximumDepth; depth += 1) {
		const child = schema;
		schema = z.union([
			directJsonPrimitiveV1Schema,
			z.array(child),
			z.record(key, child),
		]);
	}
	return schema;
}

export const DirectPayloadMaximumDepthV1 = 3;
export const DirectJsonV1Schema = boundedDirectJsonSchema(
	z.string().min(1).regex(credentialSafeKeyPattern),
	DirectPayloadMaximumDepthV1,
);
export const DirectActionArgumentsV1Schema = boundedDirectJsonSchema(
	z
		.string()
		.min(1)
		.regex(credentialSafeKeyPattern)
		.regex(authoritySelectorKeyPattern),
	DirectPayloadMaximumDepthV1,
);
const directActionArgumentsRecordV1Schema = z.record(
	z
		.string()
		.min(1)
		.regex(credentialSafeKeyPattern)
		.regex(authoritySelectorKeyPattern),
	DirectActionArgumentsV1Schema,
);

export const DirectActionEffectV1Schema = z.enum(["READ", "WRITE"]);
export const DirectActionPublicationStatusV1Schema = z.enum([
	"published",
	"disabled",
]);

export const DirectActionCatalogEntryV1Schema = z.strictObject({
	providerId: OpaqueIdV1Schema,
	actionId: OpaqueIdV1Schema,
	actionVersion: nonEmptyString(),
	inputSchema: jsonSchemaDocument,
	outputSchema: jsonSchemaDocument,
	effect: DirectActionEffectV1Schema,
	requiredScopes: z.array(nonEmptyString()),
	status: DirectActionPublicationStatusV1Schema,
});

export const DirectCatalogResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	catalogVersion: nonEmptyString(),
	actions: z.array(DirectActionCatalogEntryV1Schema),
});

const browserRole = z.enum(["employee", "system_admin"]);
export const DirectBrowserSessionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	displayName: nonEmptyString(),
	roles: z.array(browserRole).min(1),
});

export const DirectGrantProjectionV1Schema = z.strictObject({
	grantId: OpaqueIdV1Schema,
	consumerId: OpaqueIdV1Schema,
	consumerInstanceId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema.nullable(),
	connectionId: OpaqueIdV1Schema,
	actionVersions: z.array(nonEmptyString()).min(1),
	status: z.enum(["active", "revoked", "expired"]),
});

export const DirectGrantListResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	grants: z.array(DirectGrantProjectionV1Schema),
});

export const DirectGrantRevokeResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	grantId: OpaqueIdV1Schema,
	status: z.literal("revoked"),
	revokedAt: Rfc3339TimestampV1Schema,
});

export const DirectActionRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	action: z.strictObject({
		actionId: OpaqueIdV1Schema,
		actionVersion: nonEmptyString(),
		arguments: directActionArgumentsRecordV1Schema,
	}),
	traceId: TraceIdV1Schema,
});

const directResultShape = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	traceId: TraceIdV1Schema,
	actionId: OpaqueIdV1Schema,
	actionVersion: nonEmptyString(),
};

const directErrorShape = {
	schemaVersion: SchemaVersionV1Schema,
	traceId: TraceIdV1Schema,
	message: nonEmptyString(),
	retryable: z.boolean(),
};

export const DirectActionErrorV1Schema = z.discriminatedUnion("code", [
	z.strictObject({
		...directErrorShape,
		code: z.literal("CONNECTION_UNAVAILABLE"),
		message: z.literal("Connection is unavailable"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("PROVIDER_RATE_LIMITED"),
		message: z.literal("Provider rate limit reached"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("DEPENDENCY_UNAVAILABLE"),
		message: z.literal("Connection dependency is unavailable"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("INTERNAL_ERROR"),
		message: z.literal("Connection action failed"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("AUTHORIZATION_REQUIRED"),
		message: z.literal("Connection authorization is required"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("AUTHORIZATION_REVOKED"),
		message: z.literal("Connection authorization was revoked"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("ACTION_UNAVAILABLE"),
		message: z.literal("Action is unavailable"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("REPOSITORY_POLICY_DENIED"),
		message: z.literal("Repository policy denied the action"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("PROVIDER_FAILED"),
		message: z.literal("Provider rejected the action"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("PROVIDER_REVOKED"),
		message: z.literal("Provider authorization was revoked"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("RESULT_PENDING"),
		message: z.literal("Provider result requires reconciliation"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("NEEDS_MANUAL_REVIEW"),
		message: z.literal("Provider result requires manual review"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...directErrorShape,
		code: z.literal("UNRESOLVED"),
		message: z.literal("Provider result is unresolved"),
		retryable: z.literal(false),
	}),
]);

export const DirectActionSucceededV1Schema = z.strictObject({
	...directResultShape,
	callId: OpaqueIdV1Schema,
	status: z.literal("succeeded"),
	completedAt: Rfc3339TimestampV1Schema,
	output: DirectJsonV1Schema,
});

const directNonSucceededBase = {
	...directResultShape,
	callId: OpaqueIdV1Schema,
	status: z.enum(["failed", "pending", "manual_review", "unresolved"]),
	updatedAt: Rfc3339TimestampV1Schema,
	error: DirectActionErrorV1Schema,
};

export const DirectActionFailedV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("failed"),
});
export const DirectActionPendingV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("pending"),
});
export const DirectActionManualReviewV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("manual_review"),
});
export const DirectActionUnresolvedV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("unresolved"),
});

export const DirectActionResultV1Schema = z.discriminatedUnion("status", [
	DirectActionSucceededV1Schema,
	DirectActionFailedV1Schema,
	DirectActionPendingV1Schema,
	DirectActionManualReviewV1Schema,
	DirectActionUnresolvedV1Schema,
]);

export type DirectPayloadValidatorV1 = (input: unknown) => unknown;

export function validateDirectActionResultV1(
	requestInput: unknown,
	resultInput: unknown,
	context: { validateOutput: DirectPayloadValidatorV1 },
) {
	const request = DirectActionRequestV1Schema.parse(requestInput);
	const result = DirectActionResultV1Schema.parse(resultInput);
	if (
		result.requestId !== request.requestId ||
		result.idempotencyKey !== request.idempotencyKey ||
		result.traceId !== request.traceId ||
		result.actionId !== request.action.actionId ||
		result.actionVersion !== request.action.actionVersion
	) {
		throw new Error("Direct Action result correlation mismatch");
	}
	if (result.status === "succeeded") {
		const output = DirectJsonV1Schema.parse(
			context.validateOutput(result.output),
		);
		return { ...result, output };
	}
	if (result.error.traceId !== result.traceId) {
		throw new Error("Direct Action result correlation mismatch");
	}
	const requiredErrorCode = {
		pending: "RESULT_PENDING",
		manual_review: "NEEDS_MANUAL_REVIEW",
		unresolved: "UNRESOLVED",
	} as const;
	if (
		result.status !== "failed" &&
		result.error.code !== requiredErrorCode[result.status]
	) {
		throw new Error("Direct Action result status mismatch");
	}
	if (
		result.status === "failed" &&
		["RESULT_PENDING", "NEEDS_MANUAL_REVIEW", "UNRESOLVED"].includes(
			result.error.code,
		)
	) {
		throw new Error("Direct Action result status mismatch");
	}
	return result;
}

const directJsonResponse = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const pilotDirectOpenApiPathsV1 = {
	"/api/v1/catalog": {
		get: {
			operationId: "listConnectionCatalog",
			responses: {
				"200": directJsonResponse(
					"Published Connection Action catalog",
					DirectCatalogResponseV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
				"503": directJsonResponse(
					"Connection service is unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
	"/api/v1/actions": {
		post: {
			operationId: "executeConnectionAction",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: DirectActionRequestV1Schema },
				},
			},
			responses: {
				"200": directJsonResponse(
					"Direct Connection Action result",
					DirectActionResultV1Schema,
				),
				"400": directJsonResponse(
					"Invalid action request",
					PilotProtocolErrorV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
				"403": directJsonResponse(
					"Action is not authorized",
					PilotProtocolErrorV1Schema,
				),
				"409": directJsonResponse(
					"Action conflicts with an existing operation",
					PilotProtocolErrorV1Schema,
				),
				"503": directJsonResponse(
					"Connection service is unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
	"/api/v1/grants": {
		get: {
			operationId: "listConnectionGrants",
			responses: {
				"200": directJsonResponse(
					"Current grants for the authenticated Principal",
					DirectGrantListResponseV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
	"/api/v1/grants/{grantId}/revoke": {
		post: {
			operationId: "revokeConnectionGrant",
			requestParams: {
				path: z.strictObject({ grantId: OpaqueIdV1Schema }),
			},
			responses: {
				"200": directJsonResponse(
					"Revoked Connection grant",
					DirectGrantRevokeResponseV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
				"403": directJsonResponse(
					"Grant is not owned by the authenticated Principal",
					PilotProtocolErrorV1Schema,
				),
				"404": directJsonResponse(
					"Grant is unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
} as const;

export const pilotDirectSchemasV1 = {
	DirectActionCatalogEntryV1: DirectActionCatalogEntryV1Schema,
	DirectActionErrorV1: DirectActionErrorV1Schema,
	DirectActionFailedV1: DirectActionFailedV1Schema,
	DirectActionManualReviewV1: DirectActionManualReviewV1Schema,
	DirectActionPendingV1: DirectActionPendingV1Schema,
	DirectActionRequestV1: DirectActionRequestV1Schema,
	DirectActionResultV1: DirectActionResultV1Schema,
	DirectActionSucceededV1: DirectActionSucceededV1Schema,
	DirectActionUnresolvedV1: DirectActionUnresolvedV1Schema,
	DirectBrowserSessionV1: DirectBrowserSessionV1Schema,
	DirectCatalogResponseV1: DirectCatalogResponseV1Schema,
	DirectGrantListResponseV1: DirectGrantListResponseV1Schema,
	DirectGrantProjectionV1: DirectGrantProjectionV1Schema,
	DirectGrantRevokeResponseV1: DirectGrantRevokeResponseV1Schema,
};

export type DirectActionCatalogEntryV1 = z.infer<
	typeof DirectActionCatalogEntryV1Schema
>;
export type DirectActionRequestV1 = z.infer<typeof DirectActionRequestV1Schema>;
export type DirectActionResultV1 = z.infer<typeof DirectActionResultV1Schema>;
export type DirectActionErrorV1 = z.infer<typeof DirectActionErrorV1Schema>;
export type DirectCatalogResponseV1 = z.infer<
	typeof DirectCatalogResponseV1Schema
>;
