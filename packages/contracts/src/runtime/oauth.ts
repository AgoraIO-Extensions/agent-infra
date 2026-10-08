import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { RuntimePrincipalV1Schema } from "./grant-v2.ts";

const reference = z.strictObject({
	ref: OpaqueIdV1Schema,
	revision: OpaqueIdV1Schema,
});
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const https = z
	.string()
	.max(2048)
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.hash &&
			!url.search
		);
	});
export const RuntimeOAuthConfigurationV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	ref: OpaqueIdV1Schema,
	revision: OpaqueIdV1Schema,
	clientId: OpaqueIdV1Schema,
	issuer: https,
	authorizationEndpoint: https,
	tokenEndpoint: https,
	revocationEndpoint: https,
	callbackUrl: https,
	runtimeOrigin: https,
	resource: z.string().max(2048),
	scope: z.literal("mcp"),
	configFingerprint: fingerprint,
	source: reference,
});
export type RuntimeOAuthConfigurationV1 = z.infer<
	typeof RuntimeOAuthConfigurationV1Schema
>;

export const RuntimeOAuthScopeV1Schema = z.strictObject({
	agentId: OpaqueIdV1Schema,
	sandboxId: OpaqueIdV1Schema,
	podUid: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	configFingerprint: fingerprint,
	source: reference,
	oauthConfiguration: reference,
});
export type RuntimeOAuthScopeV1 = z.infer<typeof RuntimeOAuthScopeV1Schema>;
export const RuntimeOAuthOriginalExecutionRefV1Schema = z.strictObject({
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
});
export function runtimeOAuthScopeV1(
	value: RuntimeOAuthScopeV1,
): RuntimeOAuthScopeV1 {
	const {
		agentId,
		sandboxId,
		podUid,
		sessionGeneration,
		configFingerprint,
		source,
		oauthConfiguration,
	} = value;
	return {
		agentId,
		sandboxId,
		podUid,
		sessionGeneration,
		configFingerprint,
		source,
		oauthConfiguration,
	};
}
export const RuntimeOAuthGrantV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	format: z.literal("runtime-connection-installation-jws"),
	token: z
		.string()
		.max(16384)
		.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
export const RuntimeOAuthGrantClaimsV1Schema = RuntimeOAuthScopeV1Schema.extend(
	{
		schemaVersion: z.literal(1),
		reference: RuntimeOAuthOriginalExecutionRefV1Schema,
		purpose: z.literal("connection_installation"),
		audience: z.literal("runtime_connection_client"),
		issuer: OpaqueIdV1Schema,
		workerId: OpaqueIdV1Schema,
		principal: RuntimePrincipalV1Schema,
		command: z.enum(["begin", "confirm", "status"]),
		authorizationId: OpaqueIdV1Schema,
		grantId: OpaqueIdV1Schema,
		issuedAt: z.number().int().nonnegative().safe(),
		expiresAt: z.number().int().positive().safe(),
		requestDigest: fingerprint,
	},
);
export type RuntimeOAuthGrantClaimsV1 = z.infer<
	typeof RuntimeOAuthGrantClaimsV1Schema
>;
const request = RuntimeOAuthScopeV1Schema.extend({
	schemaVersion: z.literal(1),
	authorizationId: OpaqueIdV1Schema,
	reference: RuntimeOAuthOriginalExecutionRefV1Schema,
	grant: RuntimeOAuthGrantV1Schema,
});
export const RuntimeOAuthBeginRequestV1Schema = request.extend({
	command: z.literal("begin"),
});
export const RuntimeOAuthConfirmRequestV1Schema = request.extend({
	command: z.literal("confirm"),
});
export const RuntimeOAuthStatusRequestV1Schema = request.extend({
	command: z.literal("status"),
});
export const RuntimeOAuthAuthorizedRequestV1Schema = z.discriminatedUnion(
	"command",
	[
		RuntimeOAuthBeginRequestV1Schema,
		RuntimeOAuthConfirmRequestV1Schema,
		RuntimeOAuthStatusRequestV1Schema,
	],
);
export type RuntimeOAuthAuthorizedRequestV1 = z.infer<
	typeof RuntimeOAuthAuthorizedRequestV1Schema
>;
const callback = {
	schemaVersion: z.literal(1),
	state: z.string().regex(/^[a-f0-9]{64}$/),
	issuer: https,
};
export const RuntimeOAuthCallbackRequestV1Schema = z.union([
	z.strictObject({
		...callback,
		code: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[\x21-\x7e]+$/),
		error: z.never().optional(),
	}),
	z.strictObject({
		...callback,
		code: z.never().optional(),
		error: z.enum([
			"access_denied",
			"invalid_request",
			"unauthorized_client",
			"unsupported_response_type",
			"invalid_scope",
			"server_error",
			"temporarily_unavailable",
		]),
	}),
]);
export type RuntimeOAuthCallbackRequestV1 = z.infer<
	typeof RuntimeOAuthCallbackRequestV1Schema
>;
export const RuntimeOAuthPhaseV1Schema = z.enum([
	"awaiting_callback",
	"awaiting_confirmation",
	"awaiting_verification",
	"denied",
	"unknown",
	"expired",
]);
export const RuntimeOAuthResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	authorizationId: OpaqueIdV1Schema,
	phase: RuntimeOAuthPhaseV1Schema,
	expiresAt: z.number().int().positive().safe(),
	authorizationUrl: z.string().url().max(8192).optional(),
});
export type RuntimeOAuthResponseV1 = z.infer<
	typeof RuntimeOAuthResponseV1Schema
>;
export const RuntimeOAuthV1SchemaDefinitions = {
	RuntimeOAuthConfigurationV1: RuntimeOAuthConfigurationV1Schema,
	RuntimeOAuthScopeV1: RuntimeOAuthScopeV1Schema,
	RuntimeOAuthGrantV1: RuntimeOAuthGrantV1Schema,
	RuntimeOAuthGrantClaimsV1: RuntimeOAuthGrantClaimsV1Schema,
	RuntimeOAuthBeginRequestV1: RuntimeOAuthBeginRequestV1Schema,
	RuntimeOAuthConfirmRequestV1: RuntimeOAuthConfirmRequestV1Schema,
	RuntimeOAuthStatusRequestV1: RuntimeOAuthStatusRequestV1Schema,
	RuntimeOAuthCallbackRequestV1: RuntimeOAuthCallbackRequestV1Schema,
	RuntimeOAuthResponseV1: RuntimeOAuthResponseV1Schema,
};
