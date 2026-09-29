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
	timingSafeEqual,
} from "node:crypto";
import { types } from "node:util";

import { validateSecretEncryptionKeySetV1 } from "@agent-infra/contracts/workload";

const algorithmVersion = "aes-256-gcm:v1";
const wrappingAlgorithmVersion = "rsa-oaep-sha256:v1";
const aadVersion = "relay-key-aad:v1";

export type RelayKeyPurposeV1 = "personal" | "agent-default";

export interface RelayKeyBindingV1 {
	readonly purpose: RelayKeyPurposeV1;
	readonly subjectId: string;
	readonly keyId: string;
	readonly keyVersion: number;
}

export interface RelayKeyCiphertextV1 extends RelayKeyBindingV1 {
	readonly schemaVersion: 1;
	readonly crypto: {
		readonly schemaVersion: 1;
		readonly algorithmVersion: "aes-256-gcm:v1";
		readonly wrappingAlgorithmVersion: "rsa-oaep-sha256:v1";
		readonly wrappingKeyVersion: string;
		readonly aadVersion: "relay-key-aad:v1";
		readonly dekFingerprint: string;
		readonly nonce: string;
		readonly ciphertext: string;
		readonly authenticationTag: string;
		readonly wrappedDek: string;
	};
}

export interface RelayKeyEncryptionInputV1 extends RelayKeyBindingV1 {
	readonly plaintext: string;
}

export interface RelayKeyEncryptorV1 {
	encrypt(input: RelayKeyEncryptionInputV1): RelayKeyCiphertextV1;
}

export interface RelayKeyWorkerDecryptorV1 {
	decrypt(input: {
		readonly encryptedRecord: unknown;
		readonly expectedBinding: RelayKeyBindingV1;
	}): Promise<
		| { readonly outcome: "decrypted"; readonly plaintext: Uint8Array }
		| {
				readonly outcome: "failed";
				readonly code:
					| "RELAY_KEY_METADATA_INVALID"
					| "RELAY_KEY_UNAVAILABLE"
					| "RELAY_KEY_AUTHENTICATION_FAILED";
		  }
	>;
}

export function createRelayKeyEncryptorV1(options: {
	readonly encryptionKeys: unknown;
}): RelayKeyEncryptorV1 {
	let activeKey: { readonly keyVersion: string; readonly publicKey: KeyObject };
	try {
		const keySet = validateSecretEncryptionKeySetV1(options.encryptionKeys);
		const descriptor = keySet.keys.find(
			({ keyVersion }) => keyVersion === keySet.activeWrappingKeyVersion,
		);
		if (!descriptor) throw new Error();
		activeKey = {
			keyVersion: descriptor.keyVersion,
			publicKey: createPublicKey({
				key: Buffer.from(descriptor.publicKeySpkiDerBase64, "base64"),
				format: "der",
				type: "spki",
			}),
		};
	} catch {
		throw new TypeError("Relay Key encryption keys are invalid");
	}

	return {
		encrypt(input) {
			let binding: RelayKeyBindingV1;
			let plaintextValue: string;
			try {
				const source = exactObject(input, [
					"purpose",
					"subjectId",
					"keyId",
					"keyVersion",
					"plaintext",
				]);
				binding = parseBinding(source);
				if (
					typeof source.plaintext !== "string" ||
					source.plaintext.length < 16 ||
					source.plaintext.length > 8192 ||
					!/^[\x21-\x7e]+$/.test(source.plaintext)
				) {
					throw new Error();
				}
				plaintextValue = source.plaintext;
			} catch {
				throw new TypeError("Relay Key encryption input is invalid");
			}
			const plaintext = Buffer.from(plaintextValue, "utf8");
			const dek = randomBytes(32);
			try {
				const nonce = randomBytes(12);
				const cipher = createCipheriv("aes-256-gcm", dek, nonce, {
					authTagLength: 16,
				});
				cipher.setAAD(encodeRelayKeyAadV1(binding, activeKey.keyVersion), {
					plaintextLength: plaintext.byteLength,
				});
				const ciphertext = Buffer.concat([
					cipher.update(plaintext),
					cipher.final(),
				]);
				return {
					schemaVersion: 1,
					...binding,
					crypto: {
						schemaVersion: 1,
						algorithmVersion,
						wrappingAlgorithmVersion,
						wrappingKeyVersion: activeKey.keyVersion,
						aadVersion,
						dekFingerprint: createHash("sha256").update(dek).digest("hex"),
						nonce: nonce.toString("base64"),
						ciphertext: ciphertext.toString("base64"),
						authenticationTag: cipher.getAuthTag().toString("base64"),
						wrappedDek: publicEncrypt(
							{
								key: activeKey.publicKey,
								padding: constants.RSA_PKCS1_OAEP_PADDING,
								oaepHash: "sha256",
							},
							dek,
						).toString("base64"),
					},
				};
			} catch {
				throw new TypeError("Relay Key encryption failed");
			} finally {
				dek.fill(0);
				plaintext.fill(0);
			}
		},
	};
}

export function createRelayKeyWorkerDecryptorV1(input: {
	readonly keys: readonly {
		readonly keyVersion: string;
		readonly privateKeyPkcs8DerBase64: string;
	}[];
}): RelayKeyWorkerDecryptorV1 {
	const keys = parsePrivateKeyring(input);
	return {
		async decrypt({ encryptedRecord, expectedBinding }) {
			let record: RelayKeyCiphertextV1;
			try {
				record = parseRecord(encryptedRecord);
				const expected = parseBinding(expectedBinding);
				if (
					record.purpose !== expected.purpose ||
					record.subjectId !== expected.subjectId ||
					record.keyId !== expected.keyId ||
					record.keyVersion !== expected.keyVersion
				) {
					throw new Error();
				}
			} catch {
				return { outcome: "failed", code: "RELAY_KEY_METADATA_INVALID" };
			}
			const key = keys.get(record.crypto.wrappingKeyVersion);
			if (!key) return { outcome: "failed", code: "RELAY_KEY_UNAVAILABLE" };
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
				const fingerprint = createHash("sha256").update(dek).digest();
				const expectedFingerprint = Buffer.from(
					record.crypto.dekFingerprint,
					"hex",
				);
				try {
					if (
						dek.byteLength !== 32 ||
						fingerprint.byteLength !== expectedFingerprint.byteLength ||
						!timingSafeEqual(fingerprint, expectedFingerprint)
					) {
						throw new Error();
					}
				} finally {
					fingerprint.fill(0);
					expectedFingerprint.fill(0);
				}
				const decipher = createDecipheriv(
					"aes-256-gcm",
					dek,
					Buffer.from(record.crypto.nonce, "base64"),
					{ authTagLength: 16 },
				);
				decipher.setAAD(
					encodeRelayKeyAadV1(record, record.crypto.wrappingKeyVersion),
				);
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
				return { outcome: "failed", code: "RELAY_KEY_AUTHENTICATION_FAILED" };
			} finally {
				dek?.fill(0);
				for (const chunk of plaintextChunks) chunk.fill(0);
			}
		},
	};
}

export function encodeRelayKeyAadV1(
	binding: RelayKeyBindingV1,
	wrappingKeyVersion: string,
): Buffer {
	let parsed: RelayKeyBindingV1;
	try {
		parsed = parseBinding(binding);
		if (!validId(wrappingKeyVersion)) throw new Error();
	} catch {
		throw new TypeError("Relay Key AAD binding is invalid");
	}
	return Buffer.concat(
		[
			"1",
			aadVersion,
			parsed.purpose,
			parsed.subjectId,
			parsed.keyId,
			parsed.keyVersion.toString(10),
			algorithmVersion,
			wrappingAlgorithmVersion,
			wrappingKeyVersion,
		].map((value) => {
			const encoded = Buffer.from(value, "utf8");
			const prefix = Buffer.alloc(4);
			prefix.writeUInt32BE(encoded.byteLength);
			return Buffer.concat([prefix, encoded]);
		}),
	);
}

function parseBinding(input: unknown): RelayKeyBindingV1 {
	const record = exactObject(
		input,
		["purpose", "subjectId", "keyId", "keyVersion"],
		false,
	);
	if (
		(record.purpose !== "personal" && record.purpose !== "agent-default") ||
		!validId(record.subjectId) ||
		!validId(record.keyId) ||
		typeof record.keyVersion !== "number" ||
		!Number.isSafeInteger(record.keyVersion) ||
		record.keyVersion < 1
	) {
		throw new Error();
	}
	return {
		purpose: record.purpose as RelayKeyPurposeV1,
		subjectId: record.subjectId as string,
		keyId: record.keyId as string,
		keyVersion: record.keyVersion as number,
	};
}

function parseRecord(input: unknown): RelayKeyCiphertextV1 {
	const record = exactObject(input, [
		"schemaVersion",
		"purpose",
		"subjectId",
		"keyId",
		"keyVersion",
		"crypto",
	]);
	if (record.schemaVersion !== 1) throw new Error();
	const binding = parseBinding(record);
	const crypto = exactObject(record.crypto, [
		"schemaVersion",
		"algorithmVersion",
		"wrappingAlgorithmVersion",
		"wrappingKeyVersion",
		"aadVersion",
		"dekFingerprint",
		"nonce",
		"ciphertext",
		"authenticationTag",
		"wrappedDek",
	]);
	if (
		crypto.schemaVersion !== 1 ||
		crypto.algorithmVersion !== algorithmVersion ||
		crypto.wrappingAlgorithmVersion !== wrappingAlgorithmVersion ||
		crypto.aadVersion !== aadVersion ||
		!validId(crypto.wrappingKeyVersion) ||
		typeof crypto.dekFingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(crypto.dekFingerprint) ||
		!canonicalBase64(crypto.nonce, 12) ||
		!canonicalBase64(crypto.ciphertext, undefined, 16, 8192) ||
		!canonicalBase64(crypto.authenticationTag, 16) ||
		!canonicalBase64(crypto.wrappedDek, undefined, 384, 8192)
	) {
		throw new Error();
	}
	return { schemaVersion: 1, ...binding, crypto } as RelayKeyCiphertextV1;
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
		const keys = input.keys.map((entry) => {
			const descriptor = exactObject(entry, [
				"keyVersion",
				"privateKeyPkcs8DerBase64",
			]);
			if (
				!validId(descriptor.keyVersion) ||
				!canonicalBase64(descriptor.privateKeyPkcs8DerBase64)
			) {
				throw new Error();
			}
			const encoded = Buffer.from(
				descriptor.privateKeyPkcs8DerBase64 as string,
				"base64",
			);
			try {
				const key = createPrivateKey({
					key: encoded,
					format: "der",
					type: "pkcs8",
				});
				const canonical = key.export({ format: "der", type: "pkcs8" });
				try {
					if (
						key.asymmetricKeyType !== "rsa" ||
						(key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072 ||
						!canonical.equals(encoded)
					)
						throw new Error();
				} finally {
					canonical.fill(0);
				}
				return [descriptor.keyVersion as string, key] as const;
			} finally {
				encoded.fill(0);
			}
		});
		if (new Set(keys.map(([version]) => version)).size !== keys.length)
			throw new Error();
		return new Map(keys);
	} catch {
		throw new TypeError("Relay Key keyring is invalid");
	}
}

function exactObject(
	input: unknown,
	keys: readonly string[],
	strict = true,
): Record<string, unknown> {
	if (
		input === null ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		types.isProxy(input) ||
		Object.getPrototypeOf(input) !== Object.prototype
	)
		throw new Error();
	const present = Reflect.ownKeys(input);
	if (strict ? present.length !== keys.length : present.length < keys.length)
		throw new Error();
	const snapshot: Record<string, unknown> = {};
	for (const key of present) {
		if (typeof key !== "string") throw new Error();
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
			throw new Error();
		Object.defineProperty(snapshot, key, {
			value: descriptor.value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	if (!keys.every((key) => Object.hasOwn(snapshot, key))) throw new Error();
	if (strict && !present.every((key) => keys.includes(key as string)))
		throw new Error();
	return snapshot;
}

function validId(input: unknown): input is string {
	return (
		typeof input === "string" &&
		Buffer.byteLength(input, "utf8") > 0 &&
		Buffer.byteLength(input, "utf8") <= 1024 &&
		!input.includes("\0") &&
		String.prototype.isWellFormed.call(input)
	);
}

function canonicalBase64(
	input: unknown,
	length?: number,
	minimumBytes = 1,
	maximumBytes = 65536,
): input is string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.length > Math.ceil(maximumBytes / 3) * 4
	)
		return false;
	const decoded = Buffer.from(input, "base64");
	return (
		decoded.byteLength >= minimumBytes &&
		decoded.byteLength <= maximumBytes &&
		(length === undefined || decoded.byteLength === length) &&
		decoded.toString("base64") === input
	);
}
