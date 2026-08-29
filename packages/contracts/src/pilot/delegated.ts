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

type ExecutionGrantValidationContext = {
	expectedIssuer: string;
	requiredAudience: ExecutionGrantAudienceV1;
	now: string;
	expectedBindings: {
		agentId: string;
		actorId: string;
		channelId: string;
		conversationId: string;
		turnId: string;
		executionId: string;
		sessionGeneration: number;
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
	for (const binding of [
		"agentId",
		"actorId",
		"channelId",
		"conversationId",
		"turnId",
		"executionId",
		"sessionGeneration",
	] as const) {
		if (claims[binding] !== context.expectedBindings[binding]) {
			throw new Error("Execution Grant binding mismatch");
		}
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
		/^(?!(?:[Tt][Oo][Kk][Ee][Nn](?:[_-]?[Vv][Aa][Ll][Uu][Ee])?)$)(?!.*(?:[Ss][Ee][Cc][Rr][Ee][Tt]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Jj][Ww][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee].*[Kk][Ee][Yy]|[Aa][Cc][Cc][Ee][Ss][Ss].*[Kk][Ee][Yy]|[Aa][Pp][Ii].*[Kk][Ee][Yy]|[Cc][Ll][Ii][Ee][Nn][Tt].*[Kk][Ee][Yy]|(?:[Aa][Pp][Ii]|[Aa][Uu][Tt][Hh]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Oo][Aa][Uu][Tt][Hh]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn]|[Aa][Cc][Cc][Ee][Ss][Ss]|[Rr][Ee][Ff][Rr][Ee][Ss][Hh]|[Ii][Dd]|[Pp][Ee][Rr][Ss][Oo][Nn][Aa][Ll].*[Aa][Cc][Cc][Ee][Ss][Ss]).*[Tt][Oo][Kk][Ee][Nn])).+$/,
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
		expectedActionVersion: string;
	},
) {
	const claims = validateExecutionGrantClaimsV1(verifiedClaimsInput, context);
	const request = DelegatedActionRequestV1Schema.parse(requestInput);
	if (
		!claims.allowedCommands.includes("tool.invoke") ||
		!claims.actionIds.includes(request.action.actionId) ||
		claims.actionSetVersion !== context.expectedActionSetVersion ||
		request.action.actionVersion !== context.expectedActionVersion ||
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
		result.actionVersion !== request.action.actionVersion ||
		(result.status === "failed" && result.error.traceId !== result.traceId)
	) {
		throw new Error("Delegated Action result correlation mismatch");
	}
	return result;
}

export const pilotDelegatedSchemasV1 = {
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
export type DelegatedActionRequestV1 = z.infer<
	typeof DelegatedActionRequestV1Schema
>;
export type DelegatedActionResultV1 = z.infer<
	typeof DelegatedActionResultV1Schema
>;
