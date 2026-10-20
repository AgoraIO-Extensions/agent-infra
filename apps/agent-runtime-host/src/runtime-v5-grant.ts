import { type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import { RuntimeHostError } from "@agent-infra/agent-runtime";
import {
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV5Schema,
	validateRuntimeBusinessBindingV5,
	validateRuntimeRestoreExecutionKeyBindingV5,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5,
} from "@agent-infra/contracts/runtime";

export interface RuntimeV5GrantValidationOptions {
	readonly expectedIssuer: string;
	readonly expectedWorkerId: string;
	readonly now?: () => number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function authorizationDenied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Runtime authorization is unavailable or does not authorize this operation",
		403,
		false,
		undefined,
		"v5-grant-invalid",
	);
}

function decode(segment: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) authorizationDenied();
	const decoded = Buffer.from(segment, "base64url");
	if (decoded.toString("base64url") !== segment) authorizationDenied();
	return decoded;
}

/**
 * Verify the exact EdDSA runtime-execution JWS envelope and return its claims.
 *
 * V5 reuses the V4 token over a versioned envelope, so the shared V4 verifier
 * (which parses the V4 claim schema) cannot be used for the V5 recovery claims.
 * Signature handling stays identical to the V4 transport: Ed25519 only, the
 * fixed header key set, and canonical base64url segments.
 */
function verifyGrantToken(
	publicKeys: ReadonlyMap<string, KeyObject>,
	token: string,
): unknown {
	const parts = token.split(".");
	if (parts.length !== 3) authorizationDenied();
	const [headerPart, claimsPart, signaturePart] = parts;
	if (!headerPart || !claimsPart || !signaturePart) authorizationDenied();
	const header = JSON.parse(utf8.decode(decode(headerPart))) as {
		alg?: unknown;
		kid?: unknown;
		typ?: unknown;
	};
	if (
		!header ||
		Object.keys(header).sort().join(",") !== "alg,kid,typ" ||
		header.alg !== "EdDSA" ||
		header.typ !== "runtime-execution+jws" ||
		typeof header.kid !== "string"
	)
		authorizationDenied();
	const key = publicKeys.get(header.kid);
	if (
		key?.asymmetricKeyType !== "ed25519" ||
		!verify(
			null,
			Buffer.from(`${headerPart}.${claimsPart}`, "ascii"),
			key,
			decode(signaturePart),
		)
	)
		authorizationDenied();
	return JSON.parse(utf8.decode(decode(claimsPart))) as unknown;
}

/**
 * Deployment-owned V5 Grant verification. The business Grant is the exact V4
 * claims set; the recovery Grant binds an existing accepted V5 execution.
 * Either way the V5 request/Digest binding is validated here before the Host
 * repeats it.
 */
export function createRuntimeV5GrantValidators(
	publicKeys: ReadonlyMap<string, KeyObject>,
	options: RuntimeV5GrantValidationOptions,
) {
	const now = options.now ?? Date.now;
	const context = () => ({
		expectedIssuer: options.expectedIssuer,
		expectedWorkerId: options.expectedWorkerId,
		now: now(),
	});

	async function validateGrantV5(input: unknown) {
		try {
			const request = RuntimeNativeCapabilityRequestV5Schema.parse(input);
			const claims = validateVerifiedRuntimeExecutionGrantClaimsV4(
				verifyGrantToken(publicKeys, request.grant.token),
				context(),
			);
			await validateRuntimeBusinessBindingV5(request, claims);
			return { request, claims };
		} catch {
			authorizationDenied();
		}
	}

	async function validateRecoveryGrantV5(input: unknown) {
		try {
			const request = RuntimeRestoreExecutionKeyRequestV5Schema.parse(input);
			const claims = validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5(
				RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse(
					verifyGrantToken(publicKeys, request.grant.token),
				),
				context(),
			);
			await validateRuntimeRestoreExecutionKeyBindingV5(request, claims);
			return { request, claims };
		} catch {
			authorizationDenied();
		}
	}

	return { validateGrantV5, validateRecoveryGrantV5 };
}
