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

const nonEmptyString = () =>
	z.string().min(1).max(DirectPayloadMaximumStringLengthV1);

// The transport boundary is intentionally bounded and rejects credential or
// caller-authority selectors before they can cross the Connection contract
// boundary. The Connection still validates arguments against its published,
// action-specific inputSchema and resolves authority outside this payload.
type DirectJson =
	| null
	| boolean
	| number
	| string
	| DirectJson[]
	| { [key: string]: DirectJson };

const credentialSafeKeyPattern =
	/^(?![Aa][Uu][Tt][Hh]$)(?!.*[Tt][Oo][Kk][Ee][Nn])(?!.*(?:[Bb][Ee][Aa][Rr][Ee][Rr]|[Oo][Aa][Uu][Tt][Hh]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Jj][Ww][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee].*[Kk][Ee][Yy]|[Aa][Cc][Cc][Ee][Ss][Ss].*[Kk][Ee][Yy]|[Aa][Pp][Ii].*[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt].*[Kk][Ee][Yy])).+$/;
const caseInsensitiveRegexSource = (source: string) =>
	source.replace(/[A-Za-z]/g, (letter) => {
		const lower = letter.toLowerCase();
		const upper = letter.toUpperCase();
		return `[${lower}${upper}]`;
	});
const authoritySelectorKeyTerms = [
	"connection",
	"principal",
	"consumer",
	"consumerinstance",
	"instance",
	"external[_-]?account",
	"externalaccount",
	"actor",
	"organization",
	"agent",
	"conversation",
	"turn",
	"execution",
	"grant",
	"session",
	"host[_-]?session",
	"hostsession",
	"native[_-]?session",
	"nativesession",
	"identity",
	"platform",
	"attachment",
	"user",
	"tenant",
	"account",
	"subject",
	"caller",
	"owner",
	"context",
	"resource",
	"credential",
];
const safeProviderArgumentKeyPatterns = [
	caseInsensitiveRegexSource("username"),
	caseInsensitiveRegexSource("organizationName"),
	caseInsensitiveRegexSource("resourcePath"),
];
const authoritySelectorKeyPattern = new RegExp(
	`^(?:(?:${safeProviderArgumentKeyPatterns.join("|")})$|(?!.*(?:${authoritySelectorKeyTerms.map(caseInsensitiveRegexSource).join("|")})).+)$`,
);
const outputAuthoritySelectorKeyTerms = [
	"connection",
	"principal",
	"consumer",
	"consumerinstance",
	"instance",
	"actor",
	"agent",
	"conversation",
	"turn",
	"execution",
	"grant",
	"session",
	"host[_-]?session",
	"hostsession",
	"native[_-]?session",
	"nativesession",
	"identity",
	"platform",
	"attachment",
	"credential",
];
const outputAuthoritySelectorKeyPattern = new RegExp(
	`^(?!.*(?:${outputAuthoritySelectorKeyTerms.map(caseInsensitiveRegexSource).join("|")})(?:[_. /-]?(?:${["id", "selector", "context"].map(caseInsensitiveRegexSource).join("|")}))?$).+$`,
);
const unsafeArgumentValuePattern = new RegExp(
	String.raw`^(?![\s\S]*(?:\b(?:${[
		"bearer",
		"credentials?",
		"oauth(?:code|token)?",
	]
		.map(caseInsensitiveRegexSource)
		.join("|")})\b|(?:^|[\s:=])(?:${[
		"token",
		"api[-_]?key",
		"secret",
		"password",
		"authorization",
		"cookie",
		"jwt",
	]
		.map(caseInsensitiveRegexSource)
		.join("|")})\s*[:=]|(?:^|[\s:=])(?:${[
		caseInsensitiveRegexSource("sk"),
		caseInsensitiveRegexSource("pk"),
		"[Gg][Hh][PpOoUuSsRr]",
		"[Xx][Oo][Xx][BbAaPpRrSs]",
	].join("|")})[-_][A-Za-z0-9_-]{8,}|(?:^|[\s:=])(?:${[
		"AKIA",
		"ASIA",
		"AIDA",
		"AROA",
		"AGPA",
		"ANPA",
		"ANVA",
		"ABIA",
		"ACCA",
	]
		.map(caseInsensitiveRegexSource)
		.join(
			"|",
		)})[A-Za-z0-9]{16}(?=$|[\s,;])|(?:^|[\s:=])${caseInsensitiveRegexSource("github_pat")}[-_][A-Za-z0-9_-]{8,}|(?:^|[\s:=])(?:[A-Za-z0-9_-]{2,}\.){2,}[A-Za-z0-9_-]{2,}(?=$|[\s,;])|${caseInsensitiveRegexSource("caller[-_ ]selected[-_ ](?:connection|principal|grant|agent|account|session)")}))[\s\S]*$`,
);

export const DirectPayloadMaximumDepthV1 = 3;
export const DirectPayloadMaximumStringLengthV1 = 65_536;
export const DirectPayloadMaximumCollectionSizeV1 = 1_000;
export const DirectPayloadMaximumNodeCountV1 = 10_000;
export const DirectPayloadMaximumByteLengthV1 = 1_048_576;

const boundedOpaqueId = OpaqueIdV1Schema.max(
	DirectPayloadMaximumStringLengthV1,
);

const directPayloadBudgetMetadata = {
	description: `Direct payloads are limited to ${DirectPayloadMaximumNodeCountV1} total JSON nodes and ${DirectPayloadMaximumByteLengthV1} UTF-8 bytes.`,
};

type DirectPayloadSize = { nodes: number; bytes: number };

const utf8ByteLength = (value: string) =>
	new TextEncoder().encode(value).byteLength;

function inspectDirectPayload(
	value: unknown,
	seen = new WeakSet<object>(),
): DirectPayloadSize {
	if (typeof value === "string") {
		return { nodes: 1, bytes: utf8ByteLength(JSON.stringify(value)) };
	}
	if (value === null || typeof value !== "object") {
		return {
			nodes: 1,
			bytes: utf8ByteLength(JSON.stringify(value) ?? "null"),
		};
	}
	if (seen.has(value)) {
		return {
			nodes: DirectPayloadMaximumNodeCountV1 + 1,
			bytes: DirectPayloadMaximumByteLengthV1 + 1,
		};
	}
	seen.add(value);

	let nodes = 1;
	let bytes = 2;
	const visit = (entry: unknown, keyBytes = 0) => {
		bytes += keyBytes;
		const child = inspectDirectPayload(entry, seen);
		nodes += child.nodes;
		bytes += child.bytes;
	};
	if (Array.isArray(value)) {
		let first = true;
		for (const entry of value) {
			if (!first) bytes += 1;
			first = false;
			visit(entry);
			if (nodes > DirectPayloadMaximumNodeCountV1) break;
			if (bytes > DirectPayloadMaximumByteLengthV1) break;
		}
	} else {
		let first = true;
		for (const [key, entry] of Object.entries(value)) {
			if (!first) bytes += 1;
			first = false;
			visit(entry, utf8ByteLength(JSON.stringify(key)) + 1);
			if (nodes > DirectPayloadMaximumNodeCountV1) break;
			if (bytes > DirectPayloadMaximumByteLengthV1) break;
		}
	}
	seen.delete(value);
	return { nodes, bytes };
}

function withDirectPayloadBudget<T extends z.ZodType>(schema: T) {
	return schema
		.meta(directPayloadBudgetMetadata)
		.superRefine((value, context) => {
			const size = inspectDirectPayload(value);
			if (size.nodes > DirectPayloadMaximumNodeCountV1) {
				context.addIssue({
					code: "custom",
					message: "Direct payload contains too many JSON nodes",
				});
			}
			if (size.bytes > DirectPayloadMaximumByteLengthV1) {
				context.addIssue({
					code: "custom",
					message: "Direct payload exceeds the total byte budget",
				});
			}
		});
}

const directJsonPrimitiveV1Schema: z.ZodType<DirectJson> = z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z
		.string()
		.max(DirectPayloadMaximumStringLengthV1)
		.regex(
			unsafeArgumentValuePattern,
			"Direct payloads cannot carry credentials or authority selectors",
		),
]);
const directActionArgumentPrimitiveV1Schema: z.ZodType<DirectJson> = z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z
		.string()
		.max(DirectPayloadMaximumStringLengthV1)
		.regex(
			unsafeArgumentValuePattern,
			"Direct action arguments cannot carry credentials or authority selectors",
		),
]);

const boundedRecord = (key: z.ZodType<string>, value: z.ZodType<DirectJson>) =>
	z
		.record(key, value)
		.meta({ maxProperties: DirectPayloadMaximumCollectionSizeV1 })
		.superRefine((record, context) => {
			if (Object.keys(record).length > DirectPayloadMaximumCollectionSizeV1) {
				context.addIssue({
					code: "custom",
					message: "Direct payload object is too large",
				});
			}
		});

function boundedDirectJsonSchema(
	key: z.ZodType<string>,
	maximumDepth: number,
	primitive: z.ZodType<DirectJson> = directJsonPrimitiveV1Schema,
) {
	let schema = primitive;
	for (let depth = 0; depth < maximumDepth; depth += 1) {
		const child = schema;
		schema = z.union([
			primitive,
			z.array(child).max(DirectPayloadMaximumCollectionSizeV1),
			boundedRecord(key, child),
		]);
	}
	return withDirectPayloadBudget(schema);
}

export const DirectJsonV1Schema = boundedDirectJsonSchema(
	z
		.string()
		.min(1)
		.max(DirectPayloadMaximumStringLengthV1)
		.regex(credentialSafeKeyPattern)
		.regex(outputAuthoritySelectorKeyPattern),
	DirectPayloadMaximumDepthV1,
);
export const DirectActionArgumentsV1Schema = boundedDirectJsonSchema(
	z
		.string()
		.min(1)
		.max(DirectPayloadMaximumStringLengthV1)
		.regex(credentialSafeKeyPattern)
		.regex(authoritySelectorKeyPattern),
	DirectPayloadMaximumDepthV1,
	directActionArgumentPrimitiveV1Schema,
);

const directActionArgumentsRecordV1Schema = withDirectPayloadBudget(
	boundedRecord(
		z
			.string()
			.min(1)
			.max(DirectPayloadMaximumStringLengthV1)
			.regex(credentialSafeKeyPattern)
			.regex(authoritySelectorKeyPattern),
		DirectActionArgumentsV1Schema,
	),
);

const jsonSchemaDocumentPrimitiveV1Schema: z.ZodType<DirectJson> = z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z.string().max(DirectPayloadMaximumStringLengthV1),
]);
const jsonSchemaDocumentValueV1Schema = boundedDirectJsonSchema(
	z.string().min(1).max(DirectPayloadMaximumStringLengthV1),
	DirectPayloadMaximumDepthV1,
	jsonSchemaDocumentPrimitiveV1Schema,
);
const jsonSchemaDocument = withDirectPayloadBudget(
	boundedRecord(
		z.string().min(1).max(DirectPayloadMaximumStringLengthV1),
		jsonSchemaDocumentValueV1Schema,
	),
);

export const DirectActionEffectV1Schema = z.enum(["READ", "WRITE"]);
export const DirectActionPublicationStatusV1Schema = z.enum([
	"published",
	"disabled",
]);

export const DirectActionCatalogEntryV1Schema = z.strictObject({
	providerId: boundedOpaqueId,
	actionId: boundedOpaqueId,
	actionVersion: nonEmptyString(),
	inputSchema: jsonSchemaDocument,
	outputSchema: jsonSchemaDocument,
	effect: DirectActionEffectV1Schema,
	requiredScopes: z
		.array(nonEmptyString())
		.max(DirectPayloadMaximumCollectionSizeV1),
	status: DirectActionPublicationStatusV1Schema,
});

export const DirectCatalogResponseV1Schema = withDirectPayloadBudget(
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		catalogVersion: nonEmptyString(),
		actions: z
			.array(DirectActionCatalogEntryV1Schema)
			.max(DirectPayloadMaximumCollectionSizeV1),
	}),
);

const browserRole = z.enum(["employee", "system_admin"]);
export const DirectBrowserSessionV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	displayName: nonEmptyString(),
	roles: z.array(browserRole).min(1).max(DirectPayloadMaximumCollectionSizeV1),
});

export const DirectGrantProjectionV1Schema = withDirectPayloadBudget(
	z.strictObject({
		grantId: boundedOpaqueId,
		consumerId: boundedOpaqueId,
		consumerInstanceId: boundedOpaqueId,
		actorId: boundedOpaqueId.nullable(),
		connectionId: boundedOpaqueId,
		actions: z
			.array(
				z.strictObject({
					actionId: boundedOpaqueId,
					actionVersion: nonEmptyString(),
				}),
			)
			.min(1)
			.max(DirectPayloadMaximumCollectionSizeV1),
		status: z.enum(["active", "revoked", "expired"]),
	}),
);

export const DirectGrantListResponseV1Schema = withDirectPayloadBudget(
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		grants: z
			.array(DirectGrantProjectionV1Schema)
			.max(DirectPayloadMaximumCollectionSizeV1),
	}),
);

export const DirectGrantRevokeResponseV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	grantId: boundedOpaqueId,
	status: z.literal("revoked"),
	revokedAt: Rfc3339TimestampV1Schema,
});

export const DirectActionRequestV1Schema = withDirectPayloadBudget(
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		requestId: RequestIdV1Schema,
		idempotencyKey: IdempotencyKeyV1Schema,
		action: z.strictObject({
			actionId: boundedOpaqueId,
			actionVersion: nonEmptyString(),
			arguments: directActionArgumentsRecordV1Schema,
		}),
		traceId: TraceIdV1Schema,
	}),
);

const directResultShape = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	traceId: TraceIdV1Schema,
	actionId: boundedOpaqueId,
	actionVersion: nonEmptyString(),
};

const directErrorShape = {
	schemaVersion: SchemaVersionV1Schema,
	traceId: TraceIdV1Schema,
	message: nonEmptyString(),
	retryable: z.boolean(),
};

const directActionErrorV1Schema = <Code extends string>(
	code: Code,
	message: string,
	retryable: boolean,
) =>
	z.strictObject({
		...directErrorShape,
		code: z.literal(code),
		message: z.literal(message),
		retryable: z.literal(retryable),
	});

const directConnectionUnavailableErrorV1Schema = directActionErrorV1Schema(
	"CONNECTION_UNAVAILABLE",
	"Connection is unavailable",
	true,
);
const directProviderRateLimitedErrorV1Schema = directActionErrorV1Schema(
	"PROVIDER_RATE_LIMITED",
	"Provider rate limit reached",
	true,
);
const directDependencyUnavailableErrorV1Schema = directActionErrorV1Schema(
	"DEPENDENCY_UNAVAILABLE",
	"Connection dependency is unavailable",
	true,
);
const directInternalErrorV1Schema = directActionErrorV1Schema(
	"INTERNAL_ERROR",
	"Connection action failed",
	true,
);
const directAuthorizationRequiredErrorV1Schema = directActionErrorV1Schema(
	"AUTHORIZATION_REQUIRED",
	"Connection authorization is required",
	false,
);
const directAuthorizationRevokedErrorV1Schema = directActionErrorV1Schema(
	"AUTHORIZATION_REVOKED",
	"Connection authorization was revoked",
	false,
);
const directActionUnavailableErrorV1Schema = directActionErrorV1Schema(
	"ACTION_UNAVAILABLE",
	"Action is unavailable",
	false,
);
const directRepositoryPolicyDeniedErrorV1Schema = directActionErrorV1Schema(
	"REPOSITORY_POLICY_DENIED",
	"Repository policy denied the action",
	false,
);
const directProviderFailedErrorV1Schema = directActionErrorV1Schema(
	"PROVIDER_FAILED",
	"Provider rejected the action",
	false,
);
const directProviderRevokedErrorV1Schema = directActionErrorV1Schema(
	"PROVIDER_REVOKED",
	"Provider authorization was revoked",
	false,
);
const directResultPendingErrorV1Schema = directActionErrorV1Schema(
	"RESULT_PENDING",
	"Provider result requires reconciliation",
	false,
);
const directNeedsManualReviewErrorV1Schema = directActionErrorV1Schema(
	"NEEDS_MANUAL_REVIEW",
	"Provider result requires manual review",
	false,
);
const directUnresolvedErrorV1Schema = directActionErrorV1Schema(
	"UNRESOLVED",
	"Provider result is unresolved",
	false,
);

export const DirectActionErrorV1Schema = z.discriminatedUnion("code", [
	directConnectionUnavailableErrorV1Schema,
	directProviderRateLimitedErrorV1Schema,
	directDependencyUnavailableErrorV1Schema,
	directInternalErrorV1Schema,
	directAuthorizationRequiredErrorV1Schema,
	directAuthorizationRevokedErrorV1Schema,
	directActionUnavailableErrorV1Schema,
	directRepositoryPolicyDeniedErrorV1Schema,
	directProviderFailedErrorV1Schema,
	directProviderRevokedErrorV1Schema,
	directResultPendingErrorV1Schema,
	directNeedsManualReviewErrorV1Schema,
	directUnresolvedErrorV1Schema,
]);

const directFailedActionErrorV1Schema = z.discriminatedUnion("code", [
	directConnectionUnavailableErrorV1Schema,
	directProviderRateLimitedErrorV1Schema,
	directDependencyUnavailableErrorV1Schema,
	directInternalErrorV1Schema,
	directAuthorizationRequiredErrorV1Schema,
	directAuthorizationRevokedErrorV1Schema,
	directActionUnavailableErrorV1Schema,
	directRepositoryPolicyDeniedErrorV1Schema,
	directProviderFailedErrorV1Schema,
	directProviderRevokedErrorV1Schema,
]);

export const DirectActionSucceededV1Schema = z.strictObject({
	...directResultShape,
	callId: boundedOpaqueId,
	status: z.literal("succeeded"),
	completedAt: Rfc3339TimestampV1Schema,
	output: DirectJsonV1Schema,
});

const directNonSucceededBase = {
	...directResultShape,
	callId: boundedOpaqueId,
	updatedAt: Rfc3339TimestampV1Schema,
};

export const DirectActionFailedV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("failed"),
	error: directFailedActionErrorV1Schema,
});
export const DirectActionPendingV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("pending"),
	error: directResultPendingErrorV1Schema,
});
export const DirectActionManualReviewV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("manual_review"),
	error: directNeedsManualReviewErrorV1Schema,
});
export const DirectActionUnresolvedV1Schema = z.strictObject({
	...directNonSucceededBase,
	status: z.literal("unresolved"),
	error: directUnresolvedErrorV1Schema,
});

export const DirectActionResultV1Schema = withDirectPayloadBudget(
	z.discriminatedUnion("status", [
		DirectActionSucceededV1Schema,
		DirectActionFailedV1Schema,
		DirectActionPendingV1Schema,
		DirectActionManualReviewV1Schema,
		DirectActionUnresolvedV1Schema,
	]),
);

export type DirectPayloadValidatorV1 = (input: unknown) => boolean;
export type DirectPublishedSchemaValidatorV1 = (input: unknown) => boolean;

export function validateDirectPayloadBudgetV1(input: unknown) {
	try {
		const size = inspectDirectPayload(input);
		return (
			size.nodes <= DirectPayloadMaximumNodeCountV1 &&
			size.bytes <= DirectPayloadMaximumByteLengthV1
		);
	} catch {
		return false;
	}
}

export function validateDirectPayloadWithPublishedSchemaV1(
	input: unknown,
	validatePublishedSchema: DirectPublishedSchemaValidatorV1,
) {
	return validateDirectPayloadBudgetV1(input) && validatePublishedSchema(input);
}

// JSON Schema and OpenAPI cannot express an aggregate recursive node/byte
// budget. Consumers validating against a published artifact must compose its
// validator with this helper so the runtime budget remains enforced.
export function validateDirectActionRequestWithPublishedSchemaV1(
	input: unknown,
	validatePublishedSchema: DirectPublishedSchemaValidatorV1,
) {
	if (
		!validateDirectPayloadWithPublishedSchemaV1(input, validatePublishedSchema)
	) {
		return false;
	}
	return DirectActionRequestV1Schema.safeParse(input).success;
}

export function validateDirectCatalogWithPublishedSchemaV1(
	input: unknown,
	validatePublishedSchema: DirectPublishedSchemaValidatorV1,
) {
	return (
		validateDirectPayloadWithPublishedSchemaV1(
			input,
			validatePublishedSchema,
		) && DirectCatalogResponseV1Schema.safeParse(input).success
	);
}

export function validateDirectGrantListWithPublishedSchemaV1(
	input: unknown,
	validatePublishedSchema: DirectPublishedSchemaValidatorV1,
) {
	return (
		validateDirectPayloadWithPublishedSchemaV1(
			input,
			validatePublishedSchema,
		) && DirectGrantListResponseV1Schema.safeParse(input).success
	);
}

export function validateDirectActionResultWithPublishedSchemaV1(
	input: unknown,
	validatePublishedSchema: DirectPublishedSchemaValidatorV1,
) {
	return (
		validateDirectPayloadWithPublishedSchemaV1(
			input,
			validatePublishedSchema,
		) && DirectActionResultV1Schema.safeParse(input).success
	);
}

export function validateDirectActionResultV1(
	requestInput: unknown,
	resultInput: unknown,
	context: { validateOutput: DirectPayloadValidatorV1 },
) {
	const request = DirectActionRequestV1Schema.parse(requestInput);
	if (!validateDirectPayloadBudgetV1(resultInput)) {
		throw new Error("Direct Action result exceeds the payload budget");
	}
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
		if (!context.validateOutput(result.output)) {
			throw new Error("Direct Action output validation failed");
		}
		const output = DirectJsonV1Schema.parse(result.output);
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
				description: `The JSON request body must stay within the ${DirectPayloadMaximumByteLengthV1}-byte direct payload budget; Connection must enforce the transport limit before parsing.`,
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
				path: z.strictObject({ grantId: boundedOpaqueId }),
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
				"404": directJsonResponse(
					"Grant is unavailable to the authenticated Principal",
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
