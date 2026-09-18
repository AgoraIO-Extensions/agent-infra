import {
	createHash,
	type KeyObject,
	sign as signBytes,
	verify as verifyBytes,
} from "node:crypto";

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type SignedEnvelopeV1 = {
	keyId: string;
	payload: string;
	signature: string;
	version: 1;
};

export type DispatchAssertionClaimsV1 = {
	actionVersionId: string;
	audience: "connection-provider-egress";
	callId: string;
	certificateThumbprint: string;
	connectionId: string;
	credentialHash: string;
	credentialVersionId: string;
	dispatchId: string;
	effect: "READ" | "WRITE";
	effectId: string | null;
	environment: string;
	expiresAt: number;
	hopId: string;
	issuedAt: number;
	issuer: string;
	jti: string;
	leaseProofHash: string;
	method: "GET";
	notBefore: number;
	origin: "https://api.github.com";
	pathTemplate: "/user";
	providerReleaseId: string;
	recoveryGeneration: string;
	requestHash: string;
	version: 1;
};

export type ProviderRequestPlanV1 = {
	actionVersionId: string;
	method: "GET";
	origin: "https://api.github.com";
	path: "/user";
	version: 1;
};

export function canonicalJsonV1(value: JsonValue): string {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Canonical JSON rejects non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalJsonV1(value[key] as JsonValue)}`,
		)
		.join(",")}}`;
}

export function sha256(value: string | Uint8Array) {
	return createHash("sha256").update(value).digest("base64url");
}

export function signEnvelopeV1(
	payload: JsonValue,
	keyId: string,
	privateKey: KeyObject,
): SignedEnvelopeV1 {
	const bytes = Buffer.from(canonicalJsonV1(payload));
	return {
		keyId,
		payload: bytes.toString("base64url"),
		signature: signBytes(null, bytes, privateKey).toString("base64url"),
		version: 1,
	};
}

export function verifyEnvelopeV1(
	envelope: SignedEnvelopeV1,
	publicKey: KeyObject,
): JsonValue {
	if (envelope.version !== 1)
		throw new Error("Unsupported signed envelope version");
	const bytes = Buffer.from(envelope.payload, "base64url");
	if (
		!verifyBytes(
			null,
			bytes,
			publicKey,
			Buffer.from(envelope.signature, "base64url"),
		)
	) {
		throw new Error("Signed envelope verification failed");
	}
	return JSON.parse(bytes.toString("utf8")) as JsonValue;
}
