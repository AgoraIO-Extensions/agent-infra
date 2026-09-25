import Ajv2020 from "ajv/dist/2020.js";
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
const credentialAuthKeyPattern =
	/^(?!.*(?:[Aa][Uu][Tt][Hh](?:[_. /-]?(?:[Hh][Ee][Aa][Dd][Ee][Rr]|[Vv][Aa][Ll][Uu][Ee]|[Tt][Oo][Kk][Ee][Nn]|[Cc][Oo][Dd][Ee]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll][Ss]?)|[Bb][Aa][Ss][Ii][Cc][_. /-]?[Aa][Uu][Tt][Hh]))).+$/;
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
];
const authoritySelectorExactKeys = [
	"connection",
	"connectionId",
	"principal",
	"principalId",
	"consumer",
	"consumerId",
	"consumerInstance",
	"consumerInstanceId",
	"instance",
	"instanceId",
	"externalAccount",
	"externalAccountId",
	"actor",
	"actorId",
	"agentId",
	"conversationId",
	"turnId",
	"executionId",
	"grant",
	"grantId",
	"session",
	"sessionId",
	"hostSession",
	"hostSessionId",
	"nativeSession",
	"nativeSessionId",
	"identity",
	"identityId",
	"platform",
	"platformId",
	"attachment",
	"attachmentId",
	"userId",
	"user_id",
	"tenantId",
	"accountId",
	"identityId",
	"subjectId",
	"caller",
	"ownerId",
	"context",
	"resourceId",
	"credential",
	"credentialId",
];
const authoritySelectorKeyPattern = new RegExp(
	`^(?!(?:${authoritySelectorExactKeys.map(caseInsensitiveRegexSource).join("|")})$)(?!.*(?:${authoritySelectorKeyTerms.map(caseInsensitiveRegexSource).join("|")})(?:[_. /-]?(?:${["id", "selector", "context", "ref", "key", "value", "identifier"].map(caseInsensitiveRegexSource).join("|")}))?$).+$`,
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
const outputAuthoritySelectorSuffixOnlyTerms = [
	"user",
	"tenant",
	"account",
	"owner",
	"subject",
];
const authoritySelectorSuffixes = [
	"id",
	"selector",
	"context",
	"ref",
	"key",
	"value",
	"identifier",
];
const outputAuthoritySelectorKeyPattern = new RegExp(
	`^(?!.*(?:${outputAuthoritySelectorKeyTerms.map(caseInsensitiveRegexSource).join("|")})(?:[_. /-]?(?:${authoritySelectorSuffixes.map(caseInsensitiveRegexSource).join("|")}))?$)(?!.*(?:${outputAuthoritySelectorSuffixOnlyTerms.map(caseInsensitiveRegexSource).join("|")})[_. /-]?(?:${authoritySelectorSuffixes.map(caseInsensitiveRegexSource).join("|")})$).+$`,
);
const unsafeArgumentValuePattern = new RegExp(
	String.raw`^(?![\s\S]*(?:\b(?:${[
		"bearer",
		"credentials?",
		"oauth(?:code|token)?",
	]
		.map(caseInsensitiveRegexSource)
		.join("|")})\b|(?:^|[^A-Za-z0-9_-])(?:${[
		"token",
		"api[-_]?key",
		"secret",
		"password",
		"authorization",
		"cookie",
		"jwt",
	]
		.map(caseInsensitiveRegexSource)
		.join(
			"|",
		)})\s*[:=]|(?:^|[^A-Za-z0-9_-])${caseInsensitiveRegexSource("basic")}\s+[A-Za-z0-9+/]{8,}={0,2}(?=$|[^A-Za-z0-9+/=])|(?:^|[^A-Za-z0-9_-])(?:${[
		caseInsensitiveRegexSource("sk"),
		caseInsensitiveRegexSource("pk"),
		"[Gg][Hh][PpOoUuSsRr]",
		"[Xx][Oo][Xx][BbAaPpRrSs]",
		caseInsensitiveRegexSource("glpat"),
	].join("|")})[-_][A-Za-z0-9_-]{8,}|(?:^|[^A-Za-z0-9_-])(?:${[
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
		)})[A-Za-z0-9]{16}(?=$|[\s,;])|(?:^|[^A-Za-z0-9_-])${caseInsensitiveRegexSource("github_pat")}[-_][A-Za-z0-9_-]{8,}|(?:^|[^A-Za-z0-9_-])(?:[A-Za-z0-9_-]{10,}\.){2,}[A-Za-z0-9_-]{10,}(?=$|[\s,;])|${caseInsensitiveRegexSource("caller[-_ ]selected[-_ ](?:connection|principal|grant|agent|account|session)")}))[\s\S]*$`,
);

export const DirectPayloadMaximumDepthV1 = 3;
export const DirectPayloadMaximumStringLengthV1 = 65_536;
export const DirectPayloadMaximumCollectionSizeV1 = 1_000;
export const DirectPayloadMaximumNodeCountV1 = 10_000;
export const DirectPayloadMaximumByteLengthV1 = 1_048_576;
export const DirectPayloadMaximumTraversalDepthV1 = 64;

const boundedOpaqueId = OpaqueIdV1Schema.max(
	DirectPayloadMaximumStringLengthV1,
);

const directPayloadBudgetMetadata = {
	description: `Direct payloads are limited to ${DirectPayloadMaximumNodeCountV1} total JSON nodes and ${DirectPayloadMaximumByteLengthV1} UTF-8 bytes.`,
};

type DirectPayloadSize = { nodes: number; bytes: number };

const utf8ByteLength = (value: string) =>
	new TextEncoder().encode(value).byteLength;

const isPlainObject = (value: object): value is Record<string, unknown> => {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

function inspectDirectPayload(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0,
): DirectPayloadSize {
	if (depth > DirectPayloadMaximumTraversalDepthV1) {
		return {
			nodes: DirectPayloadMaximumNodeCountV1 + 1,
			bytes: DirectPayloadMaximumByteLengthV1 + 1,
		};
	}
	if (typeof value === "string") {
		return { nodes: 1, bytes: utf8ByteLength(JSON.stringify(value)) };
	}
	if (
		typeof value === "undefined" ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		typeof value === "bigint"
	) {
		throw new Error("Direct payload contains a non-JSON value");
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new Error("Direct payload contains a non-finite number");
	}
	if (value === null || typeof value !== "object") {
		return {
			nodes: 1,
			bytes: utf8ByteLength(JSON.stringify(value)),
		};
	}
	if (seen.has(value)) {
		return {
			nodes: DirectPayloadMaximumNodeCountV1 + 1,
			bytes: DirectPayloadMaximumByteLengthV1 + 1,
		};
	}
	if (!Array.isArray(value) && !isPlainObject(value)) {
		throw new Error("Direct payload contains a non-JSON object");
	}
	seen.add(value);

	let nodes = 1;
	let bytes = 2;
	const visit = (entry: unknown, keyBytes = 0) => {
		bytes += keyBytes;
		const child = inspectDirectPayload(entry, seen, depth + 1);
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
	const budgetedSchema = schema.meta(directPayloadBudgetMetadata);
	const originalRun = budgetedSchema._zod.run;
	budgetedSchema._zod.run = (payload, context) => {
		try {
			const size = inspectDirectPayload(payload.value);
			if (
				size.nodes > DirectPayloadMaximumNodeCountV1 ||
				size.bytes > DirectPayloadMaximumByteLengthV1
			) {
				payload.issues.push({
					code: "custom",
					input: payload.value,
					message:
						size.nodes > DirectPayloadMaximumNodeCountV1
							? "Direct payload contains too many JSON nodes"
							: "Direct payload exceeds the total byte budget",
				});
				return payload;
			}
		} catch (error) {
			payload.issues.push({
				code: "custom",
				input: payload.value,
				message:
					error instanceof Error
						? error.message
						: "Direct payload contains a non-JSON value",
			});
			return payload;
		}
		return originalRun(payload, context);
	};
	return budgetedSchema;
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
		.regex(credentialAuthKeyPattern)
		.regex(outputAuthoritySelectorKeyPattern),
	DirectPayloadMaximumDepthV1,
);
export const DirectActionArgumentsV1Schema = boundedDirectJsonSchema(
	z
		.string()
		.min(1)
		.max(DirectPayloadMaximumStringLengthV1)
		.regex(credentialSafeKeyPattern)
		.regex(credentialAuthKeyPattern)
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
			.regex(credentialAuthKeyPattern)
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
const jsonSchemaDocumentKeyV1Schema = z
	.string()
	.min(1)
	.max(DirectPayloadMaximumStringLengthV1);
const jsonSchemaTypeNameV1Schema = z.enum([
	"null",
	"boolean",
	"object",
	"array",
	"number",
	"string",
	"integer",
]);
const jsonSchemaTypeV1Schema = z.union([
	jsonSchemaTypeNameV1Schema,
	z.array(jsonSchemaTypeNameV1Schema).min(1).max(7),
]);
const jsonSchemaDocumentValueV1Schema: z.ZodType<DirectJson> = z.lazy(() =>
	z.union([
		jsonSchemaDocumentPrimitiveV1Schema,
		z
			.array(jsonSchemaDocumentValueV1Schema)
			.max(DirectPayloadMaximumCollectionSizeV1),
		z.intersection(
			boundedRecord(
				jsonSchemaDocumentKeyV1Schema,
				jsonSchemaDocumentValueV1Schema,
			),
			z.looseObject({
				$schema: z
					.literal("https://json-schema.org/draft/2020-12/schema")
					.optional(),
				type: jsonSchemaTypeV1Schema.optional(),
			}),
		),
	]),
);
const jsonSchemaMetaValidator = new Ajv2020({ strict: false });
const jsonSchemaDocument = withDirectPayloadBudget(
	z.intersection(
		boundedRecord(
			jsonSchemaDocumentKeyV1Schema,
			jsonSchemaDocumentValueV1Schema,
		),
		z.looseObject({
			$schema: z
				.literal("https://json-schema.org/draft/2020-12/schema")
				.optional(),
			type: jsonSchemaTypeV1Schema.optional(),
		}),
	),
).superRefine((value, context) => {
	const dialect = value.$schema;
	if (
		dialect !== undefined &&
		dialect !== "https://json-schema.org/draft/2020-12/schema"
	) {
		context.addIssue({
			code: "custom",
			message: "Catalog schema must use JSON Schema 2020-12",
		});
		return;
	}
	try {
		if (!jsonSchemaMetaValidator.validateSchema(value)) {
			context.addIssue({
				code: "custom",
				message: "Catalog schema is not a valid JSON Schema 2020-12 document",
			});
		}
	} catch {
		context.addIssue({
			code: "custom",
			message: "Catalog schema is not a valid JSON Schema 2020-12 document",
		});
	}
});

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

const directCatalogActionsV1Schema = z
	.array(DirectActionCatalogEntryV1Schema)
	.max(DirectPayloadMaximumCollectionSizeV1)
	.superRefine((actions, context) => {
		const identities = new Set<string>();
		for (const [index, action] of actions.entries()) {
			const identity = `${action.providerId}\u0000${action.actionId}\u0000${action.actionVersion}`;
			if (identities.has(identity)) {
				context.addIssue({
					code: "custom",
					path: [index],
					message: "Catalog action identity must be unique",
				});
			}
			identities.add(identity);
		}
	})
	.meta({ uniqueItems: true });

export const DirectCatalogResponseV1Schema = withDirectPayloadBudget(
	z.strictObject({
		schemaVersion: SchemaVersionV1Schema,
		catalogVersion: nonEmptyString(),
		actions: directCatalogActionsV1Schema,
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
			providerId: boundedOpaqueId,
			actionId: boundedOpaqueId,
			actionVersion: nonEmptyString(),
			arguments: directActionArgumentsRecordV1Schema,
		}),
		traceId: TraceIdV1Schema,
	}),
);

export const DirectActionReservationV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	traceId: TraceIdV1Schema,
	callId: boundedOpaqueId,
	status: z.literal("reserved"),
});

export const DirectActionReferenceV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	traceId: TraceIdV1Schema,
	callId: boundedOpaqueId,
	status: z.enum([
		"created",
		"submission_started",
		"provider_succeeded",
		"provider_failed",
		"result_pending",
		"needs_manual_review",
		"unresolved",
	]),
});

const DirectClientPrincipalV1Schema = z.strictObject({
	type: z.enum(["user", "application"]),
	key: nonEmptyString(),
});

export const DirectClientIdentityV1Schema = z.strictObject({
	principal: DirectClientPrincipalV1Schema,
	actorId: boundedOpaqueId,
	consumerId: boundedOpaqueId,
	clientId: boundedOpaqueId,
	issuer: z.url(),
	resource: z.url(),
	revision: boundedOpaqueId,
	expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const DirectClientCallRecordV1Schema = z.strictObject({
	callRef: boundedOpaqueId,
	operationNonce: z.uuid(),
	requestDigestVersion: z.literal("connection-request-v1"),
	requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	principal: DirectClientPrincipalV1Schema,
	actorId: boundedOpaqueId,
	actionVersionId: boundedOpaqueId,
	attemptNonces: z.array(z.uuid()).min(1).max(256),
	consumerId: boundedOpaqueId,
	clientId: boundedOpaqueId,
});

export const DirectMcpExecuteActionArgumentsV1Schema = z.strictObject({
	providerId: boundedOpaqueId,
	actionId: boundedOpaqueId,
	actionVersion: nonEmptyString(),
	input: directActionArgumentsRecordV1Schema,
});

export const DirectMcpClientRequestMetaV1Schema = z.strictObject({
	operationNonce: z.uuid(),
	attemptNonce: z.uuid(),
	idempotencyKey: z.uuid(),
});

export const DirectMcpExecuteActionRequestV1Schema = z.strictObject({
	jsonrpc: z.literal("2.0"),
	id: z.union([
		z.string().min(1).max(256),
		z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	]),
	method: z.literal("tools/call"),
	params: z.strictObject({
		name: z.literal("execute_action"),
		arguments: DirectMcpExecuteActionArgumentsV1Schema,
		_meta: z.strictObject({
			"connection.clientRequest/v1": DirectMcpClientRequestMetaV1Schema,
		}),
	}),
});

export const DirectMcpExecuteActionResponseV1Schema = z.strictObject({
	jsonrpc: z.literal("2.0"),
	id: DirectMcpExecuteActionRequestV1Schema.shape.id,
	result: z.strictObject({
		content: z.array(
			z.strictObject({ type: z.literal("text"), text: z.string() }),
		),
		structuredContent: z.strictObject({
			callId: boundedOpaqueId,
			status: z.literal("RESERVED"),
		}),
		_meta: z.strictObject({
			"connection.receipt/v1": z.strictObject({
				callRef: boundedOpaqueId,
				operationNonce: z.uuid(),
				attemptNonce: z.uuid(),
				requestDigestVersion: z.literal("connection-request-v1"),
				requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
				principal: DirectClientPrincipalV1Schema,
				actorId: boundedOpaqueId,
				actionVersionId: boundedOpaqueId,
			}),
		}),
	}),
});

const directResultShape = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	traceId: TraceIdV1Schema,
	providerId: boundedOpaqueId,
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
	validateCredentialFreeArguments: DirectPayloadValidatorV1,
	validateActionArguments: DirectPayloadValidatorV1,
) {
	if (
		!validateDirectPayloadWithPublishedSchemaV1(input, validatePublishedSchema)
	) {
		return false;
	}
	const parsed = DirectActionRequestV1Schema.safeParse(input);
	return (
		parsed.success &&
		validateCredentialFreeArguments(parsed.data.action.arguments) &&
		validateActionArguments(parsed.data.action.arguments)
	);
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
	validateOutput: DirectPayloadValidatorV1,
) {
	if (
		!validateDirectPayloadWithPublishedSchemaV1(input, validatePublishedSchema)
	) {
		return false;
	}
	const parsed = DirectActionResultV1Schema.safeParse(input);
	if (!parsed.success) return false;
	return parsed.data.status === "succeeded"
		? validateOutput(parsed.data.output)
		: parsed.data.error.traceId === parsed.data.traceId;
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
		result.providerId !== request.action.providerId ||
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

// The Direct installation wire shapes live beside the Action contract so the
// OAuth adapter and generated OpenAPI/JSON Schema share one source of truth.
export const DirectInstallRequestV1Schema = z.strictObject({
	client_id: boundedOpaqueId,
	redirect_uri: z.url().max(2048),
	state: z.string().min(16).max(512),
	code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	code_challenge_method: z.literal("S256"),
	scope: z.string().min(1).max(4096),
});
export const DirectInstallResponseV1Schema = z.strictObject({
	authorization_uri: z.url(),
});
export const DirectConsentResponseV1Schema = z.strictObject({
	consumerId: boundedOpaqueId,
	consumerName: nonEmptyString(),
	redirectUri: z.url(),
	scopes: z.array(nonEmptyString()),
});
export const DirectConsentRequestV1Schema = z.strictObject({
	approve: z.literal(true),
});
export const DirectCodeTokenRequestV1Schema = z.strictObject({
	grant_type: z.literal("authorization_code"),
	client_id: boundedOpaqueId,
	code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
	redirect_uri: z.url().max(2048),
});
export const DirectRefreshTokenRequestV1Schema = z.strictObject({
	grant_type: z.literal("refresh_token"),
	client_id: boundedOpaqueId,
	refresh_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const DirectTokenRequestV1Schema = z.discriminatedUnion("grant_type", [
	DirectCodeTokenRequestV1Schema,
	DirectRefreshTokenRequestV1Schema,
]);
export const DirectTokenResponseV1Schema = z.strictObject({
	access_token: z.string(),
	refresh_token: z.string(),
	token_type: z.literal("DPoP"),
	expires_in: z.number().int().positive(),
	scope: z.string(),
});
export const DirectPatResponseV1Schema = z.strictObject({
	token: z.string(),
	token_type: z.literal("DPoP"),
	id: boundedOpaqueId,
});
export const DirectOAuthErrorV1Schema = z.strictObject({
	error: z.enum([
		"invalid_request",
		"invalid_grant",
		"forbidden",
		"unsupported_grant_type",
		"temporarily_unavailable",
	]),
	message: nonEmptyString(),
	traceId: TraceIdV1Schema,
	retryable: z.boolean(),
});

const oauthErrorResponses = {
	"400": directJsonResponse("Invalid OAuth request", DirectOAuthErrorV1Schema),
	"401": directJsonResponse(
		"OAuth authorization denied",
		DirectOAuthErrorV1Schema,
	),
	"403": directJsonResponse(
		"OAuth request forbidden",
		DirectOAuthErrorV1Schema,
	),
	"503": directJsonResponse(
		"OAuth temporarily unavailable",
		DirectOAuthErrorV1Schema,
	),
};
const oauthDpopHeader = {
	header: z.strictObject({ DPoP: z.string() }),
};
const oauthBearerProofHeaders = {
	header: z.strictObject({ DPoP: z.string(), Authorization: z.string() }),
};
const oauthNoContent = { description: "Request completed" };
export const pilotDirectOAuthOpenApiPathsV1 = {
	"/oauth/install": {
		post: {
			security: [],
			operationId: "beginDirectInstallation",
			requestParams: oauthDpopHeader,
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: DirectInstallRequestV1Schema },
				},
			},
			responses: {
				"201": directJsonResponse(
					"Authorization location",
					DirectInstallResponseV1Schema,
				),
				...oauthErrorResponses,
			},
		},
	},
	"/oauth/authorize/{id}": {
		get: {
			security: [{ ConnectionBrowserSession: [] }],
			operationId: "readDirectInstallationConsent",
			requestParams: { path: z.strictObject({ id: boundedOpaqueId }) },
			responses: {
				"200": directJsonResponse(
					"Pending consent",
					DirectConsentResponseV1Schema,
				),
				...oauthErrorResponses,
			},
		},
		post: {
			security: [{ ConnectionBrowserSession: [] }],
			operationId: "approveDirectInstallation",
			requestParams: {
				path: z.strictObject({ id: boundedOpaqueId }),
				header: z.strictObject({ Origin: z.url(), "X-CSRF-Token": z.string() }),
			},
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: DirectConsentRequestV1Schema },
				},
			},
			responses: {
				"303": {
					description: "Exact registered redirect URI with code and state",
				},
				...oauthErrorResponses,
			},
		},
	},
	"/oauth/token": {
		post: {
			security: [],
			operationId: "exchangeDirectInstallationToken",
			requestParams: oauthDpopHeader,
			requestBody: {
				required: true,
				content: {
					"application/x-www-form-urlencoded": {
						schema: DirectTokenRequestV1Schema,
					},
				},
			},
			responses: {
				"200": directJsonResponse(
					"Installation tokens",
					DirectTokenResponseV1Schema,
				),
				...oauthErrorResponses,
			},
		},
	},
	"/oauth/pat": {
		post: {
			security: [],
			operationId: "issueDirectPat",
			requestParams: oauthBearerProofHeaders,
			responses: {
				"201": directJsonResponse(
					"Installation PAT",
					DirectPatResponseV1Schema,
				),
				...oauthErrorResponses,
			},
		},
	},
	"/oauth/pat/rotate": {
		post: {
			security: [],
			operationId: "rotateDirectPat",
			requestParams: oauthBearerProofHeaders,
			responses: {
				"200": directJsonResponse(
					"Rotated installation PAT",
					DirectPatResponseV1Schema,
				),
				...oauthErrorResponses,
			},
		},
	},
	"/oauth/revoke": {
		post: {
			security: [],
			operationId: "revokeDirectTokenFamily",
			requestParams: oauthBearerProofHeaders,
			responses: { "204": oauthNoContent, ...oauthErrorResponses },
		},
	},
	"/oauth/instances/{id}/revoke": {
		post: {
			security: [{ ConnectionBrowserSession: [] }],
			operationId: "revokeDirectInstallation",
			requestParams: {
				path: z.strictObject({ id: boundedOpaqueId }),
				header: z.strictObject({ Origin: z.url(), "X-CSRF-Token": z.string() }),
			},
			responses: { "204": oauthNoContent, ...oauthErrorResponses },
		},
	},
	"/oauth/pats/{id}/revoke": {
		post: {
			security: [{ ConnectionBrowserSession: [] }],
			operationId: "revokeDirectPat",
			requestParams: {
				path: z.strictObject({ id: boundedOpaqueId }),
				header: z.strictObject({ Origin: z.url(), "X-CSRF-Token": z.string() }),
			},
			responses: { "204": oauthNoContent, ...oauthErrorResponses },
		},
	},
} as const;

export const pilotDirectOpenApiPathsV1 = {
	"/api/client/identity": {
		get: {
			operationId: "getDirectClientIdentity",
			requestParams: { header: z.strictObject({ DPoP: z.string() }) },
			responses: {
				"200": directJsonResponse(
					"Current Direct credential identity",
					DirectClientIdentityV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
				"503": directJsonResponse(
					"Connection unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
	"/api/client/calls/{callRef}": {
		get: {
			operationId: "readDirectClientCall",
			requestParams: {
				path: z.strictObject({ callRef: boundedOpaqueId }),
				header: z.strictObject({ DPoP: z.string() }),
			},
			responses: {
				"200": directJsonResponse(
					"Authenticated ActionCall readback",
					DirectClientCallRecordV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
				"404": directJsonResponse(
					"ActionCall unavailable",
					PilotProtocolErrorV1Schema,
				),
				"503": directJsonResponse(
					"Connection unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
	"/mcp": {
		post: {
			operationId: "reserveDirectMcpExecuteAction",
			requestParams: { header: z.strictObject({ DPoP: z.string() }) },
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: DirectMcpExecuteActionRequestV1Schema },
				},
			},
			responses: {
				"200": directJsonResponse(
					"ActionCall reservation with same-response receipt",
					DirectMcpExecuteActionResponseV1Schema,
				),
				"400": directJsonResponse(
					"Invalid request",
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
					"Action conflict",
					PilotProtocolErrorV1Schema,
				),
				"503": directJsonResponse(
					"Connection unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
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
			operationId: "reserveConnectionAction",
			requestParams: {
				header: z.strictObject({ DPoP: z.string() }),
			},
			requestBody: {
				required: true,
				description: `The JSON request body must stay within the ${DirectPayloadMaximumByteLengthV1}-byte direct payload budget; Connection must enforce the transport limit before parsing.`,
				content: {
					"application/json": { schema: DirectActionRequestV1Schema },
				},
			},
			responses: {
				"202": directJsonResponse(
					"Direct ActionCall reservation; Provider execution is separate",
					DirectActionReservationV1Schema,
				),
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
	"/api/v1/actions/{callId}": {
		get: {
			operationId: "getDirectActionReference",
			requestParams: {
				path: z.strictObject({ callId: boundedOpaqueId }),
				header: z.strictObject({ DPoP: z.string() }),
			},
			responses: {
				"200": directJsonResponse(
					"Current ActionCall reference state",
					DirectActionReferenceV1Schema,
				),
				"401": directJsonResponse(
					"Authentication required",
					PilotProtocolErrorV1Schema,
				),
				"404": directJsonResponse(
					"ActionCall unavailable in this installation",
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
	DirectInstallRequestV1: DirectInstallRequestV1Schema,
	DirectInstallResponseV1: DirectInstallResponseV1Schema,
	DirectConsentRequestV1: DirectConsentRequestV1Schema,
	DirectConsentResponseV1: DirectConsentResponseV1Schema,
	DirectCodeTokenRequestV1: DirectCodeTokenRequestV1Schema,
	DirectRefreshTokenRequestV1: DirectRefreshTokenRequestV1Schema,
	DirectTokenRequestV1: DirectTokenRequestV1Schema,
	DirectTokenResponseV1: DirectTokenResponseV1Schema,
	DirectPatResponseV1: DirectPatResponseV1Schema,
	DirectOAuthErrorV1: DirectOAuthErrorV1Schema,
	DirectActionCatalogEntryV1: DirectActionCatalogEntryV1Schema,
	DirectActionErrorV1: DirectActionErrorV1Schema,
	DirectActionFailedV1: DirectActionFailedV1Schema,
	DirectActionManualReviewV1: DirectActionManualReviewV1Schema,
	DirectActionPendingV1: DirectActionPendingV1Schema,
	DirectActionRequestV1: DirectActionRequestV1Schema,
	DirectActionReservationV1: DirectActionReservationV1Schema,
	DirectActionReferenceV1: DirectActionReferenceV1Schema,
	DirectClientIdentityV1: DirectClientIdentityV1Schema,
	DirectClientCallRecordV1: DirectClientCallRecordV1Schema,
	DirectMcpExecuteActionRequestV1: DirectMcpExecuteActionRequestV1Schema,
	DirectMcpExecuteActionResponseV1: DirectMcpExecuteActionResponseV1Schema,
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
export type DirectActionReservationV1 = z.infer<
	typeof DirectActionReservationV1Schema
>;
export type DirectActionReferenceV1 = z.infer<
	typeof DirectActionReferenceV1Schema
>;
export type DirectActionResultV1 = z.infer<typeof DirectActionResultV1Schema>;
export type DirectActionErrorV1 = z.infer<typeof DirectActionErrorV1Schema>;
export type DirectCatalogResponseV1 = z.infer<
	typeof DirectCatalogResponseV1Schema
>;
