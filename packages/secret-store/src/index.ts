import { Buffer } from "node:buffer";
import {
	constants,
	createCipheriv,
	createHash,
	createPublicKey,
	type KeyObject,
	publicEncrypt,
	randomBytes,
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
