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

export const ExecutionGrantCommandV1Schema = z.enum([
	"turn.submit",
	"turn.supplement",
	"turn.stop",
	"session.status",
	"events.replay",
	"capabilities.read",
	"generation.cancel",
	"tool.invoke",
]);

export const ExecutionGrantClaimsV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	issuer: nonEmptyString(),
	audience: z
		.array(z.enum(["runtime_host", "platform_tool_gateway", "connection_api"]))
		.min(1),
	issuedAt: Rfc3339TimestampV1Schema,
	expiresAt: Rfc3339TimestampV1Schema,
	grantId: OpaqueIdV1Schema,
	agentId: OpaqueIdV1Schema,
	actorId: OpaqueIdV1Schema,
	channelId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	turnId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive(),
	allowedCommands: z.array(ExecutionGrantCommandV1Schema).min(1),
	attachments: z.array(
		z.strictObject({
			attachmentId: OpaqueIdV1Schema,
			operations: z.array(z.enum(["read"])).min(1),
		}),
	),
	actionSetVersion: nonEmptyString(),
	actionIds: z.array(OpaqueIdV1Schema),
	traceId: TraceIdV1Schema,
});

type ExecutionGrantAudienceV1 =
	| "runtime_host"
	| "platform_tool_gateway"
	| "connection_api";

type VerifiedExecutionGrantValidationContext = {
	expectedIssuer: string;
	requiredAudience: ExecutionGrantAudienceV1;
	now: string;
};

type ExecutionGrantValidationContext =
	VerifiedExecutionGrantValidationContext & {
		expectedBindings: {
			agentId: string;
			actorId: string;
			channelId: string;
			conversationId: string;
			turnId: string;
			executionId: string;
			sessionGeneration: number;
			traceId: string;
		};
	};

function rfc3339Instant(value: string) {
	const match = value.match(
		/^(.*[Tt]\d{2}:\d{2}:)(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/,
	);
	if (!match) {
		throw new Error("Execution Grant claims are inconsistent");
	}
	const [, prefix, second, fraction = "", zone] = match;
	const leapSecond = second === "60";
	const wholeSecond = Date.parse(
		`${prefix}${leapSecond ? "59" : second}${zone}`,
	);
	if (!Number.isFinite(wholeSecond)) {
		throw new Error("Execution Grant claims are inconsistent");
	}
	return {
		epochSecond: BigInt(wholeSecond / 1000 + (leapSecond ? 1 : 0)),
		fraction,
		leapSecond,
	};
}

function compareRfc3339Instants(
	left: ReturnType<typeof rfc3339Instant>,
	right: ReturnType<typeof rfc3339Instant>,
) {
	if (left.epochSecond !== right.epochSecond) {
		return left.epochSecond < right.epochSecond ? -1 : 1;
	}
	if (left.leapSecond !== right.leapSecond) {
		return left.leapSecond ? -1 : 1;
	}
	const width = Math.max(left.fraction.length, right.fraction.length);
	const leftFraction = left.fraction.padEnd(width, "0");
	const rightFraction = right.fraction.padEnd(width, "0");
	return leftFraction < rightFraction
		? -1
		: leftFraction > rightFraction
			? 1
			: 0;
}

// The caller must cryptographically verify and decode the compact JWS first.
export function validateVerifiedExecutionGrantClaimsV1(
	input: unknown,
	context: VerifiedExecutionGrantValidationContext,
) {
	const claims = ExecutionGrantClaimsV1Schema.parse(input);
	if (claims.issuer !== context.expectedIssuer) {
		throw new Error("Execution Grant issuer mismatch");
	}
	if (!claims.audience.includes(context.requiredAudience)) {
		throw new Error("Execution Grant audience mismatch");
	}
	const issuedAt = rfc3339Instant(claims.issuedAt);
	const expiresAt = rfc3339Instant(claims.expiresAt);
	const now = rfc3339Instant(Rfc3339TimestampV1Schema.parse(context.now));
	const invokesTools = claims.allowedCommands.includes("tool.invoke");
	const invokesRuntime = claims.allowedCommands.some(
		(command) => command !== "tool.invoke",
	);
	if (
		compareRfc3339Instants(issuedAt, expiresAt) >= 0 ||
		compareRfc3339Instants(now, issuedAt) < 0 ||
		compareRfc3339Instants(now, expiresAt) >= 0 ||
		(invokesTools &&
			(claims.actionIds.length === 0 ||
				!claims.audience.includes("platform_tool_gateway") ||
				!claims.audience.includes("connection_api"))) ||
		(!invokesTools && claims.actionIds.length > 0) ||
		(invokesRuntime && !claims.audience.includes("runtime_host"))
	) {
		throw new Error("Execution Grant claims are inconsistent");
	}
	return claims;
}

export function validateExecutionGrantClaimsV1(
	input: unknown,
	context: ExecutionGrantValidationContext,
) {
	const claims = validateVerifiedExecutionGrantClaimsV1(input, context);
	for (const binding of [
		"agentId",
		"actorId",
		"channelId",
		"conversationId",
		"turnId",
		"executionId",
		"sessionGeneration",
		"traceId",
	] as const) {
		if (claims[binding] !== context.expectedBindings[binding]) {
			throw new Error("Execution Grant binding mismatch");
		}
	}
	return claims;
}

export const ExecutionGrantV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	format: z.literal("compact-jws"),
	token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});

// Produced only after the compact JWS signature has been verified and decoded.
export const VerifiedExecutionGrantV1Schema = z.strictObject({
	token: ExecutionGrantV1Schema.shape.token,
	claims: ExecutionGrantClaimsV1Schema,
});

type DelegatedJson =
	| null
	| boolean
	| number
	| string
	| DelegatedJson[]
	| { [key: string]: DelegatedJson };

const credentialSafeDelegatedJsonKeyPattern =
	/^(?!.*[Tt][Oo][Kk][Ee][Nn])(?!.*(?:[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Jj][Ww][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee].*[Kk][Ee][Yy]|[Aa][Cc][Cc][Ee][Ss][Ss].*[Kk][Ee][Yy]|[Aa][Pp][Ii].*[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt].*[Kk][Ee][Yy])).+$/;
const delegatedAuthoritySelectorKeyPattern =
	/^(?!.*(?:[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ii][Oo][Nn]|[Ee][Xx][Tt][Ee][Rr][Nn][Aa][Ll].*[Aa][Cc][Cc][Oo][Uu][Nn][Tt]|[Aa][Cc][Tt][Oo][Rr].*[Ii][Dd]|[Oo][Rr][Gg][Aa][Nn][Ii][Zz][Aa][Tt][Ii][Oo][Nn].*[Ii][Dd]|[Aa][Gg][Ee][Nn][Tt].*[Ii][Dd]|[Cc][Oo][Nn][Vv][Ee][Rr][Ss][Aa][Tt][Ii][Oo][Nn].*[Ii][Dd]|[Tt][Uu][Rr][Nn].*[Ii][Dd]|[Ee][Xx][Ee][Cc][Uu][Tt][Ii][Oo][Nn].*[Ii][Dd]|[Gg][Rr][Aa][Nn][Tt].*[Ii][Dd]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn].*[Gg][Ee][Nn][Ee][Rr][Aa][Tt][Ii][Oo][Nn]|[Hh][Oo][Ss][Tt].*[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Nn][Aa][Tt][Ii][Vv][Ee].*[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Ii][Dd][Ee][Nn][Tt][Ii][Tt][Yy].*[Cc][Oo][Nn][Tt][Ee][Xx][Tt]|[Pp][Ll][Aa][Tt][Ff][Oo][Rr][Mm].*(?:[Uu][Ss][Ee][Rr]|[Aa][Cc][Cc][Oo][Uu][Nn][Tt]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Ii][Dd][Ee][Nn][Tt][Ii][Tt][Yy]).*[Ii][Dd]|[Aa][Tt][Tt][Aa][Cc][Hh][Mm][Ee][Nn][Tt])).+$/;

const credentialSafeNonPaginationKey = z
	.string()
	.min(1)
	.regex(credentialSafeDelegatedJsonKeyPattern);
const paginationTokenKey = z.enum([
	"pageToken",
	"nextPageToken",
	"previousPageToken",
	"continuationToken",
]);
const safeDelegatedJsonKey = z.union([
	paginationTokenKey,
	credentialSafeNonPaginationKey,
]);
const safeDelegatedArgumentKey = z.union([
	paginationTokenKey,
	credentialSafeNonPaginationKey.regex(delegatedAuthoritySelectorKeyPattern),
]);

const delegatedJsonPrimitiveV1Schema: z.ZodType<DelegatedJson> = z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z.string(),
]);

function boundedDelegatedJsonSchema(
	key: z.ZodType<string>,
	maximumDepth: number,
) {
	let schema = delegatedJsonPrimitiveV1Schema;
	for (let depth = 0; depth < maximumDepth; depth += 1) {
		const child = schema;
		schema = z.union([
			delegatedJsonPrimitiveV1Schema,
			z.array(child),
			z.record(key, child),
		]);
	}
	return schema;
}

export const DelegatedPayloadMaximumDepthV1 = 3;
export const DelegatedJsonV1Schema = boundedDelegatedJsonSchema(
	safeDelegatedJsonKey,
	DelegatedPayloadMaximumDepthV1,
);
export const DelegatedActionArgumentsV1Schema = boundedDelegatedJsonSchema(
	safeDelegatedArgumentKey,
	DelegatedPayloadMaximumDepthV1,
);

export const DelegatedActionRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	grant: ExecutionGrantV1Schema,
	action: z.strictObject({
		actionId: OpaqueIdV1Schema,
		actionVersion: nonEmptyString(),
		arguments: z.record(
			safeDelegatedArgumentKey,
			DelegatedActionArgumentsV1Schema,
		),
	}),
	traceId: TraceIdV1Schema,
});

export function validateDelegatedActionRequestV1(
	verificationInput: unknown,
	requestInput: unknown,
	context: ExecutionGrantValidationContext & {
		expectedActionSetVersion: string;
		expectedActionVersion: string;
		validateArguments: DelegatedPayloadValidatorV1;
	},
) {
	const request = DelegatedActionRequestV1Schema.parse(requestInput);
	const verification = VerifiedExecutionGrantV1Schema.parse(verificationInput);
	if (verification.token !== request.grant.token) {
		throw new Error("Execution Grant verification mismatch");
	}
	const claims = validateExecutionGrantClaimsV1(verification.claims, context);
	if (
		!claims.allowedCommands.includes("tool.invoke") ||
		!claims.actionIds.includes(request.action.actionId) ||
		claims.actionSetVersion !== context.expectedActionSetVersion ||
		request.action.actionVersion !== context.expectedActionVersion ||
		claims.traceId !== request.traceId
	) {
		throw new Error("Delegated Action request exceeds Grant");
	}
	context.validateArguments(request.action.arguments);
	return request;
}

const delegatedResultShape = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	traceId: TraceIdV1Schema,
	actionId: OpaqueIdV1Schema,
	actionVersion: nonEmptyString(),
	completedAt: Rfc3339TimestampV1Schema,
};

const delegatedErrorShape = {
	schemaVersion: SchemaVersionV1Schema,
	traceId: TraceIdV1Schema,
};

export const DelegatedActionErrorV1Schema = z.discriminatedUnion("code", [
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("CONNECTION_UNAVAILABLE"),
		message: z.literal("Connection is unavailable"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("PROVIDER_RATE_LIMITED"),
		message: z.literal("Provider rate limit reached"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("DEPENDENCY_UNAVAILABLE"),
		message: z.literal("Connection dependency is unavailable"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("INTERNAL_ERROR"),
		message: z.literal("Delegated Action failed"),
		retryable: z.literal(true),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("CONNECTION_AUTHORIZATION_REQUIRED"),
		message: z.literal("Connection authorization is required"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("ACTION_UNAVAILABLE"),
		message: z.literal("Action is unavailable"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("PROVIDER_REJECTED"),
		message: z.literal("Provider rejected the Action"),
		retryable: z.literal(false),
	}),
	z.strictObject({
		...delegatedErrorShape,
		code: z.literal("DELEGATED_RESULT_REJECTED"),
		message: z.literal("Delegated result was rejected"),
		retryable: z.literal(false),
	}),
]);

export const DelegatedActionSucceededV1Schema = z.strictObject({
	...delegatedResultShape,
	callId: OpaqueIdV1Schema,
	status: z.literal("succeeded"),
	output: DelegatedJsonV1Schema.meta({
		description:
			"Validated by the Connection-owned Action Schema before crossing this boundary.",
	}),
});

export const DelegatedActionFailedV1Schema = z.strictObject({
	...delegatedResultShape,
	callId: OpaqueIdV1Schema.nullable(),
	status: z.literal("failed"),
	error: DelegatedActionErrorV1Schema,
});

export const DelegatedActionResultV1Schema = z.discriminatedUnion("status", [
	DelegatedActionSucceededV1Schema,
	DelegatedActionFailedV1Schema,
]);

export function validateDelegatedActionResultV1(
	requestInput: unknown,
	resultInput: unknown,
	context: { validateOutput: DelegatedPayloadValidatorV1 },
) {
	const request = DelegatedActionRequestV1Schema.parse(requestInput);
	const result = DelegatedActionResultV1Schema.parse(resultInput);
	if (
		result.requestId !== request.requestId ||
		result.idempotencyKey !== request.idempotencyKey ||
		result.traceId !== request.traceId ||
		result.actionId !== request.action.actionId ||
		result.actionVersion !== request.action.actionVersion ||
		(result.status === "failed" && result.error.traceId !== result.traceId)
	) {
		throw new Error("Delegated Action result correlation mismatch");
	}
	if (result.status === "succeeded") context.validateOutput(result.output);
	return result;
}

const delegatedJsonResponse = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

export const pilotDelegatedOpenApiPathsV1 = {
	"/internal/v1/delegated-actions": {
		post: {
			operationId: "executeDelegatedAction",
			description:
				"Requires deployment-provided service identity in addition to the Execution Grant.",
			requestBody: {
				required: true,
				content: {
					"application/json": { schema: DelegatedActionRequestV1Schema },
				},
			},
			responses: {
				"200": delegatedJsonResponse(
					"Delegated Action result",
					DelegatedActionResultV1Schema,
				),
				"400": delegatedJsonResponse(
					"Invalid delegated request",
					PilotProtocolErrorV1Schema,
				),
				"401": delegatedJsonResponse(
					"Service identity or Execution Grant is invalid",
					PilotProtocolErrorV1Schema,
				),
				"403": delegatedJsonResponse(
					"Delegated Action is not authorized",
					PilotProtocolErrorV1Schema,
				),
				"409": delegatedJsonResponse(
					"Delegated request conflicts with an existing operation",
					PilotProtocolErrorV1Schema,
				),
				"503": delegatedJsonResponse(
					"Connection service is unavailable",
					PilotProtocolErrorV1Schema,
				),
			},
		},
	},
} as const;

export const pilotDelegatedSchemasV1 = {
	DelegatedActionErrorV1: DelegatedActionErrorV1Schema,
	DelegatedActionRequestV1: DelegatedActionRequestV1Schema,
	DelegatedActionResultV1: DelegatedActionResultV1Schema,
	ExecutionGrantClaimsV1: ExecutionGrantClaimsV1Schema,
	ExecutionGrantCommandV1: ExecutionGrantCommandV1Schema,
	ExecutionGrantV1: ExecutionGrantV1Schema,
};

export type ExecutionGrantClaimsV1 = z.infer<
	typeof ExecutionGrantClaimsV1Schema
>;
export type ExecutionGrantCommandV1 = z.infer<
	typeof ExecutionGrantCommandV1Schema
>;
export type ExecutionGrantV1 = z.infer<typeof ExecutionGrantV1Schema>;
export type VerifiedExecutionGrantV1 = z.infer<
	typeof VerifiedExecutionGrantV1Schema
>;
export type DelegatedActionRequestV1 = z.infer<
	typeof DelegatedActionRequestV1Schema
>;
export type DelegatedActionResultV1 = z.infer<
	typeof DelegatedActionResultV1Schema
>;
export type DelegatedActionErrorV1 = z.infer<
	typeof DelegatedActionErrorV1Schema
>;
export type DelegatedPayloadValidatorV1 = (input: unknown) => void;
