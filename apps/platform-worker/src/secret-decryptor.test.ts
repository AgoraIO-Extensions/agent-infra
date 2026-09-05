import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import {
	createSecretKeyRotationCryptoV1,
	createSecretKeyringDecryptorV1,
} from "@agent-infra/secret-store/worker";
import { describe, expect, it } from "vitest";
import { secretActivationDecryptorConformanceV1 } from "../../../packages/platform-core/src/secret-decryptor.conformance.js";

function encryptedRecord() {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 3072,
	});
	const publicDer = publicKey.export({ format: "der", type: "spki" });
	const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
	const keyVersion = "key_test_01";
	const plaintext = randomBytes(32).toString("base64");
	const encryptor = createSecretEncryptorV1({
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: keyVersion,
			keys: [
				{
					schemaVersion: 1,
					keyVersion,
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: publicDer.toString("base64"),
					publicKeyFingerprint: createHash("sha256")
						.update(publicDer)
						.digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	});
	const record = encryptor.encrypt({
		schemaVersion: 1,
		secretId: "credential_01",
		ownerType: "agent-owner",
		ownerId: "owner_01",
		agentId: "agent_01",
		name: "MODEL_API_KEY",
		secretVersion: 2,
		configRevision: 7,
		plaintext,
		occurredAt: "2026-09-05T08:00:00.000Z",
	});
	return {
		keyVersion,
		publicKeySpkiDerBase64: publicDer.toString("base64"),
		publicKeyFingerprint: createHash("sha256").update(publicDer).digest("hex"),
		privateKeyPkcs8DerBase64: privateDer.toString("base64"),
		decryptor: createSecretKeyringDecryptorV1({
			keys: [
				{
					keyVersion,
					privateKeyPkcs8DerBase64: privateDer.toString("base64"),
				},
			],
		}),
		missingKeyDecryptor: createSecretKeyringDecryptorV1({
			keys: [
				{
					keyVersion: "other_key",
					privateKeyPkcs8DerBase64: privateDer.toString("base64"),
				},
			],
		}),
		plaintextDigest: createHash("sha256").update(plaintext).digest("hex"),
		record,
		tamperedRecord: {
			...record,
			crypto: {
				...record.crypto,
				ciphertext: `${record.crypto.ciphertext.slice(0, -4)}AAAA`,
			},
		},
	};
}

secretActivationDecryptorConformanceV1("Worker", () => {
	const fixture = encryptedRecord();
	return {
		valid: {
			port: fixture.decryptor,
			encryptedRecord: fixture.record,
			expectedDigest: fixture.plaintextDigest,
		},
		unavailableKey: {
			port: fixture.missingKeyDecryptor,
			encryptedRecord: fixture.record,
		},
		malformed: {
			port: fixture.decryptor,
			encryptedRecord: { detail: "boundary-sensitive" },
		},
		tampered: {
			port: fixture.decryptor,
			encryptedRecord: fixture.tamperedRecord,
		},
	};
});

describe("Worker Secret decryptor", () => {
	it("decrypts an authenticated record only with the matching private key", async () => {
		const fixture = encryptedRecord();

		const decision = await fixture.decryptor.decrypt({
			encryptedRecord: fixture.record,
			traceId: "trace_01",
		});

		expect(decision.outcome).toBe("decrypted");
		if (decision.outcome !== "decrypted") throw new Error("Expected plaintext");
		expect(createHash("sha256").update(decision.plaintext).digest("hex")).toBe(
			fixture.plaintextDigest,
		);
		expect(JSON.stringify(fixture.decryptor)).toBe("{}");
	});

	it("returns fixed redacted failures for unavailable keys and tampering", async () => {
		const fixture = encryptedRecord();
		await expect(
			fixture.missingKeyDecryptor.decrypt({
				encryptedRecord: fixture.record,
				traceId: "trace_01",
			}),
		).resolves.toEqual({
			outcome: "failed",
			code: "SECRET_KEY_UNAVAILABLE",
		});

		await expect(
			fixture.decryptor.decrypt({
				encryptedRecord: fixture.tamperedRecord,
				traceId: "trace_01",
			}),
		).resolves.toEqual({
			outcome: "failed",
			code: "SECRET_AUTHENTICATION_FAILED",
		});
	});
});

describe("Worker Secret rotation crypto", () => {
	it("decrypts with the source key and re-encrypts with fresh target material", async () => {
		const source = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const target = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const sourcePublic = source.publicKey.export({
			format: "der",
			type: "spki",
		});
		const sourcePrivate = source.privateKey.export({
			format: "der",
			type: "pkcs8",
		});
		const targetPublic = target.publicKey.export({
			format: "der",
			type: "spki",
		});
		const targetPrivate = target.privateKey.export({
			format: "der",
			type: "pkcs8",
		});
		const secretValue = randomBytes(32).toString("base64");
		const sourceRecord = createSecretEncryptorV1({
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: "key_source",
				keys: [
					{
						schemaVersion: 1,
						keyVersion: "key_source",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: sourcePublic.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(sourcePublic)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
		}).encrypt({
			schemaVersion: 1,
			secretId: "secret_01",
			ownerType: "agent-owner",
			ownerId: "owner_01",
			agentId: "agent_01",
			name: "MODEL_API_KEY",
			secretVersion: 2,
			configRevision: 7,
			plaintext: secretValue,
			occurredAt: "2026-09-05T13:00:00.000Z",
		});
		const crypto = createSecretKeyRotationCryptoV1({
			keys: [
				{
					keyVersion: "key_source",
					privateKeyPkcs8DerBase64: sourcePrivate.toString("base64"),
				},
				{
					keyVersion: "key_target",
					privateKeyPkcs8DerBase64: targetPrivate.toString("base64"),
				},
			],
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: "key_target",
				keys: [
					{
						schemaVersion: 1,
						keyVersion: "key_source",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: sourcePublic.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(sourcePublic)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "retiring",
					},
					{
						schemaVersion: 1,
						keyVersion: "key_target",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: targetPublic.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(targetPublic)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
			now: () => new Date("2026-09-05T13:30:00.000Z"),
		});
		expect(crypto.retiringWrappingKeyVersions).toEqual(["key_source"]);

		const decision = await crypto.reencrypt({
			encryptedRecord: sourceRecord,
			targetKeyVersion: "key_target",
			traceId: "trace_rotation_01",
		});

		expect(decision.outcome).toBe("reencrypted");
		if (decision.outcome !== "reencrypted") throw new Error("Expected record");
		const rotated = decision.encryptedRecord as typeof sourceRecord;
		expect(rotated.crypto).toMatchObject({ wrappingKeyVersion: "key_target" });
		expect(rotated.crypto.dekFingerprint).not.toBe(
			sourceRecord.crypto.dekFingerprint,
		);
		expect(rotated.updatedAt).toBe("2026-09-05T13:30:00.000Z");
		expect(JSON.stringify(decision)).not.toContain(secretValue);
		const decryption = await createSecretKeyringDecryptorV1({
			keys: [
				{
					keyVersion: "key_target",
					privateKeyPkcs8DerBase64: targetPrivate.toString("base64"),
				},
			],
		}).decrypt({
			encryptedRecord: rotated,
			traceId: "trace_rotation_01",
		});
		expect(decryption.outcome).toBe("decrypted");
		if (decryption.outcome !== "decrypted")
			throw new Error("Expected plaintext");
		expect(
			createHash("sha256").update(decryption.plaintext).digest("hex"),
		).toBe(createHash("sha256").update(secretValue).digest("hex"));
		decryption.plaintext.fill(0);
	});

	it("rejects unavailable keys, corruption, and a cross-Agent ciphertext swap", async () => {
		const fixture = encryptedRecord();
		const target = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const targetPublic = target.publicKey.export({
			format: "der",
			type: "spki",
		});
		const targetPrivate = target.privateKey.export({
			format: "der",
			type: "pkcs8",
		});
		const encryptionKeys = {
			schemaVersion: 1 as const,
			activeWrappingKeyVersion: "key_target",
			keys: [
				{
					schemaVersion: 1 as const,
					keyVersion: fixture.keyVersion,
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
					publicKeySpkiDerBase64: fixture.publicKeySpkiDerBase64,
					publicKeyFingerprint: fixture.publicKeyFingerprint,
					rsaModulusBits: 3072,
					status: "retiring" as const,
				},
				{
					schemaVersion: 1 as const,
					keyVersion: "key_target",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
					publicKeySpkiDerBase64: targetPublic.toString("base64"),
					publicKeyFingerprint: createHash("sha256")
						.update(targetPublic)
						.digest("hex"),
					rsaModulusBits: 3072,
					status: "active" as const,
				},
			],
		};
		const crypto = createSecretKeyRotationCryptoV1({
			keys: [
				{
					keyVersion: fixture.keyVersion,
					privateKeyPkcs8DerBase64: fixture.privateKeyPkcs8DerBase64,
				},
				{
					keyVersion: "key_target",
					privateKeyPkcs8DerBase64: targetPrivate.toString("base64"),
				},
			],
			encryptionKeys,
		});
		const missingKeyCrypto = createSecretKeyRotationCryptoV1({
			keys: [
				{
					keyVersion: "key_target",
					privateKeyPkcs8DerBase64: targetPrivate.toString("base64"),
				},
			],
			encryptionKeys,
		});
		const swapped = {
			...fixture.record,
			agentId: "agent_02",
			crypto: {
				...fixture.record.crypto,
				aadBinding: {
					...fixture.record.crypto.aadBinding,
					agentId: "agent_02",
				},
			},
		};

		await expect(
			missingKeyCrypto.reencrypt({
				encryptedRecord: fixture.record,
				targetKeyVersion: "key_target",
				traceId: "trace_rotation_01",
			}),
		).resolves.toEqual({
			outcome: "failed",
			code: "SECRET_KEY_UNAVAILABLE",
		});
		for (const encryptedRecord of [fixture.tamperedRecord, swapped]) {
			await expect(
				crypto.reencrypt({
					encryptedRecord,
					targetKeyVersion: "key_target",
					traceId: "trace_rotation_01",
				}),
			).resolves.toEqual({
				outcome: "failed",
				code: "SECRET_AUTHENTICATION_FAILED",
			});
		}
		expect(() =>
			createSecretKeyRotationCryptoV1({
				keys: [
					{
						keyVersion: "key_target",
						privateKeyPkcs8DerBase64: fixture.privateKeyPkcs8DerBase64,
					},
				],
				encryptionKeys,
			}),
		).toThrow("Secret rotation keys are invalid");
	});
});
