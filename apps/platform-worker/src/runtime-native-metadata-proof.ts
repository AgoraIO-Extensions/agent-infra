import { createHash, createPublicKey, type KeyObject, sign } from "node:crypto";

import {
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataBindingResponseV1Schema,
	RuntimeNativeMetadataProofClaimsV1Schema,
	type RuntimeNativeMetadataProofV1,
	RuntimeNativeMetadataProofV1Schema,
	runtimeNativeMetadataProofSigningPayloadV1,
	runtimeNativeMetadataRequestSigningPayloadV1,
	validateRuntimeNativeMetadataProofClaimsV1,
} from "@agent-infra/contracts/runtime";

const asciiToken = /^[\x21-\x7e]{1,8192}$/;

export interface WorkerRuntimeNativeMetadataProofIssuerOptionsV1 {
	readonly issuer: string;
	readonly workerId: string;
	readonly keyVersion: string;
	readonly privateKey: KeyObject;
	readonly now?: () => number;
}

function encode(value: string) {
	return Buffer.from(value, "utf8").toString("base64url");
}

function requestDigest(request: RuntimeNativeMetadataBindingResponseV1) {
	return createHash("sha256")
		.update(runtimeNativeMetadataRequestSigningPayloadV1(request))
		.digest("hex");
}

function proofUnavailable(): never {
	throw new Error("RUNTIME_NATIVE_METADATA_PROOF_UNAVAILABLE");
}

/** Issue the only proof accepted by the RuntimeHost native metadata reader. */
export function createWorkerRuntimeNativeMetadataProofIssuerV1(
	options: WorkerRuntimeNativeMetadataProofIssuerOptionsV1,
) {
	if (
		!asciiToken.test(options.issuer) ||
		!asciiToken.test(options.workerId) ||
		!asciiToken.test(options.keyVersion) ||
		options.privateKey.type !== "private" ||
		options.privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new TypeError("Runtime native metadata proof options are invalid");
	createPublicKey(options.privateKey);
	const now = options.now ?? Date.now;
	return {
		async issue(input: {
			readonly request: RuntimeNativeMetadataBindingResponseV1;
			readonly apiRequestSourceRef?: string;
			readonly signal: AbortSignal;
		}): Promise<RuntimeNativeMetadataProofV1> {
			if (input.signal.aborted) proofUnavailable();
			const request = RuntimeNativeMetadataBindingResponseV1Schema.parse(
				input.request,
			);
			const issuedAt = now();
			if (!Number.isSafeInteger(issuedAt) || issuedAt < request.readStartedAt)
				proofUnavailable();
			const digest = requestDigest(request);
			const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse({
				...request,
				...(input.apiRequestSourceRef
					? { apiRequestSourceRef: input.apiRequestSourceRef }
					: {}),
				purpose: "native_metadata_read",
				issuedAt,
				issuer: options.issuer,
				audience: "runtime_host.native_metadata_read",
				workerId: options.workerId,
				keyVersion: options.keyVersion,
				requestDigest: digest,
			});
			validateRuntimeNativeMetadataProofClaimsV1(claims, {
				request,
				expectedIssuer: options.issuer,
				expectedWorkerId: options.workerId,
				expectedRequestDigest: digest,
				expectedApiRequestSourceRef: input.apiRequestSourceRef,
				now: issuedAt,
			});
			const header = encode(
				JSON.stringify({
					alg: "EdDSA",
					kid: options.keyVersion,
					typ: "native-metadata+jws",
				}),
			);
			const payload = encode(
				runtimeNativeMetadataProofSigningPayloadV1(claims),
			);
			const signingInput = `${header}.${payload}`;
			const token = `${signingInput}.${sign(
				null,
				Buffer.from(signingInput, "ascii"),
				options.privateKey,
			).toString("base64url")}`;
			if (input.signal.aborted) proofUnavailable();
			return RuntimeNativeMetadataProofV1Schema.parse({
				schemaVersion: 1,
				format: "native-metadata-jws",
				token,
			});
		},
	};
}
