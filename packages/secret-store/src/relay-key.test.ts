import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
	createRelayKeyEncryptorV1,
	encodeRelayKeyAadV1,
	type RelayKeyBindingV1,
	type RelayKeyCiphertextV1,
} from "./index.js";
import { createRelayKeyWorkerDecryptorV1 } from "./worker.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
const privateKeyDer = privateKey.export({ format: "der", type: "pkcs8" });
const wrappingKeyVersion = "wrapping-2026-09";
const plaintextK1 = "sk-user-1-secret-K1";
const plaintextK2 = "sk-user-1-secret-K2";

const activeWrappingKey = {
	schemaVersion: 1 as const,
	keyVersion: wrappingKeyVersion,
	wrappingAlgorithmVersion: "rsa-oaep-sha256:v1" as const,
	publicKeySpkiDerBase64: publicKeyDer.toString("base64"),
	publicKeyFingerprint: createHash("sha256").update(publicKeyDer).digest("hex"),
	rsaModulusBits: 3072,
	status: "active" as const,
};

const encryptor = createRelayKeyEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: wrappingKeyVersion,
		keys: [activeWrappingKey],
	},
});
const decryptor = createRelayKeyWorkerDecryptorV1({
	keys: [
		{
			keyVersion: wrappingKeyVersion,
			privateKeyPkcs8DerBase64: privateKeyDer.toString("base64"),
		},
	],
});

function record(binding: RelayKeyBindingV1, plaintext: string) {
	return encryptor.encrypt({ ...binding, plaintext });
}

async function decrypt(
	encryptedRecord: unknown,
	expectedBinding: RelayKeyBindingV1,
	selectedDecryptor = decryptor,
) {
	const result = await selectedDecryptor.decrypt({
		encryptedRecord,
		expectedBinding,
	});
	if (result.outcome === "decrypted") {
		const value = Buffer.from(result.plaintext).toString("utf8");
		result.plaintext.fill(0);
		return value;
	}
	return result.code;
}

describe("Relay Key ciphertext V1", () => {
	it("retains independently encrypted K1 and K2 for the same subject", async () => {
		const binding = {
			purpose: "personal" as const,
			subjectId: "user_01",
			keyId: "relay-key-user-01",
		};
		const k1 = record({ ...binding, keyVersion: 1 }, plaintextK1);
		const k2 = record({ ...binding, keyVersion: 2 }, plaintextK2);
		expect(k1).toMatchObject({
			schemaVersion: 1,
			...binding,
			keyVersion: 1,
			crypto: {
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion,
				aadVersion: "relay-key-aad:v1",
			},
		});
		expect(k1.crypto.nonce).not.toBe(k2.crypto.nonce);
		expect(k1.crypto.dekFingerprint).not.toBe(k2.crypto.dekFingerprint);
		expect(JSON.stringify(k1)).not.toContain(plaintextK1);
		expect(JSON.stringify(k2)).not.toContain(plaintextK2);
		expect(await decrypt(k1, { ...binding, keyVersion: 1 })).toBe(plaintextK1);
		expect(await decrypt(k2, { ...binding, keyVersion: 2 })).toBe(plaintextK2);
		expect(await decrypt(k1, { ...binding, keyVersion: 2 })).toBe(
			"RELAY_KEY_METADATA_INVALID",
		);
	});

	it("keeps K1 readable across wrapping key rotation and fails closed without its private key", async () => {
		const rotatedPair = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const rotatedPublicDer = rotatedPair.publicKey.export({
			format: "der",
			type: "spki",
		});
		const rotatedPrivateDer = rotatedPair.privateKey.export({
			format: "der",
			type: "pkcs8",
		});
		const rotatedWrappingKeyVersion = "wrapping-2026-10";
		const rotatedEncryptor = createRelayKeyEncryptorV1({
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: rotatedWrappingKeyVersion,
				keys: [
					{ ...activeWrappingKey, status: "retiring" },
					{
						schemaVersion: 1,
						keyVersion: rotatedWrappingKeyVersion,
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: rotatedPublicDer.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(rotatedPublicDer)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
		});
		const binding = {
			purpose: "personal" as const,
			subjectId: "user_01",
			keyId: "relay-key-user-01",
		};
		const k1Binding = { ...binding, keyVersion: 1 };
		const k2Binding = {
			...binding,
			keyId: "relay-key-user-01-k2",
			keyVersion: 2,
		};
		const k1 = record(k1Binding, plaintextK1);
		const k2 = rotatedEncryptor.encrypt({
			...k2Binding,
			plaintext: plaintextK2,
		});
		const rotatedPrivateKey = {
			keyVersion: rotatedWrappingKeyVersion,
			privateKeyPkcs8DerBase64: rotatedPrivateDer.toString("base64"),
		};
		const bothKeys = createRelayKeyWorkerDecryptorV1({
			keys: [
				{
					keyVersion: wrappingKeyVersion,
					privateKeyPkcs8DerBase64: privateKeyDer.toString("base64"),
				},
				rotatedPrivateKey,
			],
		});
		const newKeyOnly = createRelayKeyWorkerDecryptorV1({
			keys: [rotatedPrivateKey],
		});
		expect(k1.crypto.wrappingKeyVersion).toBe(wrappingKeyVersion);
		expect(k2.crypto.wrappingKeyVersion).toBe(rotatedWrappingKeyVersion);
		expect(await decrypt(k1, k1Binding, bothKeys)).toBe(plaintextK1);
		expect(await decrypt(k2, k2Binding, bothKeys)).toBe(plaintextK2);
		expect(await decrypt(k1, k1Binding, newKeyOnly)).toBe(
			"RELAY_KEY_UNAVAILABLE",
		);
	});

	it("uses a fixed length-prefixed AAD encoding", () => {
		const binding: RelayKeyBindingV1 = {
			purpose: "personal",
			subjectId: "u",
			keyId: "k",
			keyVersion: 2,
		};
		expect(encodeRelayKeyAadV1(binding, "w").toString("hex")).toBe(
			[
				"0000000131",
				"0000001072656c61792d6b65792d6161643a7631",
				"00000008706572736f6e616c",
				"0000000175",
				"000000016b",
				"0000000132",
				"0000000e6165732d3235362d67636d3a7631",
				"000000127273612d6f6165702d7368613235363a7631",
				"0000000177",
			].join(""),
		);
	});

	it("rejects cross-user, cross-Agent, purpose and key-reference substitutions", async () => {
		const personal = record(
			{
				purpose: "personal",
				subjectId: "user_01",
				keyId: "personal_01",
				keyVersion: 1,
			},
			plaintextK1,
		);
		const agentDefault = record(
			{
				purpose: "agent-default",
				subjectId: "agent_01",
				keyId: "default_01",
				keyVersion: 1,
			},
			"sk-agent-default-K1",
		);
		for (const expected of [
			{ ...personal, subjectId: "user_02" },
			{ ...personal, purpose: "agent-default" as const },
			{ ...personal, keyId: "default_01" },
			{ ...personal, keyVersion: 2 },
		]) {
			expect(await decrypt(personal, expected)).toBe(
				"RELAY_KEY_METADATA_INVALID",
			);
		}
		for (const expected of [
			{ ...agentDefault, subjectId: "agent_02" },
			{ ...agentDefault, purpose: "personal" as const },
		]) {
			expect(await decrypt(agentDefault, expected)).toBe(
				"RELAY_KEY_METADATA_INVALID",
			);
		}
		expect(await decrypt(agentDefault, agentDefault)).toBe(
			"sk-agent-default-K1",
		);
	});

	it("rejects tampered authenticated fields and ciphertext without exposing Key text", async () => {
		const original = record(
			{
				purpose: "personal",
				subjectId: "user_01",
				keyId: "personal_01",
				keyVersion: 1,
			},
			plaintextK1,
		);
		const edits: RelayKeyCiphertextV1[] = [
			{ ...original, keyVersion: 2 },
			{ ...original, subjectId: "user_02" },
			{ ...original, purpose: "agent-default" },
			{ ...original, keyId: "personal_02" },
			{
				...original,
				crypto: {
					...original.crypto,
					authenticationTag: Buffer.alloc(16).toString("base64"),
				},
			},
			{
				...original,
				crypto: {
					...original.crypto,
					ciphertext: Buffer.alloc(plaintextK1.length).toString("base64"),
				},
			},
			{
				...original,
				crypto: {
					...original.crypto,
					wrappingKeyVersion: "other-wrapping-key",
				},
			},
		];
		for (const changed of edits) {
			const result = await decryptor.decrypt({
				encryptedRecord: changed,
				expectedBinding: original,
			});
			expect(result.outcome).toBe("failed");
			expect(JSON.stringify(result)).not.toContain(plaintextK1);
		}
		for (const changed of edits.slice(0, 4)) {
			expect(await decrypt(changed, changed)).toBe(
				"RELAY_KEY_AUTHENTICATION_FAILED",
			);
		}
		expect(await decrypt({ ...original, unexpected: true }, original)).toBe(
			"RELAY_KEY_METADATA_INVALID",
		);
		expect(
			await decrypt(
				{
					...original,
					crypto: { ...original.crypto, algorithmVersion: "none" },
				},
				original,
			),
		).toBe("RELAY_KEY_METADATA_INVALID");
	});

	it("snapshots plain ciphertext metadata before decrypting", async () => {
		const binding = {
			purpose: "personal" as const,
			subjectId: "user_01",
			keyId: "personal_01",
			keyVersion: 1,
		};
		const encrypted = record(binding, plaintextK1);
		expect(await decrypt(JSON.parse(JSON.stringify(encrypted)), binding)).toBe(
			plaintextK1,
		);

		let getterReads = 0;
		const rootGetter = { ...encrypted };
		Object.defineProperty(rootGetter, "crypto", {
			enumerable: true,
			get() {
				getterReads += 1;
				return encrypted.crypto;
			},
		});
		const nestedGetter = { ...encrypted, crypto: { ...encrypted.crypto } };
		Object.defineProperty(nestedGetter.crypto, "wrappedDek", {
			enumerable: true,
			get() {
				getterReads += 1;
				return encrypted.crypto.wrappedDek;
			},
		});
		const hiddenField = { ...encrypted };
		Object.defineProperty(hiddenField, "hidden", { value: true });
		for (const hostile of [
			rootGetter,
			nestedGetter,
			{ ...encrypted, [Symbol("extra")]: true },
			{
				...encrypted,
				crypto: { ...encrypted.crypto, [Symbol("extra")]: true },
			},
			Object.assign(Object.create({ inherited: true }), encrypted),
			new Proxy({ ...encrypted }, {}),
			hiddenField,
		]) {
			expect(await decrypt(hostile, binding)).toBe(
				"RELAY_KEY_METADATA_INVALID",
			);
		}
		const expectedGetter = { ...binding };
		Object.defineProperty(expectedGetter, "subjectId", {
			enumerable: true,
			get() {
				getterReads += 1;
				return binding.subjectId;
			},
		});
		expect(await decrypt(encrypted, expectedGetter)).toBe(
			"RELAY_KEY_METADATA_INVALID",
		);
		const plaintextGetter = { ...binding, plaintext: plaintextK1 };
		Object.defineProperty(plaintextGetter, "plaintext", {
			enumerable: true,
			get() {
				getterReads += 1;
				return plaintextK1;
			},
		});
		expect(() => encryptor.encrypt(plaintextGetter)).toThrow(
			"Relay Key encryption input is invalid",
		);
		expect(getterReads).toBe(0);
	});

	it("rejects malformed inputs and keeps decrypt off the main export", () => {
		expect(() =>
			record(
				{
					purpose: "personal",
					subjectId: "user_01",
					keyId: "key_01",
					keyVersion: 0,
				},
				plaintextK1,
			),
		).toThrow("Relay Key encryption input is invalid");
		expect(() =>
			record(
				{
					purpose: "personal",
					subjectId: "user_01",
					keyId: "key_01",
					keyVersion: 1,
				},
				"short",
			),
		).toThrow("Relay Key encryption input is invalid");
		for (const value of [
			" leading-space-secret",
			"trailing-space-secret ",
			"embedded space-secret",
		]) {
			expect(() =>
				record(
					{
						purpose: "personal",
						subjectId: "user_01",
						keyId: "key_01",
						keyVersion: 1,
					},
					value,
				),
			).toThrow("Relay Key encryption input is invalid");
		}
		expect(() =>
			encodeRelayKeyAadV1(
				{
					purpose: "personal",
					subjectId: "user_01",
					keyId: "key_01",
					keyVersion: 1.5,
				},
				wrappingKeyVersion,
			),
		).toThrow("Relay Key AAD binding is invalid");
		expect(() =>
			encodeRelayKeyAadV1(
				{
					purpose: "personal",
					subjectId: "\u{1F600}".repeat(260),
					keyId: "key_01",
					keyVersion: 1,
				},
				wrappingKeyVersion,
			),
		).toThrow("Relay Key AAD binding is invalid");
	});
});
