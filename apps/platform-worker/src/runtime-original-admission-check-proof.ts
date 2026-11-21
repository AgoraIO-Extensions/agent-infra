import { createHash, createPublicKey, type KeyObject, sign } from "node:crypto";

import {
	RuntimeOriginalAdmissionCheckBindingV1Schema,
	RuntimeOriginalAdmissionCheckMaximumLifetimeMsV1,
	RuntimeOriginalAdmissionCheckProofClaimsV1Schema,
	type RuntimeOriginalAdmissionCheckRequestV1,
	RuntimeOriginalAdmissionCheckRequestV1Schema,
	type RuntimeOriginalAdmissionScopeV1,
	runtimeOriginalAdmissionCheckBindingPayloadV1,
	runtimeOriginalAdmissionCheckProofPayloadV1,
} from "@agent-infra/contracts/runtime";

const asciiToken = /^[\x21-\x7e]{1,8192}$/;

function encode(value: string) {
	return Buffer.from(value, "utf8").toString("base64url");
}

function proofUnavailable(): never {
	throw new Error("RUNTIME_ORIGINAL_ADMISSION_CHECK_PROOF_UNAVAILABLE");
}

/**
 * #4358 I3 (Spec §9.3.2): the Worker signs one short proof per admission
 * check. It reuses the Worker signing key under its own JWS `typ`, purpose
 * and audience; the proof carries no Grant, Key, Token or body.
 */
export function createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1(options: {
	readonly issuer: string;
	readonly workerId: string;
	readonly keyVersion: string;
	readonly privateKey: KeyObject;
	readonly now?: () => number;
}) {
	if (
		!asciiToken.test(options.issuer) ||
		!asciiToken.test(options.workerId) ||
		!asciiToken.test(options.keyVersion) ||
		options.privateKey.type !== "private" ||
		options.privateKey.asymmetricKeyType !== "ed25519"
	)
		throw new TypeError("Runtime original admission proof options are invalid");
	createPublicKey(options.privateKey);
	const now = options.now ?? Date.now;
	return {
		/**
		 * `scope` and `platform` come from committed Platform records resolved
		 * for this check; `deadline` is the caller's own upper bound, if any.
		 */
		issue(input: {
			readonly checkId: string;
			readonly challenge: string;
			readonly scope: RuntimeOriginalAdmissionScopeV1;
			readonly platform: { sessionGeneration: number; resourceFence: number };
			readonly deadline?: number;
		}): RuntimeOriginalAdmissionCheckRequestV1 {
			const issuedAt = now();
			if (!Number.isSafeInteger(issuedAt)) proofUnavailable();
			const expiresAt = Math.min(
				issuedAt + RuntimeOriginalAdmissionCheckMaximumLifetimeMsV1,
				input.deadline ?? Number.MAX_SAFE_INTEGER,
			);
			if (expiresAt <= issuedAt) proofUnavailable();
			const binding = RuntimeOriginalAdmissionCheckBindingV1Schema.parse({
				schemaVersion: 1,
				checkId: input.checkId,
				challenge: input.challenge,
				issuedAt,
				expiresAt,
				scope: input.scope,
				platform: input.platform,
			});
			const claims = RuntimeOriginalAdmissionCheckProofClaimsV1Schema.parse({
				...binding,
				purpose: "original_admission_check",
				audience: "runtime_host.original_admission_check",
				issuer: options.issuer,
				workerId: options.workerId,
				keyVersion: options.keyVersion,
				requestDigest: createHash("sha256")
					.update(runtimeOriginalAdmissionCheckBindingPayloadV1(binding))
					.digest("hex"),
			});
			const header = encode(
				JSON.stringify({
					alg: "EdDSA",
					kid: options.keyVersion,
					typ: "runtime-original-admission-check+jws",
				}),
			);
			const payload = encode(
				runtimeOriginalAdmissionCheckProofPayloadV1(claims),
			);
			const signingInput = `${header}.${payload}`;
			const token = `${signingInput}.${sign(
				null,
				Buffer.from(signingInput, "ascii"),
				options.privateKey,
			).toString("base64url")}`;
			return RuntimeOriginalAdmissionCheckRequestV1Schema.parse({
				...binding,
				proof: {
					schemaVersion: 1,
					format: "original-admission-check-jws",
					token,
				},
			});
		},
	};
}
