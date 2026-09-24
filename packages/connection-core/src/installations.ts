import { createHash, createPublicKey, randomBytes } from "node:crypto";
import type { InstallationBinding } from "./tokens.js";

export interface InstallationRegistrar {
	register(input: {
		principalId: string;
		consumerId: string;
		keyFingerprint: string;
		publicKeyJwk: string;
	}): Promise<InstallationBinding>;
}

export function canonicalPublicJwk(publicKey: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(publicKey);
	} catch {
		throw new Error("installation public key is invalid");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("installation public key is invalid");
	const key = parsed as Record<string, unknown>;
	if (
		key.kty !== "EC" ||
		key.crv !== "P-256" ||
		typeof key.x !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
		typeof key.y !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(key.y) ||
		Object.hasOwn(key, "d")
	)
		throw new Error("installation public key is invalid");
	const canonical = JSON.stringify({
		crv: key.crv,
		kty: key.kty,
		x: key.x,
		y: key.y,
	});
	createPublicKey({ key: JSON.parse(canonical), format: "jwk" });
	return canonical;
}

export function installationKeyFingerprint(publicKey: string): string {
	if (!publicKey.trim() || publicKey.length > 16_384)
		throw new Error("installation public key is invalid");
	return createHash("sha256")
		.update(canonicalPublicJwk(publicKey), "utf8")
		.digest("hex");
}

export function newInstallationId(): string {
	return `instance_${randomBytes(16).toString("hex")}`;
}

export class ConnectionInstallationService {
	constructor(private readonly registrar: InstallationRegistrar) {}

	async register(input: {
		principalId: string;
		consumerId: string;
		publicKey: string;
	}): Promise<InstallationBinding> {
		if (!input.principalId.trim() || !input.consumerId.trim())
			throw new Error("installation binding is incomplete");
		return this.registrar.register({
			principalId: input.principalId,
			consumerId: input.consumerId,
			keyFingerprint: installationKeyFingerprint(input.publicKey),
			publicKeyJwk: canonicalPublicJwk(input.publicKey),
		});
	}
}
