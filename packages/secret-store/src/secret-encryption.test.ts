import { Buffer } from "node:buffer";
import {
	constants,
	createDecipheriv,
	createHash,
	generateKeyPairSync,
	privateDecrypt,
} from "node:crypto";

import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import { describe, expect, it } from "vitest";
import * as secretStore from "./index.js";
import {
	createSecretEncryptorV1,
	encodeSecretAadV1,
	reencryptSecretRecordV1,
} from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
const plaintext = "v1 secret value must never persist";

const { privateKey: replacementPrivateKey, publicKey: replacementPublicKey } =
	generateKeyPairSync("rsa", { modulusLength: 3072 });
const replacementPublicKeyDer = replacementPublicKey.export({
	format: "der",
	type: "spki",
});

const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: "key-2026-09",
		keys: [
			{
				schemaVersion: 1,
				keyVersion: "key-2026-09",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				publicKeySpkiDerBase64: publicKeySpkiDer.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(publicKeySpkiDer)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active",
			},
		],
	},
});

function unwrapDek(record: ReturnType<typeof encryptor.encrypt>): Buffer {
	const dek = privateDecrypt(
		{
			key: privateKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(record.crypto.wrappedDek, "base64"),
	);
	expect(dek).toHaveLength(32);
	expect(createHash("sha256").update(dek).digest("hex")).toBe(
		record.crypto.dekFingerprint,
	);
	return dek;
}

function decrypt(
	record: ReturnType<typeof encryptor.encrypt>,
	dek: Buffer,
	aadBinding: unknown = record.crypto.aadBinding,
) {
	const decipher = createDecipheriv(
		"aes-256-gcm",
		dek,
		Buffer.from(record.crypto.nonce, "base64"),
		{ authTagLength: 16 },
	);
	decipher.setAAD(encodeSecretAadV1(aadBinding));
	decipher.setAuthTag(Buffer.from(record.crypto.authenticationTag, "base64"));
	return Buffer.concat([
		decipher.update(Buffer.from(record.crypto.ciphertext, "base64")),
		decipher.final(),
	]).toString("utf8");
}

describe("Secret encryptor V1", () => {
	it("creates a metadata-only pending record with fresh AES-GCM material", () => {
		const input = {
			schemaVersion: 1 as const,
			secretId: "secret_01",
			ownerType: "agent-owner" as const,
			ownerId: "user_01",
			agentId: "agent_01",
			name: "MODEL_API_KEY",
			secretVersion: 2,
			configRevision: 7,
			plaintext,
			occurredAt: "2026-09-03T09:00:00Z",
		};
		const first = encryptor.encrypt(input);
		const second = encryptor.encrypt(input);

		expect(validatePlatformSecretRecordV1(first)).toEqual(first);
		expect(first).toMatchObject({
			schemaVersion: 1,
			lifecycleState: "pending",
			crypto: {
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "key-2026-09",
			},
		});
		expect(Buffer.from(first.crypto.nonce, "base64")).toHaveLength(12);
		expect(Buffer.from(first.crypto.authenticationTag, "base64")).toHaveLength(
			16,
		);
		expect(JSON.stringify(first)).not.toContain(plaintext);
		expect(JSON.stringify(first)).not.toContain(publicKeyPem);
		expect(JSON.stringify(first)).not.toContain(privateKeyPem);
		expect(first.crypto.nonce).not.toBe(second.crypto.nonce);
		expect(first.crypto.dekFingerprint).not.toBe(second.crypto.dekFingerprint);

		expect(decrypt(first, unwrapDek(first))).toBe(plaintext);
		expect(decrypt(second, unwrapDek(second))).toBe(plaintext);
	});

	it("uses the fixed canonical AAD and rejects a changed binding", () => {
		const record = encryptor.encrypt({
			schemaVersion: 1,
			secretId: "secret_01",
			ownerType: "agent-owner",
			ownerId: "user_01",
			agentId: "agent_01",
			name: "MODEL_API_KEY",
			secretVersion: 2,
			configRevision: 7,
			plaintext,
			occurredAt: "2026-09-03T09:00:00Z",
		});
		const dek = unwrapDek(record);

		expect(encodeSecretAadV1(record.crypto.aadBinding).toString("hex")).toBe(
			[
				"0000000131",
				"00000016706c6174666f726d2d7365637265742d6161643a7631",
				"000000097365637265745f3031",
				"0000000b6167656e742d6f776e6572",
				"00000007757365725f3031",
				"000000086167656e745f3031",
				"0000000d4d4f44454c5f4150495f4b4559",
				"0000000132",
				"0000000137",
				"0000000e6165732d3235362d67636d3a7631",
				"000000127273612d6f6165702d7368613235363a7631",
				"0000000b6b65792d323032362d3039",
			].join(""),
		);
		expect(decrypt(record, dek)).toBe(plaintext);
		for (const aadBinding of [
			{ ...record.crypto.aadBinding, agentId: "agent_02" },
			{ ...record.crypto.aadBinding, configRevision: 8 },
			{ ...record.crypto.aadBinding, wrappingKeyVersion: "key-2026-10" },
		]) {
			expect(() => decrypt(record, dek, aadBinding)).toThrow();
		}
		expect(() =>
			encodeSecretAadV1({
				...record.crypto.aadBinding,
				configRevision: Number.MAX_SAFE_INTEGER + 1,
			}),
		).toThrow("Secret AAD binding is invalid");
	});

	it("re-encrypts an active record with fresh material and preserves its activation", () => {
		const pending = encryptor.encrypt({
			schemaVersion: 1,
			secretId: "secret_01",
			ownerType: "agent-owner",
			ownerId: "user_01",
			agentId: "agent_01",
			name: "MODEL_API_KEY",
			secretVersion: 2,
			configRevision: 7,
			plaintext,
			occurredAt: "2026-09-03T09:00:00Z",
		});
		const kubernetesSecretRef = {
			schemaVersion: 1 as const,
			ownerType: pending.ownerType,
			ownerId: pending.ownerId,
			agentId: pending.agentId,
			secretId: pending.secretId,
			secretVersion: pending.secretVersion,
			configRevision: pending.configRevision,
			algorithmVersion: pending.crypto.algorithmVersion,
			wrappingAlgorithmVersion: pending.crypto.wrappingAlgorithmVersion,
			wrappingKeyVersion: pending.crypto.wrappingKeyVersion,
			name: "agent-secret-v2-r7",
		};
		const active = validatePlatformSecretRecordV1({
			...pending,
			lifecycleState: "active",
			kubernetesSecretRef,
			activationFence: {
				schemaVersion: 1,
				agentId: pending.agentId,
				secretId: pending.secretId,
				secretVersion: pending.secretVersion,
				configRevision: pending.configRevision,
				kubernetesSecretName: kubernetesSecretRef.name,
				workloadUid: "workload_01",
				workloadGeneration: 3,
				fence: 5,
			},
		});
		if (active.lifecycleState !== "active") throw new Error("Expected active");
		const plaintextBytes = Buffer.from(plaintext);

		const rotated = reencryptSecretRecordV1({
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: "key-2026-10",
				keys: [
					{
						schemaVersion: 1,
						keyVersion: "key-2026-10",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: replacementPublicKeyDer.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(replacementPublicKeyDer)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
			record: active,
			plaintext: plaintextBytes,
			occurredAt: "2026-09-05T13:15:00Z",
		});

		expect(rotated).toMatchObject({
			secretId: active.secretId,
			agentId: active.agentId,
			secretVersion: active.secretVersion,
			configRevision: active.configRevision,
			lifecycleState: "active",
			kubernetesSecretRef: {
				...kubernetesSecretRef,
				wrappingKeyVersion: "key-2026-10",
			},
			activationFence: active.activationFence,
			crypto: { wrappingKeyVersion: "key-2026-10" },
			updatedAt: "2026-09-05T13:15:00Z",
		});
		expect(rotated.crypto.dekFingerprint).not.toBe(
			active.crypto.dekFingerprint,
		);
		expect(rotated.crypto.nonce).not.toBe(active.crypto.nonce);
		const replacementDek = privateDecrypt(
			{
				key: replacementPrivateKey,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			Buffer.from(rotated.crypto.wrappedDek, "base64"),
		);
		expect(decrypt(rotated, replacementDek)).toBe(plaintext);
		expect(plaintextBytes.toString()).toBe(plaintext);
		expect(JSON.stringify(rotated)).not.toContain(plaintext);
	});

	it("fails closed for invalid inputs and exposes no decrypt operation", () => {
		expect(() =>
			createSecretEncryptorV1({
				encryptionKeys: {
					schemaVersion: 1,
					activeWrappingKeyVersion: "key-missing",
					keys: [],
				},
			}),
		).toThrow("Secret encryption keys are invalid");
		expect(() =>
			createSecretEncryptorV1({
				encryptionKeys: {
					schemaVersion: 1,
					activeWrappingKeyVersion: "key-2026-09",
					keys: [
						{
							schemaVersion: 1,
							keyVersion: "key-2026-09",
							wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
							publicKeySpkiDerBase64: publicKeySpkiDer.toString("base64"),
							publicKeyFingerprint: "0".repeat(64),
							rsaModulusBits: 3072,
							status: "active",
						},
					],
				},
			}),
		).toThrow("Secret encryption keys are invalid");
		expect(() =>
			encryptor.encrypt({
				schemaVersion: 1,
				secretId: "secret_01",
				ownerType: "agent-owner",
				ownerId: "user_01",
				agentId: "agent_01",
				name: "MODEL_API_KEY",
				secretVersion: 2,
				configRevision: 7,
				plaintext,
				occurredAt: "not-a-timestamp",
			}),
		).toThrow("Secret encryption input is invalid");
		expect(Object.keys(secretStore).toSorted()).toEqual([
			"createSecretEncryptorV1",
			"encodeSecretAadV1",
			"reencryptSecretRecordV1",
		]);
	});
});
