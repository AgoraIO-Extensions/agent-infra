import { describe, expect, it, vi } from "vitest";
import {
	ConnectionInstallationService,
	installationKeyFingerprint,
} from "./installations.js";

describe("ConsumerInstance installation", () => {
	it("derives the installation key fingerprint server-side", async () => {
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
			publicKey: "public-key",
		});
		expect(result.keyFingerprint).toBe(
			installationKeyFingerprint("public-key"),
		);
		expect(registrar.register).toHaveBeenCalledWith({
			principalId: "principal-a",
			consumerId: "consumer-a",
			keyFingerprint: result.keyFingerprint,
		});
	});
});
