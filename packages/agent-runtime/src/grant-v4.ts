import { type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import {
	RuntimeExecutionGrantV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSubmitTurnTransportV4Schema,
	RuntimeSupplementRequestV4Schema,
	RuntimeSupplementTransportV4Schema,
	VerifiedRuntimeExecutionGrantV4Schema,
	validateRuntimeBusinessBindingV4,
	validateRuntimePrivateRelayKeyFieldV1,
	validateVerifiedRuntimeExecutionGrantClaimsV4,
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
		try {
			const grant = RuntimeExecutionGrantV4Schema.parse(value);
			const parts = grant.token.split(".");
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
			return VerifiedRuntimeExecutionGrantV4Schema.parse({
				token: grant.token,
				claims: JSON.parse(utf8.decode(decode(claimsPart))),
			});
		} catch {
			runtimeAuthorizationDenied();
		}
	};
}

async function validateRuntimeExecutionGrantV4(
	request: unknown,
	verificationInput: unknown,
	options: {
		readonly expectedIssuer: string;
		readonly expectedWorkerId: string;
		readonly expectedAgentId?: string;
		readonly now?: () => number;
	},
) {
	try {
		const parsedRequest =
			request !== null && typeof request === "object" && "selection" in request
				? RuntimeSubmitTurnRequestV4Schema.parse(request)
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
		if (options.expectedAgentId && claims.agentId !== options.expectedAgentId)
			runtimeAuthorizationDenied();
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
		readonly expectedAgentId?: string;
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
		readonly expectedAgentId?: string;
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
