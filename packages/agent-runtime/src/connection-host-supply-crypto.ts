import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const contextId = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => String.prototype.isWellFormed.call(value));
const positiveInteger = z.number().int().positive().safe();
const bindingSchema = z.strictObject({
	deploymentIdentity: contextId,
	hostRef: contextId,
	sandboxId: contextId,
	podUid: contextId,
	sessionGeneration: positiveInteger,
	resourceFence: positiveInteger,
	supplyRef: contextId,
	supplyRevision: contextId,
	attemptId: contextId,
	templateDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const maxCiphertextBytes = 8192;
const envelopeSchema = z.strictObject({
	nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
	ciphertext: z
		.string()
		.max(Math.ceil((maxCiphertextBytes * 4) / 3))
		.regex(/^[A-Za-z0-9_-]+$/),
	tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});

export type ConnectionHostSupplyBindingV1 = z.infer<typeof bindingSchema>;

function invalidSupply(): never {
	throw new Error("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
}

function lengthPrefixed(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	const prefix = Buffer.alloc(4);
	prefix.writeUInt32BE(bytes.length);
	return Buffer.concat([prefix, bytes]);
}

export function encodeConnectionHostSupplyAadV1(input: unknown): Buffer {
	const result = bindingSchema.safeParse(input);
	if (!result.success) invalidSupply();
	const binding = result.data;
	return Buffer.concat(
		[
			"agent-infra/connection-host-supply/v1",
			binding.deploymentIdentity,
			binding.hostRef,
			binding.sandboxId,
			binding.podUid,
			String(binding.sessionGeneration),
			String(binding.resourceFence),
			binding.supplyRef,
			binding.supplyRevision,
			binding.attemptId,
			binding.templateDigest,
		].map(lengthPrefixed),
	);
}

export function sealConnectionHostSupplyV1(
	plaintext: Uint8Array,
	key: Uint8Array,
	binding: unknown,
) {
	try {
		if (
			key.byteLength !== 32 ||
			plaintext.byteLength < 1 ||
			plaintext.byteLength > maxCiphertextBytes
		)
			invalidSupply();
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce, {
			authTagLength: 16,
		});
		cipher.setAAD(encodeConnectionHostSupplyAadV1(binding));
		const ciphertext = Buffer.concat([
			cipher.update(plaintext),
			cipher.final(),
		]);
		return {
			nonce: nonce.toString("base64url"),
			ciphertext: ciphertext.toString("base64url"),
			tag: cipher.getAuthTag().toString("base64url"),
		};
	} catch {
		invalidSupply();
	}
}

export function openConnectionHostSupplyV1(
	input: unknown,
	key: Uint8Array,
	binding: unknown,
): Buffer {
	let unverified: Buffer | undefined;
	try {
		if (key.byteLength !== 32) invalidSupply();
		const result = envelopeSchema.safeParse(input);
		if (!result.success) invalidSupply();
		const envelope = result.data;
		const nonce = decode(envelope.nonce, 12, 12);
		const tag = decode(envelope.tag, 16, 16);
		const ciphertext = decode(envelope.ciphertext, 1, maxCiphertextBytes);
		const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
			authTagLength: 16,
		});
		decipher.setAAD(encodeConnectionHostSupplyAadV1(binding));
		decipher.setAuthTag(tag);
		unverified = decipher.update(ciphertext);
		return Buffer.concat([unverified, decipher.final()]);
	} catch {
		invalidSupply();
	} finally {
		unverified?.fill(0);
	}
}

function decode(value: string, min: number, max: number): Buffer {
	const bytes = Buffer.from(value, "base64url");
	if (
		bytes.length < min ||
		bytes.length > max ||
		bytes.toString("base64url") !== value
	)
		invalidSupply();
	return bytes;
}
