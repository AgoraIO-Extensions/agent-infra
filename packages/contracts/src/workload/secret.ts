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
		/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/,
	);
const secretOwnerType = z.enum(["agent-owner", "platform"]);
const secretAlgorithmVersion = z.literal("aes-256-gcm:v1");
const secretAadVersion = z.literal("platform-secret-aad:v1");
const secretWrappingAlgorithmVersion = z.literal("rsa-oaep-sha256:v1");

export const SecretPublicKeyDescriptorV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	keyVersion: WorkloadOpaqueIdV1Schema,
	wrappingAlgorithmVersion: secretWrappingAlgorithmVersion,
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
	const uniqueKeyFingerprints = new Set(
		keySet.keys.map(({ publicKeyFingerprint }) => publicKeyFingerprint),
	);
	if (
		activeKeys.length !== 1 ||
		activeKeys[0]?.keyVersion !== keySet.activeWrappingKeyVersion ||
		uniqueKeyVersions.size !== keySet.keys.length ||
		uniqueKeyFingerprints.size !== keySet.keys.length
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

export const SecretAadBindingV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	aadVersion: secretAadVersion,
	secretId: WorkloadOpaqueIdV1Schema,
	ownerType: secretOwnerType,
	ownerId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	name: z.string().min(1),
	secretVersion: z.number().int().positive(),
	configRevision: WorkloadRevisionV1Schema,
	algorithmVersion: secretAlgorithmVersion,
	wrappingAlgorithmVersion: secretWrappingAlgorithmVersion,
	wrappingKeyVersion: WorkloadOpaqueIdV1Schema,
});

export const SecretCryptoMetadataV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	algorithmVersion: secretAlgorithmVersion,
	wrappingAlgorithmVersion: secretWrappingAlgorithmVersion,
	wrappingKeyVersion: WorkloadOpaqueIdV1Schema,
	aadBinding: SecretAadBindingV1Schema,
	dekFingerprint: sha256Hex,
	nonce: nonceBase64,
	ciphertext: base64,
	authenticationTag: authenticationTagBase64,
	wrappedDek: wrappedDekBase64,
});

export const KubernetesSecretReferenceV1Schema = z.strictObject({
	schemaVersion: WorkloadSchemaVersionV1Schema,
	ownerType: secretOwnerType,
	ownerId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	secretId: WorkloadOpaqueIdV1Schema,
	secretVersion: z.number().int().positive(),
	configRevision: WorkloadRevisionV1Schema,
	algorithmVersion: secretAlgorithmVersion,
	wrappingAlgorithmVersion: secretWrappingAlgorithmVersion,
	wrappingKeyVersion: WorkloadOpaqueIdV1Schema,
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
	ownerType: secretOwnerType,
	ownerId: WorkloadOpaqueIdV1Schema,
	agentId: WorkloadOpaqueIdV1Schema,
	name: z.string().min(1),
	secretVersion: z.number().int().positive(),
	configRevision: WorkloadRevisionV1Schema,
	crypto: SecretCryptoMetadataV1Schema,
	createdAt: WorkloadTimestampV1Schema,
	updatedAt: WorkloadTimestampV1Schema,
});

const secretLifecycleErrorV1Schema = <
	const Code extends string,
	const Message extends string,
	const Retryable extends boolean,
>(
	code: Code,
	message: Message,
	retryable: Retryable,
) =>
	WorkloadBoundaryErrorV1Schema.extend({
		code: z.literal(code),
		message: z.literal(message),
		retryable: z.literal(retryable),
	});

export const SecretLifecycleErrorV1Schema = z.discriminatedUnion("code", [
	secretLifecycleErrorV1Schema(
		"SECRET_KEY_UNAVAILABLE",
		"Secret key is unavailable",
		true,
	),
	secretLifecycleErrorV1Schema(
		"SECRET_METADATA_INVALID",
		"Secret metadata is invalid",
		false,
	),
	secretLifecycleErrorV1Schema(
		"SECRET_AUTHENTICATION_FAILED",
		"Secret authentication failed",
		false,
	),
	secretLifecycleErrorV1Schema(
		"SECRET_ACTIVATION_FAILED",
		"Secret activation failed",
		true,
	),
	secretLifecycleErrorV1Schema(
		"SECRET_ROTATION_FAILED",
		"Secret key rotation failed",
		true,
	),
]);

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
	error: SecretLifecycleErrorV1Schema,
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
	error: SecretLifecycleErrorV1Schema,
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
		error: SecretLifecycleErrorV1Schema,
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
export type SecretKeyRotationV1 = z.infer<typeof SecretKeyRotationV1Schema>;

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

function secretNameMatchesRevision(
	secretRef: z.infer<typeof KubernetesSecretReferenceV1Schema>,
) {
	return secretRef.name.endsWith(
		`-v${secretRef.secretVersion}-r${secretRef.configRevision}`,
	);
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
	const aad = record.crypto.aadBinding;
	if (
		(expectedFence !== undefined && activationFence === undefined) ||
		aad.secretId !== record.secretId ||
		aad.ownerType !== record.ownerType ||
		aad.ownerId !== record.ownerId ||
		aad.agentId !== record.agentId ||
		aad.name !== record.name ||
		aad.secretVersion !== record.secretVersion ||
		aad.configRevision !== record.configRevision ||
		aad.algorithmVersion !== record.crypto.algorithmVersion ||
		aad.wrappingAlgorithmVersion !== record.crypto.wrappingAlgorithmVersion ||
		aad.wrappingKeyVersion !== record.crypto.wrappingKeyVersion ||
		(secretRef !== undefined && !secretNameMatchesRevision(secretRef)) ||
		(secretRef !== undefined &&
			(record.ownerType !== secretRef.ownerType ||
				record.ownerId !== secretRef.ownerId ||
				record.agentId !== secretRef.agentId ||
				record.secretId !== secretRef.secretId ||
				record.secretVersion !== secretRef.secretVersion ||
				record.configRevision !== secretRef.configRevision ||
				record.crypto.algorithmVersion !== secretRef.algorithmVersion ||
				record.crypto.wrappingAlgorithmVersion !==
					secretRef.wrappingAlgorithmVersion ||
				record.crypto.wrappingKeyVersion !== secretRef.wrappingKeyVersion)) ||
		(activationFence !== undefined &&
			(record.agentId !== activationFence.agentId ||
				record.secretId !== activationFence.secretId ||
				record.secretVersion !== activationFence.secretVersion ||
				record.configRevision !== activationFence.configRevision)) ||
		(secretRef !== undefined &&
			activationFence !== undefined &&
			secretRef.name !== activationFence.kubernetesSecretName) ||
		(expectedFence !== undefined &&
			activationFence !== undefined &&
			!activationFencesMatch(activationFence, expectedFence))
	) {
		throw new Error("Platform Secret record correlation mismatch");
	}
	return record;
}

export function validateSecretKeyRotationV1(
	rotationInput: unknown,
	keySetInput?: unknown,
): SecretKeyRotationV1 {
	const rotation = SecretKeyRotationV1Schema.parse(rotationInput);
	const sourceVersions = new Set(rotation.sourceKeyVersions);
	if (
		sourceVersions.size !== rotation.sourceKeyVersions.length ||
		sourceVersions.has(rotation.targetKeyVersion)
	) {
		throw new Error("Secret key rotation mismatch");
	}
	if (keySetInput !== undefined) {
		const keySet = validateSecretEncryptionKeySetV1(keySetInput);
		if (
			rotation.targetKeyVersion !== keySet.activeWrappingKeyVersion ||
			rotation.sourceKeyVersions.some(
				(sourceVersion) =>
					keySet.keys.find(({ keyVersion }) => keyVersion === sourceVersion)
						?.status !== "retiring",
			)
		) {
			throw new Error("Secret key rotation mismatch");
		}
	}
	return rotation;
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
			(!secretNameMatchesRevision(observation.kubernetesSecretRef) ||
				observation.kubernetesSecretRef.agentId !== expected.agentId ||
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
