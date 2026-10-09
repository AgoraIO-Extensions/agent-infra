import { z } from "zod";
import { IdempotencyKeyV1Schema, OpaqueIdV1Schema } from "../index.ts";
import {
	RuntimeOAuthOriginalExecutionRefV1Schema,
	RuntimeOAuthScopeV1Schema,
} from "./oauth.ts";

export const ConnectionInstallationReferenceV1Schema =
	RuntimeOAuthOriginalExecutionRefV1Schema;
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
	principal: z.strictObject({ kind: z.literal("user"), id: OpaqueIdV1Schema }),
	reference: ConnectionInstallationReferenceV1Schema,
	scope: RuntimeOAuthScopeV1Schema,
	status: ConnectionInstallationAuthorizationStatusV1Schema,
	expiresAt: z.number().int().positive().safe(),
});
export type ConnectionInstallationAuthorizationV1 = z.infer<
	typeof ConnectionInstallationAuthorizationV1Schema
>;

export const ConnectionInstallationProjectionV1Schema =
	ConnectionInstallationAuthorizationV1Schema.pick({
		schemaVersion: true,
		authorizationId: true,
		status: true,
		expiresAt: true,
	});

export const ConnectionInstallationCommandV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	commandId: OpaqueIdV1Schema,
	authorizationId: OpaqueIdV1Schema,
	command: z.enum(["begin", "confirm", "status"]),
	requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
	status: z.enum(["pending", "sending", "completed", "unknown", "rejected"]),
	attemptId: OpaqueIdV1Schema.nullable(),
	attemptOwner: OpaqueIdV1Schema.nullable(),
	createdAt: z.number().int().positive().safe(),
	updatedAt: z.number().int().positive().safe(),
});
export const ConnectionInstallationCommandAttemptV1Schema = z.strictObject({
	commandId: OpaqueIdV1Schema,
	attemptId: OpaqueIdV1Schema,
	attemptOwner: OpaqueIdV1Schema,
});
export const ConnectionInstallationBeginRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	executionId: OpaqueIdV1Schema,
});
export const ConnectionInstallationConfirmRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
});
export type ConnectionInstallationCommandV1 = z.infer<
	typeof ConnectionInstallationCommandV1Schema
>;

export const ConnectionInstallationV1SchemaDefinitions = {
	ConnectionInstallationReferenceV1: ConnectionInstallationReferenceV1Schema,
	ConnectionInstallationAuthorizationV1:
		ConnectionInstallationAuthorizationV1Schema,
	ConnectionInstallationProjectionV1: ConnectionInstallationProjectionV1Schema,
	ConnectionInstallationCommandV1: ConnectionInstallationCommandV1Schema,
	ConnectionInstallationCommandAttemptV1:
		ConnectionInstallationCommandAttemptV1Schema,
	ConnectionInstallationBeginRequestV1:
		ConnectionInstallationBeginRequestV1Schema,
	ConnectionInstallationConfirmRequestV1:
		ConnectionInstallationConfirmRequestV1Schema,
};

const browserHeaders = z.strictObject({
	Origin: z.url(),
	"X-Platform-CSRF": z.literal("1"),
	"Sec-Fetch-Site": z.literal("same-origin").optional(),
});
const commandHeaders = browserHeaders.extend({
	"Idempotency-Key": IdempotencyKeyV1Schema,
});
const response = {
	description:
		"Platform installation confirmation fact; no credential or Connection Grant",
	content: {
		"application/json": { schema: ConnectionInstallationProjectionV1Schema },
	},
};
export const connectionInstallationOpenApiPathsV1 = {
	"/api/connection-installations": {
		post: {
			operationId: "beginPlatformConnectionInstallationV1",
			security: [{ PlatformSession: [] }],
			requestParams: { header: commandHeaders },
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: ConnectionInstallationBeginRequestV1Schema,
					},
				},
			},
			responses: { 202: response },
		},
	},
	"/api/connection-installations/{authorizationId}/confirm": {
		post: {
			operationId: "confirmPlatformConnectionInstallationV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ authorizationId: OpaqueIdV1Schema }),
				header: commandHeaders,
			},
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: ConnectionInstallationConfirmRequestV1Schema,
					},
				},
			},
			responses: { 202: response },
		},
	},
	"/api/connection-installations/{authorizationId}": {
		post: {
			operationId: "readPlatformConnectionInstallationV1",
			security: [{ PlatformSession: [] }],
			requestParams: {
				path: z.strictObject({ authorizationId: OpaqueIdV1Schema }),
				header: browserHeaders,
			},
			responses: { 200: response },
		},
	},
};
