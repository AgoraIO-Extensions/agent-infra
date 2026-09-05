import { Buffer } from "node:buffer";
import {
	constants,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	privateDecrypt,
	timingSafeEqual,
} from "node:crypto";

import {
	validatePlatformSecretRecordV1,
	validateSecretEncryptionKeySetV1,
} from "@agent-infra/contracts/workload";
import type {
	SecretActivationDecryptorPortV1,
	SecretKeyRotationCryptoPortV1,
} from "@agent-infra/platform-core";
import {
	encodeSecretAadV1,
	reencryptSecretRecordV1,
} from "@agent-infra/secret-store";

interface WorkerPrivateKeyV1 {
	readonly keyVersion: string;
	readonly privateKey: KeyObject;
}

export function createWorkerSecretDecryptorV1(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
}): SecretActivationDecryptorPortV1 {
	return workerDecryptor(parseKeyring(input), false);
}

export function createWorkerSecretRotationCryptoV1(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
	readonly encryptionKeys: unknown;
	readonly now?: () => Date;
}): SecretKeyRotationCryptoPortV1 {
	let encryptionKeys: ReturnType<typeof validateSecretEncryptionKeySetV1>;
	let decryptor: SecretActivationDecryptorPortV1;
	try {
		const keyring = parseKeyring(input);
		encryptionKeys = validateSecretEncryptionKeySetV1(input.encryptionKeys);
		const targetKey = keyring.get(encryptionKeys.activeWrappingKeyVersion);
		const targetDescriptor = encryptionKeys.keys.find(
			({ keyVersion }) =>
				keyVersion === encryptionKeys.activeWrappingKeyVersion,
		);
		if (!targetKey || !targetDescriptor) throw new Error();
		const derivedPublicKey = createPublicKey(targetKey).export({
			format: "der",
			type: "spki",
		});
		try {
			if (
				createHash("sha256").update(derivedPublicKey).digest("hex") !==
				targetDescriptor.publicKeyFingerprint
			) {
				throw new Error();
			}
		} finally {
			derivedPublicKey.fill(0);
		}
		decryptor = workerDecryptor(keyring, true);
	} catch {
		throw new TypeError("Worker Secret rotation keys are invalid");
	}
	const now = input.now ?? (() => new Date());
	return {
		async reencrypt({ encryptedRecord, targetKeyVersion, traceId }) {
			if (targetKeyVersion !== encryptionKeys.activeWrappingKeyVersion) {
				return { outcome: "failed", code: "SECRET_ROTATION_FAILED" };
			}
			const decrypted = await decryptor.decrypt({ encryptedRecord, traceId });
			if (decrypted.outcome === "failed") return decrypted;
			try {
				const occurredAt = now();
				if (!Number.isFinite(Date.prototype.getTime.call(occurredAt))) {
					throw new Error();
				}
				return {
					outcome: "reencrypted",
					encryptedRecord: reencryptSecretRecordV1({
						encryptionKeys,
						record: encryptedRecord,
						plaintext: decrypted.plaintext,
						occurredAt: occurredAt.toISOString(),
					}),
				};
			} catch {
				return { outcome: "failed", code: "SECRET_ROTATION_FAILED" };
			} finally {
				decrypted.plaintext.fill(0);
			}
		},
	};
}

function workerDecryptor(
	keys: ReadonlyMap<string, KeyObject>,
	allowActive: boolean,
): SecretActivationDecryptorPortV1 {
	return {
		async decrypt({ encryptedRecord }) {
			let record: ReturnType<typeof validatePlatformSecretRecordV1>;
			try {
				record = validatePlatformSecretRecordV1(encryptedRecord);
				if (!allowActive && record.lifecycleState === "active")
					throw new Error();
			} catch {
				return { outcome: "failed", code: "SECRET_METADATA_INVALID" };
			}
			const key = keys.get(record.crypto.wrappingKeyVersion);
			if (!key) {
				return { outcome: "failed", code: "SECRET_KEY_UNAVAILABLE" };
			}
			let dek: Buffer | undefined;
			const plaintextChunks: Buffer[] = [];
			try {
				dek = privateDecrypt(
					{
						key,
						padding: constants.RSA_PKCS1_OAEP_PADDING,
						oaepHash: "sha256",
					},
					Buffer.from(record.crypto.wrappedDek, "base64"),
				);
				const fingerprint = Buffer.from(
					createHash("sha256").update(dek).digest("hex"),
					"utf8",
				);
				const expectedFingerprint = Buffer.from(
					record.crypto.dekFingerprint,
					"utf8",
				);
				if (
					dek.byteLength !== 32 ||
					fingerprint.byteLength !== expectedFingerprint.byteLength ||
					!timingSafeEqual(fingerprint, expectedFingerprint)
				) {
					throw new Error();
				}
				const decipher = createDecipheriv(
					"aes-256-gcm",
					dek,
					Buffer.from(record.crypto.nonce, "base64"),
					{ authTagLength: 16 },
				);
				decipher.setAAD(encodeSecretAadV1(record.crypto.aadBinding));
				decipher.setAuthTag(
					Buffer.from(record.crypto.authenticationTag, "base64"),
				);
				plaintextChunks.push(
					decipher.update(Buffer.from(record.crypto.ciphertext, "base64")),
				);
				plaintextChunks.push(decipher.final());
				return {
					outcome: "decrypted",
					plaintext: Buffer.concat(plaintextChunks),
				};
			} catch {
				return { outcome: "failed", code: "SECRET_AUTHENTICATION_FAILED" };
			} finally {
				dek?.fill(0);
				for (const chunk of plaintextChunks) chunk.fill(0);
			}
		},
	};
}

function parseKeyring(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
}): ReadonlyMap<string, KeyObject> {
	try {
		if (!Array.isArray(input.keys) || input.keys.length === 0)
			throw new Error();
		const parsed: WorkerPrivateKeyV1[] = input.keys.map((descriptor) => {
			if (
				!descriptor ||
				typeof descriptor !== "object" ||
				Object.keys(descriptor).length !== 2 ||
				typeof descriptor.keyVersion !== "string" ||
				descriptor.keyVersion.length === 0 ||
				descriptor.keyVersion.length > 1024 ||
				descriptor.keyVersion.includes("\0") ||
				!String.prototype.isWellFormed.call(descriptor.keyVersion) ||
				typeof descriptor.privateKeyPkcs8DerBase64 !== "string"
			) {
				throw new Error();
			}
			const encoded = Buffer.from(
				descriptor.privateKeyPkcs8DerBase64,
				"base64",
			);
			if (encoded.toString("base64") !== descriptor.privateKeyPkcs8DerBase64) {
				throw new Error();
			}
			let privateKey: KeyObject;
			try {
				privateKey = createPrivateKey({
					key: encoded,
					format: "der",
					type: "pkcs8",
				});
				const canonical = privateKey.export({ format: "der", type: "pkcs8" });
				try {
					if (
						privateKey.asymmetricKeyType !== "rsa" ||
						(privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
						!canonical.equals(encoded)
					) {
						throw new Error();
					}
				} finally {
					canonical.fill(0);
				}
			} finally {
				encoded.fill(0);
			}
			return { keyVersion: descriptor.keyVersion, privateKey };
		});
		if (
			new Set(parsed.map(({ keyVersion }) => keyVersion)).size !== parsed.length
		) {
			throw new Error();
		}
		return new Map(
			parsed.map(({ keyVersion, privateKey }) => [keyVersion, privateKey]),
		);
	} catch {
		throw new TypeError("Worker Secret keyring is invalid");
	}
}
