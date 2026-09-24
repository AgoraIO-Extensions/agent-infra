import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DpopProofVerifier } from "./dpop.js";

type TestJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

import {
	canonicalPublicJwk,
	installationKeyFingerprint,
} from "./installations.js";

function proof(
	privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
	jwk: TestJwk,
	claims: Record<string, unknown>,
) {
	const encode = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk });
	const body = encode(claims);
	const signer = createSign("SHA256");
	signer.update(`${header}.${body}`);
	signer.end();
	const signature = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
	return `${header}.${body}.${signature.toString("base64url")}`;
}

describe("DPoP installation proof", () => {
	it("verifies ES256, token binding, target and one-time jti", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("ec", {
			namedCurve: "prime256v1",
		});
		const jwk = publicKey.export({ format: "jwk" }) as TestJwk;
		const installation = {
			id: "instance-a",
			consumerId: "consumer-a",
			principalId: "principal-a",
			actorId: null,
			status: "active" as const,
			recoveryGeneration: 1,
			keyFingerprint: installationKeyFingerprint(JSON.stringify(jwk)),
			publicKeyJwk: canonicalPublicJwk(JSON.stringify(jwk)),
		};
		const now = Math.floor(Date.now() / 1000) * 1000;
		const accessToken = "access-token";
		const valid = proof(privateKey, jwk, {
			htu: "https://connection.example/v1/mcp",
			htm: "POST",
			iat: now / 1000,
			jti: "jti-1",
			ath: createHash("sha256").update(accessToken).digest("base64url"),
		});
		const seen = new Set<string>();
		const verifier = new DpopProofVerifier(
			{
				consume: async (jti) => {
					if (seen.has(jti)) return false;
					seen.add(jti);
					return true;
				},
			},
			() => now,
		);
		const input = {
			installation,
			token: { tokenHash: "unused" },
			accessToken,
			proof: valid,
			request: { method: "POST", url: "https://connection.example/v1/mcp" },
		};
		expect(await verifier.verify(input)).toBe(true);
		expect(await verifier.verify(input)).toBe(false);
		expect(
			await verifier.verify({
				...input,
				request: { ...input.request, method: "GET" },
			}),
		).toBe(false);
	});
});
