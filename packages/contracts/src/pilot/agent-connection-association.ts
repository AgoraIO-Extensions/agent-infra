import { z } from "zod";

/**
 * Owner-managed Connection association (PRD §9.1, Spec §13.5.7). The service
 * credential is write-only: no response, error or projection ever carries it.
 */
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Connection Agent (Consumer) ID: 3-80 lowercase letters/digits/hyphens. */
export const ConnectionAgentIdV1Schema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{2,79}$/);

export const ConnectionServiceCredentialV1Schema = z
	.string()
	.min(16)
	.max(4096)
	.regex(/^[\x21-\x7e]+$/)
	.meta({ format: "password", writeOnly: true });

export const AgentConnectionAssociationStatusV1Schema = z.enum([
	"not_enabled",
	"processing",
	"associated",
	"failed",
	"unverified",
	"disabling",
	"disabled",
]);

export const AgentConnectionAssociationStateV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	status: AgentConnectionAssociationStatusV1Schema,
	/** How the current association was produced; null when not enabled. */
	source: z.enum(["manual", "automatic"]).nullable(),
	/** Compare-and-swap token for credential replacement/recovery and manual disconnect. */
	associationRevision: revision.nullable(),
	/** True only when the one-time system access enables automatic registration. */
	automaticRegistrationAvailable: z.boolean(),
	/** Explicit v2 deployment capability; absent for the unchanged v1 route. */
	credentialRecoveryAvailable: z.literal(true).optional(),
});

export const AgentConnectionAssociationRequestV1Schema = z.discriminatedUnion(
	"mode",
	[
		z.strictObject({
			schemaVersion: z.literal(1),
			mode: z.literal("manual"),
			connectionAgentId: ConnectionAgentIdV1Schema,
			serviceCredential: ConnectionServiceCredentialV1Schema,
			/** null associates; the current revision replaces the credential. */
			expectedRevision: revision.nullable(),
		}),
		z.strictObject({
			schemaVersion: z.literal(1),
			mode: z.literal("automatic"),
		}),
	],
);

export const AgentConnectionAssociationDisconnectRequestV1Schema =
	z.strictObject({
		schemaVersion: z.literal(1),
		expectedRevision: revision,
	});

export type AgentConnectionAssociationStateV1 = z.infer<
	typeof AgentConnectionAssociationStateV1Schema
>;
