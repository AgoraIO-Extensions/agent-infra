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

export const ExecutionGrantV1Schema = z.strictObject({
	schemaVersion: SchemaVersionV1Schema,
	format: z.literal("compact-jws"),
	token: nonEmptyString(),
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
		/^(?!(?:accessToken|access_token|refreshToken|refresh_token|apiKey|api_key|authorization|clientSecret|client_secret|credential|password|secret|secretPlaintext|secret_plaintext)$).+$/,
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

const delegatedResultShape = {
	schemaVersion: SchemaVersionV1Schema,
	requestId: RequestIdV1Schema,
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
