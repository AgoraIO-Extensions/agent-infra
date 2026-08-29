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
	allowedCommands: z
		.array(
			z.enum(["turn.submit", "turn.supplement", "turn.stop", "tool.invoke"]),
		)
		.min(1),
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

type ExecutionGrantValidationContext = {
	expectedIssuer: string;
	requiredAudience: ExecutionGrantAudienceV1;
	now: string;
};

function rfc3339Instant(value: string) {
	const leapSecond = /:60(?=(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/i.test(value);
	const normalized = leapSecond
		? value.replace(/:60(?=(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/i, ":59")
		: value;
	const instant = Date.parse(normalized);
	if (!Number.isFinite(instant)) {
		throw new Error("Execution Grant claims are inconsistent");
	}
	return instant + (leapSecond ? 1000 : 0);
}

export function validateExecutionGrantClaimsV1(
	input: unknown,
	context: ExecutionGrantValidationContext,
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
	const invokesRuntime = claims.allowedCommands.some((command) =>
		command.startsWith("turn."),
	);
	if (
		issuedAt >= expiresAt ||
		now < issuedAt ||
		now >= expiresAt ||
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

export const ExecutionGrantV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	format: z.literal("compact-jws"),
	token: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});

type SafeDelegatedJson =
	| null
	| boolean
	| number
	| string
	| SafeDelegatedJson[]
	| { [key: string]: SafeDelegatedJson };

const safeDelegatedJsonKey = z
	.string()
	.min(1)
	.regex(
		/^(?!(?:[Ss][Ee][Tt][_-]?[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Cc][Rr][Ee][Tt][_-]?[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Kk][Ee][Yy]|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Kk][Ee][Yy](?:[_-]?[Ii][Dd])?|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy](?:[_-]?[Pp][Ee][Mm])?|[Cc][Ll][Ii][Ee][Nn][Tt][_-]?[Ss][Ee][Cc][Rr][Ee][Tt](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Pp][Ee][Rr][Ss][Oo][Nn][Aa][Ll][_-]?[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii][_-]?[Tt][Oo][Kk][Ee][Nn])$)(?!(?:[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Oo][Aa][Uu][Tt][Hh][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Ss][Ee][Ss][Ss][Ii][Oo][Nn][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Bb][Ee][Aa][Rr][Ee][Rr][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Aa][Uu][Tt][Hh][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Ii][Dd][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Jj][Ww][Tt]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn](?:[_-]?(?:[Hh][Ee][Aa][Dd][Ee][Rr]|[Vv][Aa][Ll][Uu][Ee]|[Tt][Oo][Kk][Ee][Nn]))?|[Cc][Oo][Oo][Kk][Ii][Ee]|[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Rr][Ee][Ff][Rr][Ee][Ss][Hh][_-]?[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt][_-]?(?:[Ss][Ee][Cc][Rr][Ee][Tt]|[Kk][Ee][Yy])|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll](?:[Ss]|[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?|[Ss][Ee][Cc][Rr][Ee][Tt](?:[Ss]|[_-]?(?:[Pp][Ll][Aa][Ii][Nn][Tt][Ee][Xx][Tt]|[Vv][Aa][Ll][Uu][Ee]))?)$).+$/,
	);

export const SafeDelegatedJsonV1Schema: z.ZodType<SafeDelegatedJson> = z.lazy(
	() =>
		z.union([
			z.null(),
			z.boolean(),
			z.number(),
			z.string(),
			z.array(SafeDelegatedJsonV1Schema),
			z.record(safeDelegatedJsonKey, SafeDelegatedJsonV1Schema),
		]),
);

export const DelegatedActionRequestV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
	idempotencyKey: IdempotencyKeyV1Schema,
	grant: ExecutionGrantV1Schema,
	action: z.strictObject({
		actionId: OpaqueIdV1Schema,
		actionVersion: nonEmptyString(),
		arguments: z.record(z.string(), z.json()),
	}),
	traceId: TraceIdV1Schema,
});

export function validateDelegatedActionRequestV1(
	verifiedClaimsInput: unknown,
	requestInput: unknown,
	context: ExecutionGrantValidationContext & {
		expectedActionSetVersion: string;
	},
) {
	const claims = validateExecutionGrantClaimsV1(verifiedClaimsInput, context);
	const request = DelegatedActionRequestV1Schema.parse(requestInput);
	if (
		!claims.allowedCommands.includes("tool.invoke") ||
		!claims.actionIds.includes(request.action.actionId) ||
		claims.actionSetVersion !== context.expectedActionSetVersion ||
		claims.traceId !== request.traceId
	) {
		throw new Error("Delegated Action request exceeds Grant");
	}
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

export const DelegatedActionSucceededV1Schema = z.strictObject({
	...delegatedResultShape,
	callId: OpaqueIdV1Schema,
	status: z.literal("succeeded"),
	output: SafeDelegatedJsonV1Schema,
});

export const DelegatedActionFailedV1Schema = z.strictObject({
	...delegatedResultShape,
	callId: OpaqueIdV1Schema.nullable(),
	status: z.literal("failed"),
	error: PilotProtocolErrorV1Schema,
});

export const DelegatedActionResultV1Schema = z.discriminatedUnion("status", [
	DelegatedActionSucceededV1Schema,
	DelegatedActionFailedV1Schema,
]);

export function validateDelegatedActionResultV1(
	requestInput: unknown,
	resultInput: unknown,
) {
	const request = DelegatedActionRequestV1Schema.parse(requestInput);
	const result = DelegatedActionResultV1Schema.parse(resultInput);
	if (
		result.requestId !== request.requestId ||
		result.idempotencyKey !== request.idempotencyKey ||
		result.traceId !== request.traceId ||
		result.actionId !== request.action.actionId ||
		result.actionVersion !== request.action.actionVersion
	) {
		throw new Error("Delegated Action result correlation mismatch");
	}
	return result;
}

export const pilotDelegatedSchemasV1 = {
	DelegatedActionRequestV1: DelegatedActionRequestV1Schema,
	DelegatedActionResultV1: DelegatedActionResultV1Schema,
	ExecutionGrantClaimsV1: ExecutionGrantClaimsV1Schema,
	ExecutionGrantV1: ExecutionGrantV1Schema,
};

export type ExecutionGrantClaimsV1 = z.infer<
	typeof ExecutionGrantClaimsV1Schema
>;
export type ExecutionGrantV1 = z.infer<typeof ExecutionGrantV1Schema>;
export type DelegatedActionRequestV1 = z.infer<
	typeof DelegatedActionRequestV1Schema
>;
export type DelegatedActionResultV1 = z.infer<
	typeof DelegatedActionResultV1Schema
>;
