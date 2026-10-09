import { type KeyObject, randomUUID, sign, verify } from "node:crypto";

import {
	type PlatformEntryContextClaimsV1,
	PlatformEntryContextClaimsV1Schema,
	PlatformEntryContextMaximumLifetimeMsV1,
	type PlatformEntryContextV1,
	PlatformEntryContextV1Schema,
} from "@agent-infra/contracts/runtime";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): unknown {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value)
		throw new Error("invalid encoding");
	return JSON.parse(utf8.decode(bytes));
}

function signedToken(
	claims: PlatformEntryContextClaimsV1,
	keyVersion: string,
	privateKey: KeyObject,
): PlatformEntryContextV1 {
	const header = encode({
		alg: "EdDSA",
		kid: keyVersion,
		typ: "platform-entry+jws",
	});
	const payload = encode(claims);
	const signingInput = `${header}.${payload}`;
	const signature = sign(
		null,
		Buffer.from(signingInput, "ascii"),
		privateKey,
	).toString("base64url");
	return PlatformEntryContextV1Schema.parse({
		schemaVersion: 1,
		format: "platform-entry-jws",
		token: `${signingInput}.${signature}`,
	});
}

export function createPlatformEntryContextSignerV1(options: {
	readonly issuer: string;
	readonly keyVersion: string;
	readonly privateKey: KeyObject;
	readonly now?: () => number;
	readonly id?: () => string;
	readonly lifetimeMs?: number;
}) {
	if (
		!options.issuer ||
		!options.keyVersion ||
		options.privateKey.type !== "private" ||
		options.privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new TypeError("Platform entry signing options are invalid");
	const lifetime = options.lifetimeMs ?? 30_000;
	if (
		!Number.isSafeInteger(lifetime) ||
		lifetime < 1 ||
		lifetime > PlatformEntryContextMaximumLifetimeMsV1
	)
		throw new TypeError("Platform entry lifetime is invalid");
	return (input: {
		readonly userId: string;
		readonly organizationIds: readonly string[];
		readonly roles: readonly ("employee" | "system_admin")[];
		readonly authorizationRevision: string;
		readonly agentId: string;
	}): PlatformEntryContextV1 => {
		const issuedAt = (options.now ?? Date.now)();
		const claims = PlatformEntryContextClaimsV1Schema.parse({
			schemaVersion: 1,
			issuer: options.issuer,
			audience: "custom_agent",
			issuedAt,
			expiresAt: issuedAt + lifetime,
			contextId: (options.id ?? randomUUID)(),
			keyVersion: options.keyVersion,
			userId: input.userId,
			organizationIds: [...input.organizationIds],
			roles: [...input.roles],
			authorizationRevision: input.authorizationRevision,
			agentId: input.agentId,
		});
		return signedToken(claims, options.keyVersion, options.privateKey);
	};
}

export function createPlatformEntryContextVerifierV1(options: {
	readonly publicKeys: ReadonlyMap<string, KeyObject>;
	readonly expectedIssuer: string;
	readonly expectedAgentId: string;
	readonly now?: () => number;
}) {
	const publicKeys = new Map(options.publicKeys);
	return (value: unknown): PlatformEntryContextClaimsV1 => {
		try {
			const envelope = PlatformEntryContextV1Schema.parse(value);
			const parts = envelope.token.split(".");
			if (parts.length !== 3) throw new Error("invalid token");
			const [headerPart, payloadPart, signaturePart] = parts;
			if (!headerPart || !payloadPart || !signaturePart)
				throw new Error("invalid token");
			const header = decode(headerPart);
			if (
				!header ||
				typeof header !== "object" ||
				Array.isArray(header) ||
				Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
				(header as { alg?: unknown }).alg !== "EdDSA" ||
				(header as { typ?: unknown }).typ !== "platform-entry+jws" ||
				typeof (header as { kid?: unknown }).kid !== "string"
			)
				throw new Error("invalid header");
			const key = publicKeys.get((header as { kid: string }).kid);
			if (
				!key ||
				key.type !== "public" ||
				key.asymmetricKeyType !== "ed25519" ||
				!verify(
					null,
					Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
					key,
					Buffer.from(signaturePart, "base64url"),
				)
			)
				throw new Error("invalid signature");
			const claims = PlatformEntryContextClaimsV1Schema.parse(
				decode(payloadPart),
			);
			const now = (options.now ?? Date.now)();
			if (
				!Number.isSafeInteger(now) ||
				claims.issuer !== options.expectedIssuer ||
				claims.audience !== "custom_agent" ||
				claims.keyVersion !== (header as { kid: string }).kid ||
				claims.agentId !== options.expectedAgentId ||
				claims.issuedAt > now ||
				now >= claims.expiresAt ||
				claims.expiresAt <= claims.issuedAt ||
				claims.expiresAt - claims.issuedAt >
					PlatformEntryContextMaximumLifetimeMsV1
			)
				throw new Error("invalid claims");
			return claims;
		} catch {
			throw new Error("PLATFORM_ENTRY_CONTEXT_INVALID");
		}
	};
}
