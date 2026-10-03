import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	PlatformSecretRecordV1Schema,
	SecretActivationObservationV1Schema,
	SecretAuditEventV1Schema,
	SecretEncryptionKeySetV1Schema,
	SecretKeyRotationV1Schema,
	SecretLifecycleErrorV1Schema,
	SecretWorkerKeyringDescriptorV1Schema,
	validatePlatformSecretRecordV1,
	validateSecretActivationObservationV1,
	validateSecretEncryptionKeySetV1,
	validateSecretKeyRotationV1,
} from "../../src/workload/secret.js";

const secretIdentity = {
	secretId: "secret_01",
	ownerType: "agent-owner",
	ownerId: "user_01",
	agentId: "agent_01",
	name: "MODEL_API_KEY",
	secretVersion: 2,
	configRevision: 7,
} as const;

const cryptoMetadata = {
	schemaVersion: 1,
	algorithmVersion: "aes-256-gcm:v1",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	wrappingKeyVersion: "key-2026-08",
	aadBinding: {
		schemaVersion: 1,
		aadVersion: "platform-secret-aad:v1",
		...secretIdentity,
		algorithmVersion: "aes-256-gcm:v1",
		wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
		wrappingKeyVersion: "key-2026-08",
	},
	dekFingerprint: "a".repeat(64),
	nonce: "AAAAAAAAAAAAAAAA",
	ciphertext: "c2VhbGVkLXNlY3JldA==",
	authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
	wrappedDek: "A".repeat(512),
} as const;

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
const publicKeySpkiDerBase64 = publicKeySpkiDer.toString("base64");
const publicKeyFingerprint = createHash("sha256")
	.update(publicKeySpkiDer)
	.digest("hex");
const activePublicKey = {
	schemaVersion: 1,
	keyVersion: "key-2026-08",
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
	publicKeySpkiDerBase64,
	publicKeyFingerprint,
	rsaModulusBits: 3072,
	status: "active",
} as const;
const encryptionKeys = {
	schemaVersion: 1,
	activeWrappingKeyVersion: activePublicKey.keyVersion,
	keys: [activePublicKey],
} as const;

const recordBase = {
	schemaVersion: 1,
	...secretIdentity,
	crypto: cryptoMetadata,
	createdAt: "2026-08-28T10:00:00Z",
	updatedAt: "2026-08-28T10:01:00Z",
} as const;

const kubernetesSecretRef = {
	schemaVersion: 1,
	ownerType: recordBase.ownerType,
	ownerId: recordBase.ownerId,
	agentId: recordBase.agentId,
	secretId: recordBase.secretId,
	secretVersion: recordBase.secretVersion,
	configRevision: recordBase.configRevision,
	algorithmVersion: cryptoMetadata.algorithmVersion,
	wrappingAlgorithmVersion: cryptoMetadata.wrappingAlgorithmVersion,
	wrappingKeyVersion: cryptoMetadata.wrappingKeyVersion,
	name: "agent-01-secret-01-v2-r7",
} as const;

const activationFence = {
	schemaVersion: 1,
	agentId: recordBase.agentId,
	secretId: recordBase.secretId,
	secretVersion: recordBase.secretVersion,
	configRevision: recordBase.configRevision,
	kubernetesSecretName: kubernetesSecretRef.name,
	workloadUid: "workload_uid_01",
	workloadGeneration: 4,
	fence: 11,
} as const;

describe("Platform Secret V1 contract", () => {
	it("keeps encrypt-only API keys separate from the Worker-only keyring", () => {
		const keyring = {
			schemaVersion: 1,
			availableKeyVersions: ["key-2026-08", "key-2026-07"],
			canDecrypt: true,
		} as const;

		expect(validateSecretEncryptionKeySetV1(encryptionKeys)).toEqual(
			encryptionKeys,
		);
		expect(SecretWorkerKeyringDescriptorV1Schema.parse(keyring)).toEqual(
			keyring,
		);
		expect(
			SecretEncryptionKeySetV1Schema.safeParse({
				...encryptionKeys,
				privateKey: "must-not-enter-api-contract",
			}).success,
		).toBe(false);
		expect(
			SecretEncryptionKeySetV1Schema.safeParse({
				...encryptionKeys,
				keys: [{ ...encryptionKeys.keys[0], rsaModulusBits: 2048 }],
			}).success,
		).toBe(false);
		expect(
			SecretEncryptionKeySetV1Schema.safeParse({
				...encryptionKeys,
				keys: [{ ...encryptionKeys.keys[0], status: "retired" }],
			}).success,
		).toBe(false);
		expect(
			SecretEncryptionKeySetV1Schema.safeParse({
				...encryptionKeys,
				keys: encryptionKeys.keys.map(
					({ publicKeySpkiDerBase64: _publicKey, ...descriptor }) => descriptor,
				),
			}).success,
		).toBe(false);
		expect(
			SecretWorkerKeyringDescriptorV1Schema.safeParse({
				...keyring,
				privateKeyMaterial: "must-not-enter-wire-contract",
			}).success,
		).toBe(false);
	});

	it("rejects a key set whose active wrapping key is missing", () => {
		const keySet = {
			schemaVersion: 1,
			activeWrappingKeyVersion: "key-missing",
			keys: [activePublicKey],
		} as const;
		expect(SecretEncryptionKeySetV1Schema.safeParse(keySet).success).toBe(true);
		expect(() => validateSecretEncryptionKeySetV1(keySet)).toThrow(
			"Secret active wrapping key mismatch",
		);
	});

	it.each([
		["duplicate", ["active", "active"]],
		["non-active", ["retiring"]],
		["multiple active", ["active", "other-active"]],
	] as const)("rejects a %s active wrapping key", (_name, variants) => {
		const keys = variants.map((variant) => ({
			...activePublicKey,
			keyVersion: variant === "other-active" ? "key-2026-09" : "key-2026-08",
			status:
				variant === "retiring" ? ("retiring" as const) : ("active" as const),
		}));
		expect(() =>
			validateSecretEncryptionKeySetV1({
				schemaVersion: 1,
				activeWrappingKeyVersion: "key-2026-08",
				keys,
			}),
		).toThrow("Secret active wrapping key mismatch");
	});

	it("rejects different key versions that alias the same RSA key", () => {
		expect(() =>
			validateSecretEncryptionKeySetV1({
				...encryptionKeys,
				keys: [
					activePublicKey,
					{
						...activePublicKey,
						keyVersion: "key-2026-07",
						status: "retiring",
					},
				],
			}),
		).toThrow("Secret active wrapping key mismatch");
	});

	it("rejects malformed or mismatched public key descriptors", () => {
		for (const descriptor of [
			{ ...activePublicKey, publicKeySpkiDerBase64: "A".repeat(512) },
			{ ...activePublicKey, publicKeyFingerprint: "c".repeat(64) },
			{ ...activePublicKey, rsaModulusBits: 4096 },
		]) {
			expect(() =>
				validateSecretEncryptionKeySetV1({
					...encryptionKeys,
					keys: [descriptor],
				}),
			).toThrow("Secret public key descriptor mismatch");
		}
	});

	it("enforces the approved nonce and authentication-tag sizes", () => {
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: {
					...cryptoMetadata,
					aadBinding: { ...cryptoMetadata.aadBinding, aadVersion: "ad-hoc" },
				},
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: { ...cryptoMetadata, nonce: "AA==" },
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: { ...cryptoMetadata, authenticationTag: "AA==" },
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: {
					...cryptoMetadata,
					authenticationTag: `${"A".repeat(21)}B==`,
				},
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: {
					...cryptoMetadata,
					wrappedDek: "d3JhcHBlZC1kZWs=",
				},
			}).success,
		).toBe(false);
	});

	it.each(["A", "A=", "AA=", "AB==", "AAB="])(
		"rejects non-canonical ciphertext Base64 %s",
		(ciphertext) => {
			expect(
				PlatformSecretRecordV1Schema.safeParse({
					...recordBase,
					lifecycleState: "pending",
					crypto: { ...cryptoMetadata, ciphertext },
				}).success,
			).toBe(false);
		},
	);

	it("accepts canonical ciphertext Base64 without changing fixed metadata sizes", () => {
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: { ...cryptoMetadata, ciphertext: "YQ==" },
			}).success,
		).toBe(true);
	});

	it("requires immutable Secret references and a full fence before activation", () => {
		const pending = { ...recordBase, lifecycleState: "pending" } as const;
		const active = {
			...recordBase,
			lifecycleState: "active",
			kubernetesSecretRef,
			activationFence,
		} as const;

		expect(PlatformSecretRecordV1Schema.parse(pending)).toEqual(pending);
		expect(PlatformSecretRecordV1Schema.parse(active)).toEqual(active);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "active",
				kubernetesSecretRef,
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...active,
				kubernetesSecretRef: {
					...kubernetesSecretRef,
					name: "agent-01..secret-01",
				},
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...active,
				kubernetesSecretRef: {
					...kubernetesSecretRef,
					name: `${"a".repeat(64)}.secret-v2-r7`,
				},
			}).success,
		).toBe(false);
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...pending,
				plaintext: "must-never-cross-the-contract",
			}).success,
		).toBe(false);
	});

	it.each([
		["owner", { ownerId: "user_02" }],
		["Agent", { agentId: "agent_02" }],
		["Secret", { secretId: "secret_02" }],
		["version", { secretVersion: 3 }],
		["config revision", { configRevision: 8 }],
		["wrapping key", { wrappingKeyVersion: "key-2026-09" }],
	] as const)(
		"rejects a ciphertext with a mismatched %s AAD binding",
		(_name, mismatch) => {
			expect(() =>
				validatePlatformSecretRecordV1({
					...recordBase,
					lifecycleState: "pending",
					crypto: {
						...cryptoMetadata,
						aadBinding: { ...cryptoMetadata.aadBinding, ...mismatch },
					},
				}),
			).toThrow("Platform Secret record correlation mismatch");
		},
	);

	it("rejects a ciphertext outside the fixed algorithm binding", () => {
		expect(
			PlatformSecretRecordV1Schema.safeParse({
				...recordBase,
				lifecycleState: "pending",
				crypto: {
					...cryptoMetadata,
					algorithmVersion: "legacy-cipher:v0",
				},
			}).success,
		).toBe(false);
	});

	it("rejects an immutable Secret reference with mismatched ownership or crypto metadata", () => {
		const active = {
			...recordBase,
			lifecycleState: "active",
			kubernetesSecretRef,
			activationFence,
		} as const;

		for (const mismatch of [
			{ ownerId: "user_02" },
			{ wrappingKeyVersion: "key-2026-09" },
		]) {
			expect(() =>
				validatePlatformSecretRecordV1({
					...active,
					kubernetesSecretRef: { ...kubernetesSecretRef, ...mismatch },
				}),
			).toThrow("Platform Secret record correlation mismatch");
		}
	});

	it("rejects stale or mismatched activation observations", () => {
		const observed = {
			schemaVersion: 1,
			status: "observed",
			kubernetesSecretRef,
			activationFence,
			health: "healthy",
		} as const;

		expect(SecretActivationObservationV1Schema.parse(observed)).toEqual(
			observed,
		);
		expect(
			validateSecretActivationObservationV1(activationFence, observed),
		).toEqual(observed);
		for (const mismatch of [
			{ agentId: "agent_02" },
			{ secretId: "secret_02" },
			{ secretVersion: activationFence.secretVersion - 1 },
			{ configRevision: activationFence.configRevision - 1 },
			{ kubernetesSecretName: "agent-01-secret-01-v2-r8" },
			{ workloadUid: "workload_uid_02" },
			{ workloadGeneration: activationFence.workloadGeneration - 1 },
			{ fence: activationFence.fence - 1 },
		]) {
			expect(() =>
				validateSecretActivationObservationV1(activationFence, {
					...observed,
					activationFence: { ...activationFence, ...mismatch },
				}),
			).toThrow("Secret activation fence mismatch");
		}
		expect(() =>
			validateSecretActivationObservationV1(activationFence, {
				...observed,
				kubernetesSecretRef: {
					...kubernetesSecretRef,
					name: "agent-01-secret-01-v2-r8",
				},
			}),
		).toThrow("Secret activation fence mismatch");
	});

	it("validates active record links against the complete activation fence", () => {
		const active = {
			...recordBase,
			lifecycleState: "active",
			kubernetesSecretRef,
			activationFence,
		} as const;

		expect(validatePlatformSecretRecordV1(active, activationFence)).toEqual(
			active,
		);
		expect(() =>
			validatePlatformSecretRecordV1({
				...active,
				activationFence: {
					...activationFence,
					agentId: "agent_02",
				},
			}),
		).toThrow("Platform Secret record correlation mismatch");
		expect(() =>
			validatePlatformSecretRecordV1({
				...active,
				kubernetesSecretRef: {
					...kubernetesSecretRef,
					name: "agent-01-secret-01-v2-r8",
				},
			}),
		).toThrow("Platform Secret record correlation mismatch");
		const reusedName = "agent-01-secret-01-v1-r7";
		expect(() =>
			validatePlatformSecretRecordV1({
				...active,
				kubernetesSecretRef: {
					...kubernetesSecretRef,
					name: reusedName,
				},
				activationFence: {
					...activationFence,
					kubernetesSecretName: reusedName,
				},
			}),
		).toThrow("Platform Secret record correlation mismatch");
		expect(() =>
			validatePlatformSecretRecordV1(active, {
				...activationFence,
				workloadGeneration: activationFence.workloadGeneration + 1,
			}),
		).toThrow("Platform Secret record correlation mismatch");
	});

	it("models redacted audit and recoverable key rotation states", () => {
		const auditEvent = {
			schemaVersion: 1,
			eventId: "audit_01",
			secretId: recordBase.secretId,
			agentId: recordBase.agentId,
			wrappingKeyVersion: cryptoMetadata.wrappingKeyVersion,
			operation: "activate",
			result: "succeeded",
			traceId: "trace_secret_01",
			occurredAt: "2026-08-28T10:02:00Z",
		} as const;
		const rotation = {
			schemaVersion: 1,
			rotationId: "rotation_01",
			state: "rewrapping",
			sourceKeyVersions: ["key-2026-07"],
			targetKeyVersion: "key-2026-08",
			processedSecrets: 12,
			remainingSecrets: 3,
			updatedAt: "2026-08-28T10:03:00Z",
		} as const;

		expect(SecretAuditEventV1Schema.parse(auditEvent)).toEqual(auditEvent);
		expect(validateSecretKeyRotationV1(rotation)).toEqual(rotation);
		expect(
			SecretKeyRotationV1Schema.safeParse({
				...rotation,
				state: "failed",
			}).success,
		).toBe(false);
		expect(
			SecretKeyRotationV1Schema.safeParse({
				...rotation,
				state: "completed",
				remainingSecrets: 1,
			}).success,
		).toBe(false);
		expect(
			SecretAuditEventV1Schema.safeParse({
				...auditEvent,
				secretValue: "must-not-be-audit-data",
			}).success,
		).toBe(false);
	});

	it("rejects semantically invalid or key-set-mismatched rotations", () => {
		const rotation = {
			schemaVersion: 1,
			rotationId: "rotation_01",
			state: "rewrapping",
			sourceKeyVersions: ["key-2026-07"],
			targetKeyVersion: "key-2026-08",
			processedSecrets: 12,
			remainingSecrets: 3,
			updatedAt: "2026-08-28T10:03:00Z",
		} as const;
		const { publicKey: retiringKey } = generateKeyPairSync("rsa", {
			modulusLength: 3072,
		});
		const retiringKeyDer = retiringKey.export({ format: "der", type: "spki" });
		const retiringPublicKey = {
			...activePublicKey,
			keyVersion: "key-2026-07",
			publicKeySpkiDerBase64: retiringKeyDer.toString("base64"),
			publicKeyFingerprint: createHash("sha256")
				.update(retiringKeyDer)
				.digest("hex"),
			status: "retiring",
		} as const;
		const keySet = {
			...encryptionKeys,
			keys: [activePublicKey, retiringPublicKey],
		} as const;

		expect(validateSecretKeyRotationV1(rotation, keySet)).toEqual(rotation);
		for (const invalid of [
			{ ...rotation, sourceKeyVersions: ["key-2026-07", "key-2026-07"] },
			{ ...rotation, sourceKeyVersions: [rotation.targetKeyVersion] },
			{ ...rotation, sourceKeyVersions: ["key-missing"] },
		]) {
			expect(() => validateSecretKeyRotationV1(invalid, keySet)).toThrow(
				"Secret key rotation mismatch",
			);
		}
	});

	it("accepts only fixed sanitized Secret lifecycle errors", () => {
		const error = {
			schemaVersion: 1,
			code: "SECRET_ACTIVATION_FAILED",
			message: "Secret activation failed",
			retryable: true,
			traceId: "trace_secret_01",
		} as const;

		expect(SecretLifecycleErrorV1Schema.parse(error)).toEqual(error);
		for (const unsafeError of [
			{ ...error, message: "Kubernetes returned token=secret" },
			{ ...error, code: "PROVIDER_SPECIFIC_FAILURE" },
			{ ...error, detail: "secret material" },
		]) {
			expect(SecretLifecycleErrorV1Schema.safeParse(unsafeError).success).toBe(
				false,
			);
		}
	});
});
