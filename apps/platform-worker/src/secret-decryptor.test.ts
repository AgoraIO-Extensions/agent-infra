import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { describe, expect, it } from "vitest";

import { createWorkerSecretDecryptorV1 } from "./secret-decryptor.js";

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
	return {
		decryptor: createWorkerSecretDecryptorV1({
			keys: [
				{
					keyVersion,
					privateKeyPkcs8DerBase64: privateDer.toString("base64"),
				},
			],
		}),
		missingKeyDecryptor: createWorkerSecretDecryptorV1({
			keys: [
				{
					keyVersion: "other_key",
					privateKeyPkcs8DerBase64: privateDer.toString("base64"),
				},
			],
		}),
		plaintextDigest: createHash("sha256").update(plaintext).digest("hex"),
		record: encryptor.encrypt({
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
		}),
	};
}

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

		const tampered = {
			...fixture.record,
			crypto: {
				...fixture.record.crypto,
				ciphertext: `${fixture.record.crypto.ciphertext.slice(0, -4)}AAAA`,
			},
		};
		await expect(
			fixture.decryptor.decrypt({
				encryptedRecord: tampered,
				traceId: "trace_01",
			}),
		).resolves.toEqual({
			outcome: "failed",
			code: "SECRET_AUTHENTICATION_FAILED",
		});
	});
});
