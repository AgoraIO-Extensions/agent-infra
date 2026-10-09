import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { RuntimePrincipalV1Schema } from "./grant-v2.ts";
import { RuntimeOAuthScopeV1Schema } from "./oauth.ts";

export const ConnectionInstallationReferenceV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	executionId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
});
export type ConnectionInstallationReferenceV1 = z.infer<
	typeof ConnectionInstallationReferenceV1Schema
>;

export const ConnectionInstallationAuthorizationStatusV1Schema = z.enum([
	"awaiting_confirmation",
	"confirmed",
	"revoked",
	"expired",
	"unknown",
]);

export const ConnectionInstallationAuthorizationV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	authorizationId: OpaqueIdV1Schema,
	confirmationRevision: OpaqueIdV1Schema,
	principal: RuntimePrincipalV1Schema,
	reference: ConnectionInstallationReferenceV1Schema,
	scope: RuntimeOAuthScopeV1Schema,
	status: ConnectionInstallationAuthorizationStatusV1Schema,
	expiresAt: z.number().int().positive().safe(),
});
export type ConnectionInstallationAuthorizationV1 = z.infer<
	typeof ConnectionInstallationAuthorizationV1Schema
>;

export const ConnectionInstallationCommandV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	commandId: OpaqueIdV1Schema,
	authorizationId: OpaqueIdV1Schema,
	command: z.enum(["begin", "confirm", "status"]),
	requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	status: z.enum(["pending", "sending", "completed", "unknown", "rejected"]),
	createdAt: z.number().int().positive().safe(),
	updatedAt: z.number().int().positive().safe(),
});
export type ConnectionInstallationCommandV1 = z.infer<
	typeof ConnectionInstallationCommandV1Schema
>;

export const ConnectionInstallationV1SchemaDefinitions = {
	ConnectionInstallationReferenceV1: ConnectionInstallationReferenceV1Schema,
	ConnectionInstallationAuthorizationV1:
		ConnectionInstallationAuthorizationV1Schema,
	ConnectionInstallationCommandV1: ConnectionInstallationCommandV1Schema,
};
