import { createHash, createPublicKey, createVerify } from "node:crypto";
import {
	canonicalPublicJwk,
	installationKeyFingerprint,
} from "./installations.js";
import type {
	InstallationBinding,
	InstallationProofVerifier,
} from "./tokens.js";

type DpopJwk = {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
};

interface DpopHeader {
	typ: "dpop+jwt";
	alg: "ES256";
	jwk: DpopJwk;
}

interface DpopClaims {
	htu: string;
	htm: string;
	iat: number;
	jti: string;
	ath: string;
}

export interface DpopReplayStore {
	consume(jti: string, expiresAt: number): Promise<boolean> | boolean;
}

function decodeSegment(segment: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(segment))
		throw new Error("invalid DPoP encoding");
	return Buffer.from(segment, "base64url").toString("utf8");
}

function parseJson<T>(segment: string): T {
	const value: unknown = JSON.parse(decodeSegment(segment));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid DPoP JSON");
	return value as T;
}

function validJwk(value: unknown): value is DpopJwk {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const jwk = value as Record<string, unknown>;
	return (
		jwk.kty === "EC" &&
		jwk.crv === "P-256" &&
		typeof jwk.x === "string" &&
		/^[A-Za-z0-9_-]{43}$/.test(jwk.x) &&
		typeof jwk.y === "string" &&
		/^[A-Za-z0-9_-]{43}$/.test(jwk.y) &&
		!Object.hasOwn(jwk, "d")
	);
}

function expectedTarget(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.toString();
}

function sameJwk(left: DpopJwk, right: DpopJwk): boolean {
	return (
		canonicalPublicJwk(JSON.stringify(left)) ===
		canonicalPublicJwk(JSON.stringify(right))
	);
}

export class DpopProofVerifier implements InstallationProofVerifier {
	constructor(
		private readonly replay: DpopReplayStore,
		private readonly now: () => number = () => Date.now(),
		private readonly maxAgeMs = 5 * 60 * 1000,
	) {}

	private async verifyProof(input: {
		installation: InstallationBinding;
		proof: string;
		request: { method: string; url: string };
		accessToken?: string;
	}): Promise<boolean> {
		if (!input.installation.publicKeyJwk) return false;
		const segments = input.proof.split(".");
		if (segments.length !== 3) return false;
		const [headerSegment, payloadSegment, signatureSegment] = segments;
		if (!headerSegment || !payloadSegment || !signatureSegment) return false;
		try {
			const header = parseJson<DpopHeader>(headerSegment);
			const claims = parseJson<DpopClaims>(payloadSegment);
			if (
				header.typ !== "dpop+jwt" ||
				header.alg !== "ES256" ||
				!validJwk(header.jwk) ||
				typeof claims.htu !== "string" ||
				claims.htu !== expectedTarget(input.request.url) ||
				typeof claims.htm !== "string" ||
				claims.htm.toUpperCase() !== input.request.method.toUpperCase() ||
				!Number.isInteger(claims.iat) ||
				typeof claims.jti !== "string" ||
				!claims.jti ||
				claims.jti.length > 256 ||
				(input.accessToken !== undefined &&
					(typeof claims.ath !== "string" ||
						claims.ath !==
							createHash("sha256")
								.update(input.accessToken, "utf8")
								.digest("base64url")))
			)
				return false;
			const now = this.now();
			const issuedAt = claims.iat * 1000;
			if (issuedAt < now - this.maxAgeMs || issuedAt > now + this.maxAgeMs)
				return false;
			const registered = JSON.parse(input.installation.publicKeyJwk) as unknown;
			if (!validJwk(registered) || !sameJwk(header.jwk, registered))
				return false;
			if (
				installationKeyFingerprint(input.installation.publicKeyJwk) !==
				input.installation.keyFingerprint
			)
				return false;
			const publicKey = createPublicKey({ key: header.jwk, format: "jwk" });
			const verifier = createVerify("SHA256");
			verifier.update(`${headerSegment}.${payloadSegment}`);
			verifier.end();
			const signature = Buffer.from(signatureSegment, "base64url");
			if (
				signature.length !== 64 ||
				!verifier.verify(
					{ key: publicKey, dsaEncoding: "ieee-p1363" },
					signature,
				)
			)
				return false;
			return await this.replay.consume(claims.jti, issuedAt + this.maxAgeMs);
		} catch {
			return false;
		}
	}

	verify(input: {
		installation: InstallationBinding;
		accessToken: string;
		proof: string;
		request?: { method: string; url: string };
	}): Promise<boolean> {
		if (!input.request) return Promise.resolve(false);
		return this.verifyProof({
			installation: input.installation,
			proof: input.proof,
			request: input.request,
			accessToken: input.accessToken,
		});
	}

	verifyInstallation(input: {
		installation: InstallationBinding;
		proof: string;
		request: { method: string; url: string };
	}): Promise<boolean> {
		return this.verifyProof(input);
	}
}
