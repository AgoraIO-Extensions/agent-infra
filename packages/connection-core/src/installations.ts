import { createHash, randomBytes } from "node:crypto";
import type { InstallationBinding } from "./tokens.js";

export interface InstallationRegistrar {
	register(input: {
		principalId: string;
		consumerId: string;
		keyFingerprint: string;
	}): Promise<InstallationBinding>;
}

export function installationKeyFingerprint(publicKey: string): string {
	if (!publicKey.trim() || publicKey.length > 16_384)
		throw new Error("installation public key is invalid");
	return createHash("sha256").update(publicKey, "utf8").digest("hex");
}

export function newInstallationId(): string {
	return `instance_${randomBytes(16).toString("hex")}`;
}

export class ConnectionInstallationService {
	constructor(private readonly registrar: InstallationRegistrar) {}

	register(input: {
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
		});
	}
}
