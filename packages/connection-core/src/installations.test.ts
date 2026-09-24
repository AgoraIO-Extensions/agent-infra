import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	ConnectionInstallationService,
	canonicalPublicJwk,
	installationKeyFingerprint,
} from "./installations.js";

describe("ConsumerInstance installation", () => {
	it("derives the installation key fingerprint server-side", async () => {
		const publicKey = JSON.stringify(
			generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
				format: "jwk",
			}),
		);
		const registrar = {
			register: vi.fn(async (input) => ({
				id: "instance-1",
				...input,
				actorId: null,
				status: "active" as const,
				recoveryGeneration: 1,
				keyFingerprint: input.keyFingerprint,
			})),
		};
		const service = new ConnectionInstallationService(registrar);
		const result = await service.register({
			principalId: "principal-a",
			consumerId: "consumer-a",
			publicKey,
		});
		expect(result.keyFingerprint).toBe(installationKeyFingerprint(publicKey));
		expect(registrar.register).toHaveBeenCalledWith({
			principalId: "principal-a",
			consumerId: "consumer-a",
			keyFingerprint: result.keyFingerprint,
			publicKeyJwk: canonicalPublicJwk(publicKey),
		});
		await expect(
			service.register({
				principalId: "principal-a",
				consumerId: "consumer-a",
				publicKey: "public-key",
			}),
		).rejects.toThrow(/public key/);
	});
});
