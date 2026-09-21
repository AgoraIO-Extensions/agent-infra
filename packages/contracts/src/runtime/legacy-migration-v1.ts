import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { RuntimePrincipalV1Schema } from "./grant-v2.ts";
import { WorkloadReadinessBindingV1Schema } from "./readiness.ts";

/** Deployment artifact, not a Runtime HTTP command or business authorization grant. */
export const RuntimeLegacyPrincipalManifestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	issuer: OpaqueIdV1Schema,
	audience: z.literal("runtime_host_legacy_principal"),
	keyId: OpaqueIdV1Schema,
	deployment: WorkloadReadinessBindingV1Schema,
	hostSessionRef: OpaqueIdV1Schema,
	conversationId: OpaqueIdV1Schema,
	sessionGeneration: z.number().int().positive().safe(),
	principal: RuntimePrincipalV1Schema,
	channelId: OpaqueIdV1Schema,
	/** Complete old submit set; each entry refers to verified Platform migration evidence. */
	executions: z
		.array(
			z.strictObject({
				executionId: OpaqueIdV1Schema,
				turnId: OpaqueIdV1Schema,
				originalOperationDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
				migrationRecordId: OpaqueIdV1Schema,
				producerRevision: OpaqueIdV1Schema,
				metadataDigest: z.string().regex(/^[a-f0-9]{64}$/),
			}),
		)
		.min(1)
		.max(256),
});

/** Ed25519 signs the exact decoded payload bytes; the artifact cannot choose its trust root. */
export const RuntimeLegacyPrincipalEnvelopeV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	format: z.literal("runtime-legacy-principal-ed25519"),
	payload: z
		.string()
		.min(1)
		.max(240_000)
		.regex(/^[A-Za-z0-9_-]+$/),
	signature: z
		.string()
		.length(86)
		.regex(/^[A-Za-z0-9_-]+$/),
});

export type RuntimeLegacyPrincipalManifestV1 = z.infer<
	typeof RuntimeLegacyPrincipalManifestV1Schema
>;
export type RuntimeLegacyPrincipalEnvelopeV1 = z.infer<
	typeof RuntimeLegacyPrincipalEnvelopeV1Schema
>;

export const RuntimeLegacyMigrationV1SchemaDefinitions = {
	RuntimeLegacyPrincipalManifestV1: RuntimeLegacyPrincipalManifestV1Schema,
	RuntimeLegacyPrincipalEnvelopeV1: RuntimeLegacyPrincipalEnvelopeV1Schema,
};
