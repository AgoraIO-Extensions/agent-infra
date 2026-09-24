import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect, it } from "vitest";
import {
	InvalidDpopProof,
	installationKeyThumbprint,
	verifyDpopProof,
} from "./dpop.js";

const url = "https://connection.example.test/oauth/token";
const { privateKey, publicKey } = generateKeyPairSync("ec", {
	namedCurve: "P-256",
});
const jwk = publicKey.export({ format: "jwk" });

function proof(overrides: Record<string, unknown> = {}) {
	const header = Buffer.from(
		JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk }),
	).toString("base64url");
	const claims = Buffer.from(
		JSON.stringify({
			htm: "POST",
			htu: url,
			iat: Math.floor(Date.now() / 1000),
			jti: randomUUID(),
			...overrides,
		}),
	).toString("base64url");
	const input = `${header}.${claims}`;
	const signature = sign("sha256", Buffer.from(input), {
		key: privateKey,
		dsaEncoding: "ieee-p1363",
	}).toString("base64url");
	return `${input}.${signature}`;
}

it("verifies an ES256 installation proof and its bound public key", () => {
	const token = "opaque-access-token";
	const valid = proof({
		ath: createHash("sha256").update(token).digest("base64url"),
	});
	const verified = verifyDpopProof({
		proof: valid,
		method: "POST",
		url,
		accessToken: token,
	});
	expect(verified.thumbprint).toBe(
		installationKeyThumbprint(verified.publicKey),
	);
	expect(verified.publicKey).toEqual(jwk);
});

it("rejects a wrong method, URL, token, key, age and signature", () => {
	const valid = proof();
	const input = { proof: valid, method: "POST", url };
	const [header, claims, signature] = valid.split(".");
	const alteredSignature = `${signature?.[0] === "A" ? "B" : "A"}${signature?.slice(1)}`;
	for (const change of [
		{ method: "GET" },
		{ url: "https://connection.example.test/oauth/other" },
		{ accessToken: "stolen-token" },
		{ expectedThumbprint: "other" },
		{ now: Date.now() + 300_001 },
		{ proof: `${header}.${claims}.${alteredSignature}` },
	]) {
		expect(() => verifyDpopProof({ ...input, ...change })).toThrow(
			InvalidDpopProof,
		);
	}
});

it("rejects private key material and noncanonical proof segments", () => {
	const malicious = publicKey.export({ format: "jwk" });
	const header = Buffer.from(
		JSON.stringify({
			typ: "dpop+jwt",
			alg: "ES256",
			jwk: { ...malicious, d: "x" },
		}),
	).toString("base64url");
	const parts = proof().split(".");
	expect(() =>
		verifyDpopProof({
			proof: `${header}.${parts[1]}.${parts[2]}`,
			method: "POST",
			url,
		}),
	).toThrow(InvalidDpopProof);
	expect(() =>
		verifyDpopProof({
			proof: `${parts[0]}=.${parts[1]}.${parts[2]}`,
			method: "POST",
			url,
		}),
	).toThrow(InvalidDpopProof);
});
