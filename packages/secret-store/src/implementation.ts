import { Buffer } from "node:buffer";
import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	privateDecrypt,
	publicEncrypt,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";

import {
	type PlatformSecretRecordV1,
	SecretAadBindingV1Schema,
	validatePlatformSecretRecordV1,
	validateSecretEncryptionKeySetV1,
	WorkloadTimestampV1Schema,
} from "@agent-infra/contracts/workload";

const algorithmVersion = "aes-256-gcm:v1";
const wrappingAlgorithmVersion = "rsa-oaep-sha256:v1";
const aadVersion = "platform-secret-aad:v1";
const dekBytes = 32;
const nonceBytes = 12;
const authenticationTagBytes = 16;

type SecretAadBindingV1 = ReturnType<typeof SecretAadBindingV1Schema.parse>;

interface ActiveWrappingKeyV1 {
	readonly keyVersion: string;
	readonly publicKey: KeyObject;
}

export interface SecretEncryptionInputV1 {
	readonly schemaVersion: 1;
	readonly secretId: string;
	readonly ownerType: "agent-owner" | "platform";
	readonly ownerId: string;
	readonly agentId: string;
	readonly name: string;
	readonly secretVersion: number;
	readonly configRevision: number;
	readonly plaintext: string;
	readonly occurredAt: string;
}

export interface SecretEncryptorV1 {
	encrypt(input: SecretEncryptionInputV1): PlatformSecretRecordV1;
}

export interface SecretReencryptionInputV1 {
	readonly encryptionKeys: unknown;
	readonly record: unknown;
	readonly plaintext: Uint8Array;
	readonly occurredAt: string;
}

export function createSecretEncryptorV1(options: {
	readonly encryptionKeys: unknown;
}): SecretEncryptorV1 {
	const activeKey = parseActiveWrappingKey(options);

	return {
		encrypt(input) {
			const parsed = parseEncryptionInput(input, activeKey.keyVersion);
			const plaintext = Buffer.from(parsed.plaintext, "utf8");
			try {
				return validatePlatformSecretRecordV1({
					schemaVersion: 1,
					secretId: parsed.aadBinding.secretId,
					ownerType: parsed.aadBinding.ownerType,
					ownerId: parsed.aadBinding.ownerId,
					agentId: parsed.aadBinding.agentId,
					name: parsed.aadBinding.name,
					secretVersion: parsed.aadBinding.secretVersion,
					configRevision: parsed.aadBinding.configRevision,
					lifecycleState: "pending",
					crypto: encryptBytes(parsed.aadBinding, plaintext, activeKey),
					createdAt: parsed.occurredAt,
					updatedAt: parsed.occurredAt,
				});
			} catch {
				throw new TypeError("Secret encryption failed");
			} finally {
				plaintext.fill(0);
			}
		},
	};
}

export function reencryptSecretRecordV1(
	input: SecretReencryptionInputV1,
): PlatformSecretRecordV1 {
	let plaintext: Buffer | undefined;
	try {
		const record = validatePlatformSecretRecordV1(input.record);
		const activeKey = parseActiveWrappingKey(input);
		if (
			!(input.plaintext instanceof Uint8Array) ||
			!WorkloadTimestampV1Schema.safeParse(input.occurredAt).success
		) {
			throw new Error();
		}
		plaintext = Buffer.from(input.plaintext);
		const aadBinding = SecretAadBindingV1Schema.parse({
			...record.crypto.aadBinding,
			wrappingKeyVersion: activeKey.keyVersion,
		});
		const kubernetesSecretRef =
			"kubernetesSecretRef" in record && record.kubernetesSecretRef
				? {
						...record.kubernetesSecretRef,
						wrappingKeyVersion: activeKey.keyVersion,
					}
				: undefined;
		return validatePlatformSecretRecordV1({
			...record,
			crypto: encryptBytes(aadBinding, plaintext, activeKey),
			...(kubernetesSecretRef === undefined ? {} : { kubernetesSecretRef }),
			updatedAt: input.occurredAt,
		});
	} catch {
		throw new TypeError("Secret re-encryption failed");
	} finally {
		plaintext?.fill(0);
	}
}

function encryptBytes(
	aadBinding: SecretAadBindingV1,
	plaintext: Buffer,
	activeKey: ActiveWrappingKeyV1,
) {
	const dek = randomBytes(dekBytes);
	try {
		const nonce = randomBytes(nonceBytes);
		const cipher = createCipheriv("aes-256-gcm", dek, nonce, {
			authTagLength: authenticationTagBytes,
		});
		cipher.setAAD(encodeSecretAadV1(aadBinding), {
			plaintextLength: plaintext.byteLength,
		});
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
		]);
		const authenticationTag = cipher.getAuthTag();
		const wrappedDek = publicEncrypt(
			{
				key: activeKey.publicKey,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
			},
			dek,
		);
		return {
			schemaVersion: 1 as const,
			algorithmVersion,
			wrappingAlgorithmVersion,
			wrappingKeyVersion: activeKey.keyVersion,
			aadBinding,
			dekFingerprint: createHash("sha256").update(dek).digest("hex"),
			nonce: nonce.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			authenticationTag: authenticationTag.toString("base64"),
			wrappedDek: wrappedDek.toString("base64"),
		};
	} finally {
		dek.fill(0);
	}
}

export function encodeSecretAadV1(input: unknown): Buffer {
	let binding: SecretAadBindingV1;
	try {
		binding = SecretAadBindingV1Schema.parse(input);
	} catch {
		throw new TypeError("Secret AAD binding is invalid");
	}
	if (
		!Number.isSafeInteger(binding.secretVersion) ||
		!Number.isSafeInteger(binding.configRevision)
	) {
		throw new TypeError("Secret AAD binding is invalid");
	}
	return Buffer.concat(
		[
			binding.schemaVersion.toString(10),
			aadVersion,
			binding.secretId,
			binding.ownerType,
			binding.ownerId,
			binding.agentId,
			binding.name,
			binding.secretVersion.toString(10),
			binding.configRevision.toString(10),
			binding.algorithmVersion,
			binding.wrappingAlgorithmVersion,
			binding.wrappingKeyVersion,
		].map(encodeLengthPrefixedUtf8),
	);
}

function parseActiveWrappingKey(input: {
	readonly encryptionKeys: unknown;
}): ActiveWrappingKeyV1 {
	try {
		const keySet = validateSecretEncryptionKeySetV1(input.encryptionKeys);
		const active = keySet.keys.find(
			({ keyVersion }) => keyVersion === keySet.activeWrappingKeyVersion,
		);
		if (!active) throw new Error();
		return {
			keyVersion: active.keyVersion,
			publicKey: createPublicKey({
				key: Buffer.from(active.publicKeySpkiDerBase64, "base64"),
				format: "der",
				type: "spki",
			}),
		};
	} catch {
		throw new TypeError("Secret encryption keys are invalid");
	}
}

function parseEncryptionInput(
	input: SecretEncryptionInputV1,
	wrappingKeyVersion: string,
): {
	readonly aadBinding: SecretAadBindingV1;
	readonly plaintext: string;
	readonly occurredAt: string;
} {
	try {
		if (
			typeof input.plaintext !== "string" ||
			!String.prototype.isWellFormed.call(input.plaintext) ||
			!WorkloadTimestampV1Schema.safeParse(input.occurredAt).success
		) {
			throw new Error();
		}
		return {
			aadBinding: SecretAadBindingV1Schema.parse({
				schemaVersion: input.schemaVersion,
				aadVersion,
				secretId: input.secretId,
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				agentId: input.agentId,
				name: input.name,
				secretVersion: input.secretVersion,
				configRevision: input.configRevision,
				algorithmVersion,
				wrappingAlgorithmVersion,
				wrappingKeyVersion,
			}),
			plaintext: input.plaintext,
			occurredAt: input.occurredAt,
		};
	} catch {
		throw new TypeError("Secret encryption input is invalid");
	}
}

function encodeLengthPrefixedUtf8(value: string): Buffer {
	if (!String.prototype.isWellFormed.call(value)) {
		throw new TypeError("Secret AAD binding is invalid");
	}
	const encoded = Buffer.from(value, "utf8");
	if (encoded.byteLength > 0xffff_ffff) {
		throw new TypeError("Secret AAD binding is invalid");
	}
	const prefix = Buffer.alloc(4);
	prefix.writeUInt32BE(encoded.byteLength);
	return Buffer.concat([prefix, encoded]);
}

export interface SecretKeyringDecryptorV1 {
	decrypt(input: {
		readonly encryptedRecord: unknown;
		readonly traceId: string;
	}): Promise<
		| { readonly outcome: "decrypted"; readonly plaintext: Uint8Array }
		| {
				readonly outcome: "failed";
				readonly code:
					| "SECRET_KEY_UNAVAILABLE"
					| "SECRET_METADATA_INVALID"
					| "SECRET_AUTHENTICATION_FAILED";
		  }
	>;
}

export interface SecretKeyRotationCryptoV1 {
	readonly activeWrappingKeyVersion: string;
	readonly retiringWrappingKeyVersions: readonly string[];
	reencrypt(input: {
		readonly encryptedRecord: unknown;
		readonly expectedBinding: {
			readonly agentId: string;
			readonly secretId: string;
			readonly secretVersion: number;
			readonly configRevision: number;
			readonly ownerType: "agent-owner" | "platform";
			readonly ownerId: string;
			readonly name: string;
		};
		readonly targetKeyVersion: string;
		readonly traceId: string;
	}): Promise<
		| {
				readonly outcome: "reencrypted";
				readonly attemptId: string;
				readonly encryptedRecord: unknown;
		  }
		| {
				readonly outcome: "failed";
				readonly attemptId: string;
				readonly code:
					| "SECRET_KEY_UNAVAILABLE"
					| "SECRET_METADATA_INVALID"
					| "SECRET_AUTHENTICATION_FAILED"
					| "SECRET_ROTATION_FAILED";
		  }
	>;
}

export function createSecretKeyringDecryptorV1(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
}): SecretKeyringDecryptorV1 {
	return secretKeyringDecryptor(parsePrivateKeyring(input), false);
}

export function createSecretKeyRotationCryptoV1(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
	readonly encryptionKeys: unknown;
	readonly now?: () => Date;
}): SecretKeyRotationCryptoV1 {
	let encryptionKeys: ReturnType<typeof validateSecretEncryptionKeySetV1>;
	let decryptor: SecretKeyringDecryptorV1;
	try {
		const keyring = parsePrivateKeyring(input);
		encryptionKeys = validateSecretEncryptionKeySetV1(input.encryptionKeys);
		for (const descriptor of encryptionKeys.keys) {
			const privateKey = keyring.get(descriptor.keyVersion);
			if (!privateKey) {
				if (descriptor.status === "active") throw new Error();
				continue;
			}
			const derivedPublicKey = createPublicKey(privateKey).export({
				format: "der",
				type: "spki",
			});
			try {
				if (
					createHash("sha256").update(derivedPublicKey).digest("hex") !==
					descriptor.publicKeyFingerprint
				) {
					throw new Error();
				}
			} finally {
				derivedPublicKey.fill(0);
			}
		}
		decryptor = secretKeyringDecryptor(keyring, true);
	} catch {
		throw new TypeError("Secret rotation keys are invalid");
	}
	const now = input.now ?? (() => new Date());
	return {
		activeWrappingKeyVersion: encryptionKeys.activeWrappingKeyVersion,
		retiringWrappingKeyVersions: encryptionKeys.keys
			.filter(({ status }) => status === "retiring")
			.map(({ keyVersion }) => keyVersion),
		async reencrypt({
			encryptedRecord,
			expectedBinding,
			targetKeyVersion,
			traceId,
		}) {
			const attemptId = randomUUID();
			if (targetKeyVersion !== encryptionKeys.activeWrappingKeyVersion) {
				return {
					outcome: "failed",
					attemptId,
					code: "SECRET_ROTATION_FAILED",
				};
			}
			let record: ReturnType<typeof validatePlatformSecretRecordV1>;
			try {
				record = validatePlatformSecretRecordV1(encryptedRecord);
				if (
					record.agentId !== expectedBinding.agentId ||
					record.secretId !== expectedBinding.secretId ||
					record.secretVersion !== expectedBinding.secretVersion ||
					record.configRevision !== expectedBinding.configRevision ||
					record.ownerType !== expectedBinding.ownerType ||
					record.ownerId !== expectedBinding.ownerId ||
					record.name !== expectedBinding.name
				) {
					throw new Error();
				}
			} catch {
				return {
					outcome: "failed",
					attemptId,
					code: "SECRET_METADATA_INVALID",
				};
			}
			const decrypted = await decryptor.decrypt({
				encryptedRecord: record,
				traceId,
			});
			if (decrypted.outcome === "failed") return { ...decrypted, attemptId };
			try {
				const occurredAt = now();
				if (!Number.isFinite(Date.prototype.getTime.call(occurredAt))) {
					throw new Error();
				}
				return {
					outcome: "reencrypted",
					attemptId,
					encryptedRecord: reencryptSecretRecordV1({
						encryptionKeys,
						record: encryptedRecord,
						plaintext: decrypted.plaintext,
						occurredAt: occurredAt.toISOString(),
					}),
				};
			} catch {
				return { outcome: "failed", attemptId, code: "SECRET_ROTATION_FAILED" };
			} finally {
				decrypted.plaintext.fill(0);
			}
		},
	};
}

function secretKeyringDecryptor(
	keys: ReadonlyMap<string, KeyObject>,
	allowActive: boolean,
): SecretKeyringDecryptorV1 {
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
			if (!key) return { outcome: "failed", code: "SECRET_KEY_UNAVAILABLE" };
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

function parsePrivateKeyring(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
}): ReadonlyMap<string, KeyObject> {
	try {
		if (!Array.isArray(input.keys) || input.keys.length === 0)
			throw new Error();
		const parsed = input.keys.map((descriptor) => {
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
		throw new TypeError("Secret keyring is invalid");
	}
}
