import { Buffer } from "node:buffer";
import { createHash, createPublicKey } from "node:crypto";

import { z } from "zod";

import {
	WorkloadBoundaryErrorV1Schema,
	WorkloadFenceV1Schema,
	WorkloadOpaqueIdV1Schema,
	WorkloadRevisionV1Schema,
	WorkloadSchemaVersionV1Schema,
	WorkloadTimestampV1Schema,
} from "./common.ts";

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalBase64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;
const base64 = z.string().min(4).regex(canonicalBase64Pattern);
const spkiDerBase64 = z.string().min(512).regex(canonicalBase64Pattern);
const wrappedDekBase64 = z.string().min(512).regex(canonicalBase64Pattern);
const nonceBase64 = z
	.string()
	.length(16)
	.regex(/^[A-Za-z0-9+/]{16}$/);
const authenticationTagBase64 = z
	.string()
	.length(24)
	.regex(canonicalBase64Pattern)
	.regex(/==$/);
const kubernetesResourceName = z
	.string()
	.max(253)
	.regex(
		/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/,
	);

export const SecretPublicKeyDescriptorV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	keyVersion: WorkloadOpaqueIdV1Schema,
	wrappingAlgorithmVersion: z.literal("rsa-oaep-sha256:v1"),
	publicKeySpkiDerBase64: spkiDerBase64,
	publicKeyFingerprint: sha256Hex,
	rsaModulusBits: z.number().int().min(3072),
	status: z.enum(["active", "retiring"]),
});

export const SecretEncryptionKeySetV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	activeWrappingKeyVersion: WorkloadOpaqueIdV1Schema,
	keys: z.array(SecretPublicKeyDescriptorV1Schema).min(1),
});

export function validateSecretEncryptionKeySetV1(input: unknown) {
	const keySet = SecretEncryptionKeySetV1Schema.parse(input);
	const activeKeys = keySet.keys.filter(({ status }) => status === "active");
	const uniqueKeyVersions = new Set(
		keySet.keys.map(({ keyVersion }) => keyVersion),
	);
	if (
		activeKeys.length !== 1 ||
		activeKeys[0]?.keyVersion !== keySet.activeWrappingKeyVersion ||
		uniqueKeyVersions.size !== keySet.keys.length
	) {
		throw new Error("Secret active wrapping key mismatch");
	}
	for (const descriptor of keySet.keys) {
		const encoded = Buffer.from(descriptor.publicKeySpkiDerBase64, "base64");
		let publicKey: ReturnType<typeof createPublicKey>;
		try {
			publicKey = createPublicKey({
				key: encoded,
				format: "der",
				type: "spki",
			});
		} catch {
			throw new Error("Secret public key descriptor mismatch");
		}
		const canonicalDer = publicKey.export({ format: "der", type: "spki" });
		const fingerprint = createHash("sha256").update(encoded).digest("hex");
		if (
			publicKey.asymmetricKeyType !== "rsa" ||
			publicKey.asymmetricKeyDetails?.modulusLength !==
				descriptor.rsaModulusBits ||
			!canonicalDer.equals(encoded) ||
			fingerprint !== descriptor.publicKeyFingerprint
		) {
			throw new Error("Secret public key descriptor mismatch");
		}
	}
	return keySet;
}

export const SecretWorkerKeyringDescriptorV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	availableKeyVersions: z.array(WorkloadOpaqueIdV1Schema).min(1),
	canDecrypt: z.literal(true),
});

export const SecretCryptoMetadataV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	algorithmVersion: z.literal("aes-256-gcm:v1"),
	aadVersion: z.literal("platform-secret-aad:v1"),
	wrappingAlgorithmVersion: z.literal("rsa-oaep-sha256:v1"),
	wrappingKeyVersion: WorkloadOpaqueIdV1Schema,
	dekFingerprint: sha256Hex,
	nonce: nonceBase64,
	ciphertext: base64,
	authenticationTag: authenticationTagBase64,
	wrappedDek: wrappedDekBase64,
});

export const KubernetesSecretReferenceV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	secretId: WorkloadOpaqueIdV1Schema,
	secretVersion: z.number().int().positive(),
	configRevision: WorkloadRevisionV1Schema,
	name: kubernetesResourceName,
});

export const SecretActivationFenceV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	secretId: WorkloadOpaqueIdV1Schema,
	secretVersion: z.number().int().positive(),
	configRevision: WorkloadRevisionV1Schema,
	kubernetesSecretName: kubernetesResourceName,
	workloadUid: WorkloadOpaqueIdV1Schema,
	workloadGeneration: WorkloadRevisionV1Schema,
	fence: WorkloadFenceV1Schema,
});

const secretRecordBaseV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	secretId: WorkloadOpaqueIdV1Schema,
	ownerType: z.enum(["agent-owner", "platform"]),
	ownerId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	name: z.string().min(1),
	secretVersion: z.number().int().positive(),
	configRevision: WorkloadRevisionV1Schema,
	crypto: SecretCryptoMetadataV1Schema,
	createdAt: WorkloadTimestampV1Schema,
	updatedAt: WorkloadTimestampV1Schema,
});

const pendingSecretRecordV1Schema = secretRecordBaseV1Schema.extend({
	lifecycleState: z.literal("pending"),
});

const applyingSecretRecordV1Schema = secretRecordBaseV1Schema.extend({
	lifecycleState: z.literal("applying"),
	kubernetesSecretRef: KubernetesSecretReferenceV1Schema,
	activationFence: SecretActivationFenceV1Schema,
});

const observedSecretRecordV1Schema = secretRecordBaseV1Schema.extend({
	lifecycleState: z.literal("observed"),
	kubernetesSecretRef: KubernetesSecretReferenceV1Schema,
	activationFence: SecretActivationFenceV1Schema,
});

const activeSecretRecordV1Schema = secretRecordBaseV1Schema.extend({
	lifecycleState: z.literal("active"),
	kubernetesSecretRef: KubernetesSecretReferenceV1Schema,
	activationFence: SecretActivationFenceV1Schema,
});

const failedSecretRecordV1Schema = secretRecordBaseV1Schema.extend({
	lifecycleState: z.literal("failed"),
	kubernetesSecretRef: KubernetesSecretReferenceV1Schema.optional(),
	activationFence: SecretActivationFenceV1Schema.optional(),
	error: WorkloadBoundaryErrorV1Schema,
});

export const PlatformSecretRecordV1Schema = z.discriminatedUnion(
	"lifecycleState",
	[
		pendingSecretRecordV1Schema,
		applyingSecretRecordV1Schema,
		observedSecretRecordV1Schema,
		activeSecretRecordV1Schema,
		failedSecretRecordV1Schema,
	],
);

const observedActivationV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	status: z.literal("observed"),
	kubernetesSecretRef: KubernetesSecretReferenceV1Schema,
	activationFence: SecretActivationFenceV1Schema,
	health: z.literal("healthy"),
});

const failedActivationV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	status: z.literal("failed"),
	kubernetesSecretRef: KubernetesSecretReferenceV1Schema.optional(),
	activationFence: SecretActivationFenceV1Schema,
	health: z.enum(["unknown", "unhealthy"]),
	error: WorkloadBoundaryErrorV1Schema,
});

export const SecretActivationObservationV1Schema = z.discriminatedUnion(
	"status",
	[observedActivationV1Schema, failedActivationV1Schema],
);

export const SecretAuditEventV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	eventId: WorkloadOpaqueIdV1Schema,
	secretId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	wrappingKeyVersion: WorkloadOpaqueIdV1Schema,
	operation: z.enum([
		"encrypt",
		"decrypt",
		"rewrap",
		"activate",
		"fail",
		"retire-key",
	]),
	result: z.enum(["succeeded", "rejected", "failed"]),
	traceId: WorkloadOpaqueIdV1Schema,
	occurredAt: WorkloadTimestampV1Schema,
});

const secretKeyRotationV1Shape = {
	schemaVersion: WorkloadSchemaVersionV1Schema,
	rotationId: WorkloadOpaqueIdV1Schema,
	sourceKeyVersions: z.array(WorkloadOpaqueIdV1Schema).min(1),
	targetKeyVersion: WorkloadOpaqueIdV1Schema,
	processedSecrets: z.number().int().nonnegative(),
	remainingSecrets: z.number().int().nonnegative(),
	updatedAt: WorkloadTimestampV1Schema,
} as const;

export const SecretKeyRotationV1Schema = z.discriminatedUnion("state", [
	z.strictObject({ ...secretKeyRotationV1Shape, state: z.literal("pending") }),
	z.strictObject({
		...secretKeyRotationV1Shape,
		state: z.literal("rewrapping"),
	}),
	z.strictObject({
		...secretKeyRotationV1Shape,
		state: z.literal("verifying"),
	}),
	z.strictObject({
		...secretKeyRotationV1Shape,
		state: z.literal("completed"),
		remainingSecrets: z.literal(0),
	}),
	z.strictObject({
		...secretKeyRotationV1Shape,
		state: z.literal("failed"),
		error: WorkloadBoundaryErrorV1Schema,
	}),
]);

export type PlatformSecretRecordV1 = z.infer<
	typeof PlatformSecretRecordV1Schema
>;
export type SecretActivationFenceV1 = z.infer<
	typeof SecretActivationFenceV1Schema
>;
export type SecretActivationObservationV1 = z.infer<
	typeof SecretActivationObservationV1Schema
>;

const fenceKeys = [
	"agentId",
	"secretId",
	"secretVersion",
	"configRevision",
	"kubernetesSecretName",
	"workloadUid",
	"workloadGeneration",
	"fence",
] as const;

function activationFencesMatch(
	left: SecretActivationFenceV1,
	right: SecretActivationFenceV1,
) {
	return fenceKeys.every((key) => left[key] === right[key]);
}

export function validatePlatformSecretRecordV1(
	recordInput: unknown,
	expectedFenceInput?: unknown,
): PlatformSecretRecordV1 {
	const record = PlatformSecretRecordV1Schema.parse(recordInput);
	const secretRef =
		"kubernetesSecretRef" in record ? record.kubernetesSecretRef : undefined;
	const activationFence =
		"activationFence" in record ? record.activationFence : undefined;
	const expectedFence =
		expectedFenceInput === undefined
			? undefined
			: SecretActivationFenceV1Schema.parse(expectedFenceInput);
	if (
		(secretRef === undefined) !== (activationFence === undefined) ||
		(expectedFence !== undefined && activationFence === undefined) ||
		(secretRef !== undefined &&
			activationFence !== undefined &&
			(record.agentId !== secretRef.agentId ||
				record.agentId !== activationFence.agentId ||
				record.secretId !== secretRef.secretId ||
				record.secretId !== activationFence.secretId ||
				record.secretVersion !== secretRef.secretVersion ||
				record.secretVersion !== activationFence.secretVersion ||
				record.configRevision !== secretRef.configRevision ||
				record.configRevision !== activationFence.configRevision ||
				secretRef.name !== activationFence.kubernetesSecretName)) ||
		(expectedFence !== undefined &&
			activationFence !== undefined &&
			!activationFencesMatch(activationFence, expectedFence))
	) {
		throw new Error("Platform Secret record correlation mismatch");
	}
	return record;
}

export function validateSecretActivationObservationV1(
	expectedInput: unknown,
	observationInput: unknown,
): SecretActivationObservationV1 {
	const expected = SecretActivationFenceV1Schema.parse(expectedInput);
	const observation =
		SecretActivationObservationV1Schema.parse(observationInput);
	if (
		!activationFencesMatch(observation.activationFence, expected) ||
		(observation.kubernetesSecretRef !== undefined &&
			(observation.kubernetesSecretRef.agentId !== expected.agentId ||
				observation.kubernetesSecretRef.secretId !== expected.secretId ||
				observation.kubernetesSecretRef.secretVersion !==
					expected.secretVersion ||
				observation.kubernetesSecretRef.configRevision !==
					expected.configRevision ||
				observation.kubernetesSecretRef.name !== expected.kubernetesSecretName))
	) {
		throw new Error("Secret activation fence mismatch");
	}
	return observation;
}
