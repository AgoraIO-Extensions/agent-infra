import { createHash, createPublicKey, verify } from "node:crypto";

export interface InstallationPublicKey {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
}

export interface VerifiedDpopProof {
	publicKey: InstallationPublicKey;
	thumbprint: string;
	jti: string;
	iat: number;
}

export class InvalidDpopProof extends Error {
	constructor() {
		super("Invalid installation proof");
		this.name = "InvalidDpopProof";
	}
}

const base64url = /^[A-Za-z0-9_-]+$/;

function decodePart(part: string): unknown {
	if (!base64url.test(part) || part.length > 4096) throw new InvalidDpopProof();
	const bytes = Buffer.from(part, "base64url");
	if (bytes.toString("base64url") !== part) throw new InvalidDpopProof();
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new InvalidDpopProof();
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InvalidDpopProof();
	return value as Record<string, unknown>;
}

export function installationKeyThumbprint(key: InstallationPublicKey): string {
	return createHash("sha256")
		.update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }))
		.digest("base64url");
}

export function verifyDpopProof(input: {
	proof: string | undefined;
	method: string;
	url: string;
	accessToken?: string;
	expectedThumbprint?: string;
	now?: number;
}): VerifiedDpopProof {
	if (!input.proof || input.proof.length > 8192) throw new InvalidDpopProof();
	const parts = input.proof?.split(".");
	if (parts?.length !== 3 || parts.some((part) => part.length === 0))
		throw new InvalidDpopProof();
	const header = object(decodePart(parts[0] ?? ""));
	const claims = object(decodePart(parts[1] ?? ""));
	const jwk = object(header.jwk);
	if (
		header.typ !== "dpop+jwt" ||
		header.alg !== "ES256" ||
		Object.keys(jwk).sort().join(",") !== "crv,kty,x,y" ||
		jwk.kty !== "EC" ||
		jwk.crv !== "P-256" ||
		typeof jwk.x !== "string" ||
		typeof jwk.y !== "string" ||
		!base64url.test(jwk.x) ||
		!base64url.test(jwk.y) ||
		Buffer.from(jwk.x, "base64url").length !== 32 ||
		Buffer.from(jwk.y, "base64url").length !== 32 ||
		Buffer.from(jwk.x, "base64url").toString("base64url") !== jwk.x ||
		Buffer.from(jwk.y, "base64url").toString("base64url") !== jwk.y
	)
		throw new InvalidDpopProof();
	const publicKey: InstallationPublicKey = {
		kty: "EC",
		crv: "P-256",
		x: jwk.x,
		y: jwk.y,
	};
	const thumbprint = installationKeyThumbprint(publicKey);
	const now = input.now ?? Date.now();
	if (
		(input.expectedThumbprint !== undefined &&
			input.expectedThumbprint !== thumbprint) ||
		claims.htm !== input.method.toUpperCase() ||
		claims.htu !== input.url ||
		typeof claims.jti !== "string" ||
		!/^[-A-Za-z0-9._~]{16,128}$/.test(claims.jti) ||
		typeof claims.iat !== "number" ||
		!Number.isInteger(claims.iat) ||
		Math.abs(now - claims.iat * 1000) > 300_000 ||
		(input.accessToken
			? claims.ath !==
				createHash("sha256").update(input.accessToken).digest("base64url")
			: claims.ath !== undefined)
	)
		throw new InvalidDpopProof();
	let valid = false;
	try {
		const signature = Buffer.from(parts[2] ?? "", "base64url");
		valid =
			signature.length === 64 &&
			signature.toString("base64url") === parts[2] &&
			verify(
				"sha256",
				Buffer.from(`${parts[0]}.${parts[1]}`),
				{
					key: createPublicKey({ key: { ...publicKey }, format: "jwk" }),
					dsaEncoding: "ieee-p1363",
				},
				signature,
			);
	} catch {
		throw new InvalidDpopProof();
	}
	if (!valid) throw new InvalidDpopProof();
	return { publicKey, thumbprint, jti: claims.jti, iat: claims.iat };
}
