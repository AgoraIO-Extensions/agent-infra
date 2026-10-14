import {
	createHash,
	type createPublicKey,
	timingSafeEqual,
	verify,
} from "node:crypto";
import {
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataProofClaimsV1Schema,
	RuntimeNativeMetadataReadRequestV1Schema,
	runtimeNativeMetadataProofSigningPayloadV1,
	runtimeNativeMetadataRequestSigningPayloadV1,
	validateRuntimeNativeMetadataProofClaimsV1,
} from "@agent-infra/contracts/runtime";

const ascii = /^[\x21-\x7e]{1,8192}$/;

function decodePart(value: string) {
	return Buffer.from(value, "base64url").toString("utf8");
}

function requestDigest(request: RuntimeNativeMetadataBindingResponseV1) {
	return createHash("sha256")
		.update(runtimeNativeMetadataRequestSigningPayloadV1(request))
		.digest("hex");
}

/** Verify the Worker-issued native metadata JWS at the RuntimeHost boundary. */
export function createRuntimeNativeMetadataProofVerifierV1(options: {
	readonly publicKey: ReturnType<typeof createPublicKey>;
	readonly issuer: string;
	readonly workerId: string;
	readonly keyVersion: string;
	readonly now?: () => number;
}) {
	if (
		options.publicKey.type !== "public" ||
		options.publicKey.asymmetricKeyType !== "ed25519" ||
		!ascii.test(options.issuer) ||
		!ascii.test(options.workerId) ||
		!ascii.test(options.keyVersion)
	)
		throw new TypeError("Runtime native metadata proof verifier is invalid");
	const now = options.now ?? Date.now;
	return {
		verify(request: unknown) {
			const parsed = RuntimeNativeMetadataReadRequestV1Schema.parse(request);
			const { token } = parsed.proof;
			const parts = token.split(".");
			if (parts.length !== 3)
				throw new Error("Native metadata proof is invalid");
			const [encodedHeader, encodedPayload, encodedSignature] = parts;
			if (!encodedHeader || !encodedPayload || !encodedSignature)
				throw new Error("Native metadata proof is invalid");
			const header = JSON.parse(decodePart(encodedHeader)) as Record<
				string,
				unknown
			>;
			if (
				header.alg !== "EdDSA" ||
				header.typ !== "native-metadata+jws" ||
				header.kid !== options.keyVersion
			)
				throw new Error("Native metadata proof is invalid");
			const signed = `${encodedHeader}.${encodedPayload}`;
			const signature = Buffer.from(encodedSignature, "base64url");
			if (
				signature.length !== 64 ||
				!verify(
					null,
					Buffer.from(signed, "ascii"),
					options.publicKey,
					signature,
				)
			)
				throw new Error("Native metadata proof is invalid");
			const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse(
				JSON.parse(decodePart(encodedPayload)),
			);
			const {
				proof: _proof,
				apiRequestSourceRef: _source,
				...binding
			} = parsed;
			const nowValue = now();
			if (!Number.isSafeInteger(nowValue))
				throw new Error("Native metadata proof clock is invalid");
			validateRuntimeNativeMetadataProofClaimsV1(claims, {
				request: binding,
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				expectedRequestDigest: requestDigest(binding),
				expectedApiRequestSourceRef: parsed.apiRequestSourceRef,
				now: nowValue,
			});
			// Re-encode the claims to prevent accepting alternate JSON field order or
			// duplicate-key representations that are not covered by the signed JCS-like
			// payload used by the Worker issuer.
			const canonical = Buffer.from(
				runtimeNativeMetadataProofSigningPayloadV1(claims),
				"utf8",
			).toString("base64url");
			const supplied = Buffer.from(encodedPayload);
			const expected = Buffer.from(canonical);
			if (
				supplied.length !== expected.length ||
				!timingSafeEqual(supplied, expected)
			)
				throw new Error("Native metadata proof is invalid");
		},
	};
}
