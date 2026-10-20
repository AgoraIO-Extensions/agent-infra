import { type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import {
	RuntimeExecutionGrantV4Schema,
	RuntimeExecutionGrantV5Schema,
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimeNativeCapabilityRequestV5Schema,
	RuntimeNativeCapabilityTransportV4Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV4Schema,
	RuntimeRestoreExecutionKeyGrantClaimsV5Schema,
	RuntimeRestoreExecutionKeyRequestV4Schema,
	RuntimeRestoreExecutionKeyRequestV5Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSubmitTurnTransportV4Schema,
	RuntimeSupplementRequestV4Schema,
	RuntimeSupplementTransportV4Schema,
	VerifiedRuntimeExecutionGrantV4Schema,
	validateRuntimeBusinessBindingV4,
	validateRuntimeBusinessBindingV5,
	validateRuntimePrivateRelayKeyFieldV1,
	validateRuntimeRestoreExecutionKeyBindingV4,
	validateRuntimeRestoreExecutionKeyBindingV5,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4,
	validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5,
} from "@agent-infra/contracts/runtime";

import { runtimeAuthorizationDenied } from "./runtime-authorization.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decode(segment: string): Buffer {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) runtimeAuthorizationDenied();
	const decoded = Buffer.from(segment, "base64url");
	if (decoded.toString("base64url") !== segment) runtimeAuthorizationDenied();
	return decoded;
}

export function createRuntimeExecutionGrantVerifierV4(
	publicKeys: ReadonlyMap<string, KeyObject>,
) {
	return (value: unknown) => {
		const verified = verifySignedRuntimeGrantV4(publicKeys, value);
		return VerifiedRuntimeExecutionGrantV4Schema.parse(verified);
	};
}

/** Verifies one `runtime-execution+jws` token and returns its decoded claims. */
function verifySignedRuntimeToken(
	publicKeys: ReadonlyMap<string, KeyObject>,
	token: string,
): unknown {
	const parts = token.split(".");
	if (parts.length !== 3) runtimeAuthorizationDenied();
	const [headerPart, claimsPart, signaturePart] = parts;
	if (!headerPart || !claimsPart || !signaturePart)
		runtimeAuthorizationDenied();
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
		runtimeAuthorizationDenied();
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
		runtimeAuthorizationDenied();
	return JSON.parse(utf8.decode(decode(claimsPart))) as unknown;
}

/** Signature-only verifier used by the independent recovery Grant schema. */
function verifySignedRuntimeGrantV4(
	publicKeys: ReadonlyMap<string, KeyObject>,
	value: unknown,
) {
	try {
		const grant = RuntimeExecutionGrantV4Schema.parse(value);
		return {
			token: grant.token,
			claims: verifySignedRuntimeToken(publicKeys, grant.token),
		};
	} catch {
		runtimeAuthorizationDenied();
	}
}

async function validateRuntimeExecutionGrantV4(
	request: unknown,
	verificationInput: unknown,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly now?: () => number;
	},
) {
	try {
		const parsedRequest =
			request !== null && typeof request === "object" && "selection" in request
				? RuntimeSubmitTurnRequestV4Schema.parse(request)
				: request !== null &&
						typeof request === "object" &&
						"capabilityId" in request
					? RuntimeNativeCapabilityRequestV4Schema.parse(request)
					: RuntimeSupplementRequestV4Schema.parse(request);
		const verification =
			VerifiedRuntimeExecutionGrantV4Schema.parse(verificationInput);
		if (verification.token !== parsedRequest.grant.token)
			runtimeAuthorizationDenied();
		const claims = validateVerifiedRuntimeExecutionGrantClaimsV4(
			verification.claims,
			{
				expectedIssuer: options.expectedIssuer,
				expectedWorkerId: options.expectedWorkerId,
				now: (options.now ?? Date.now)(),
			},
		);
		await validateRuntimeBusinessBindingV4(parsedRequest, claims);
		return { request: parsedRequest, claims };
	} catch {
		runtimeAuthorizationDenied();
	}
}

export function createRuntimeExecutionGrantValidatorV4(
	publicKeys: ReadonlyMap<string, KeyObject>,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly now?: () => number;
	},
) {
	const verifyGrant = createRuntimeExecutionGrantVerifierV4(publicKeys);
	return async (request: unknown) => {
		try {
			const parsedRequest =
				request !== null &&
				typeof request === "object" &&
				"selection" in request
					? RuntimeSubmitTurnRequestV4Schema.parse(request)
					: request !== null &&
							typeof request === "object" &&
							"capabilityId" in request
						? RuntimeNativeCapabilityRequestV4Schema.parse(request)
						: RuntimeSupplementRequestV4Schema.parse(request);
			return await validateRuntimeExecutionGrantV4(
				parsedRequest,
				verifyGrant(parsedRequest.grant),
				options,
			);
		} catch {
			runtimeAuthorizationDenied();
		}
	};
}

// The Host must authenticate the Worker transport before calling this validator.
export function createRuntimeExecutionKeyDeliveryValidatorV4(
	publicKeys: ReadonlyMap<string, KeyObject>,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly now?: () => number;
	},
) {
	const validateGrant = createRuntimeExecutionGrantValidatorV4(
		publicKeys,
		options,
	);
	return async (transport: unknown) => {
		try {
			const businessRequest =
				transport !== null &&
				typeof transport === "object" &&
				"businessRequest" in transport
					? transport.businessRequest
					: undefined;
			const parsed =
				businessRequest !== null &&
				typeof businessRequest === "object" &&
				"selection" in businessRequest
					? RuntimeSubmitTurnTransportV4Schema.parse(transport)
					: businessRequest !== null &&
							typeof businessRequest === "object" &&
							"capabilityId" in businessRequest
						? RuntimeNativeCapabilityTransportV4Schema.parse(transport)
						: RuntimeSupplementTransportV4Schema.parse(transport);
			const accepted = await validateGrant(parsed.businessRequest);
			const privateField = validateRuntimePrivateRelayKeyFieldV1(
				parsed.privateKeyField,
				{
					request: accepted.request,
					grantId: accepted.claims.grantId,
					requestDigest: accepted.claims.requestDigest,
				},
			);
			return {
				...accepted,
				relayKey: privateField.keyDelivery.relayKey,
			};
		} catch {
			runtimeAuthorizationDenied();
		}
	};
}

/**
 * Validate the separate existing-accepted-only recovery capability.  This is
 * deliberately independent from ordinary submit/supplement validation so a
 * recovery Grant cannot be replayed as a new business operation.
 */
export function createRuntimeExecutionKeyRecoveryValidatorV4(
	publicKeys: ReadonlyMap<string, KeyObject>,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly now?: () => number;
	},
) {
	return async (transport: unknown) => {
		try {
			const request =
				RuntimeRestoreExecutionKeyRequestV4Schema.parse(transport);
			const grant = request.grant;
			const verified = verifySignedRuntimeGrantV4(publicKeys, grant);
			const recoveryClaims =
				RuntimeRestoreExecutionKeyGrantClaimsV4Schema.parse(verified.claims);
			const claims = validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV4(
				recoveryClaims,
				{
					expectedIssuer: options.expectedIssuer,
					expectedWorkerId: options.expectedWorkerId,
					now: (options.now ?? Date.now)(),
				},
			);
			await validateRuntimeRestoreExecutionKeyBindingV4(request, claims);
			return { request, claims };
		} catch {
			runtimeAuthorizationDenied();
		}
	};
}

/**
 * Verifies the reused V4 business Grant carried by a Native V5 Skill request
 * and revalidates the exact ordered attachment binding against its claims.
 */
export function createRuntimeExecutionGrantValidatorV5(
	publicKeys: ReadonlyMap<string, KeyObject>,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly now?: () => number;
	},
) {
	const verifyGrant = createRuntimeExecutionGrantVerifierV4(publicKeys);
	return async (request: unknown) => {
		try {
			const parsedRequest =
				RuntimeNativeCapabilityRequestV5Schema.parse(request);
			const verification = verifyGrant(parsedRequest.grant);
			if (verification.token !== parsedRequest.grant.token)
				runtimeAuthorizationDenied();
			const claims = validateVerifiedRuntimeExecutionGrantClaimsV4(
				verification.claims,
				{
					expectedIssuer: options.expectedIssuer,
					expectedWorkerId: options.expectedWorkerId,
					now: (options.now ?? Date.now)(),
				},
			);
			await validateRuntimeBusinessBindingV5(parsedRequest, claims);
			return { request: parsedRequest, claims };
		} catch {
			runtimeAuthorizationDenied();
		}
	};
}

/**
 * Verifies the independent existing-accepted-only recovery Grant for a Native
 * V5 Skill. The ordered `acceptedAttachmentIds` must match the original V5
 * request; the Host never rematerializes inputs during recovery.
 */
export function createRuntimeExecutionKeyRecoveryValidatorV5(
	publicKeys: ReadonlyMap<string, KeyObject>,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly now?: () => number;
	},
) {
	return async (transport: unknown) => {
		try {
			const request =
				RuntimeRestoreExecutionKeyRequestV5Schema.parse(transport);
			const grant = RuntimeExecutionGrantV5Schema.parse(request.grant);
			const verifiedClaims = verifySignedRuntimeToken(publicKeys, grant.token);
			const recoveryClaims =
				RuntimeRestoreExecutionKeyGrantClaimsV5Schema.parse(verifiedClaims);
			const claims = validateVerifiedRuntimeRestoreExecutionKeyGrantClaimsV5(
				recoveryClaims,
				{
					expectedIssuer: options.expectedIssuer,
					expectedWorkerId: options.expectedWorkerId,
					now: (options.now ?? Date.now)(),
				},
			);
			await validateRuntimeRestoreExecutionKeyBindingV5(request, claims);
			return { request, claims };
		} catch {
			runtimeAuthorizationDenied();
		}
	};
}
