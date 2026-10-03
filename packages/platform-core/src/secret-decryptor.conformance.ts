import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import type { SecretActivationDecryptorPortV1 } from "./secret-activation.js";

interface DecryptScenario {
	readonly port: SecretActivationDecryptorPortV1;
	readonly encryptedRecord: unknown;
}

export interface SecretActivationDecryptorHarnessV1 {
	readonly valid: DecryptScenario & { readonly expectedDigest: string };
	readonly unavailableKey: DecryptScenario;
	readonly malformed: DecryptScenario;
	readonly tampered: DecryptScenario;
}

export function secretActivationDecryptorConformanceV1(
	name: string,
	create: () => SecretActivationDecryptorHarnessV1,
): void {
	describe(`${name} Secret activation decryptor conformance`, () => {
		it("returns only authenticated plaintext from the matching Worker key", async () => {
			const { valid } = create();
			const decision = await valid.port.decrypt({
				encryptedRecord: valid.encryptedRecord,
				traceId: "trace_conformance",
			});
			expect(decision.outcome).toBe("decrypted");
			if (decision.outcome !== "decrypted") throw new Error("Expected decrypt");
			expect(
				createHash("sha256").update(decision.plaintext).digest("hex"),
			).toBe(valid.expectedDigest);
			decision.plaintext.fill(0);
		});

		it.each([
			["unavailable key", "unavailableKey", "SECRET_KEY_UNAVAILABLE"],
			["malformed metadata", "malformed", "SECRET_METADATA_INVALID"],
			["authentication tamper", "tampered", "SECRET_AUTHENTICATION_FAILED"],
		] as const)("fails closed for %s", async (_name, key, code) => {
			const scenario = create()[key];
			const decision = await scenario.port.decrypt({
				encryptedRecord: scenario.encryptedRecord,
				traceId: "trace_conformance",
			});
			expect(decision).toEqual({ outcome: "failed", code });
			expect(JSON.stringify(decision)).not.toContain("boundary-sensitive");
		});
	});
}
