import { createHash, type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import {
	type RuntimeExecutionGrantClaimsV2,
	type RuntimeExecutionGrantV2,
	RuntimeExecutionGrantV2Schema,
	type RuntimeSubmitTurnRequestV3,
	runtimeRequestSigningPayloadV3,
	VerifiedRuntimeExecutionGrantV2Schema,
	validateVerifiedRuntimeExecutionGrantClaimsV2,
} from "@agent-infra/contracts/runtime";

import {
	isRuntimeAuthorizationDenial,
	runtimeAccessDenialCause,
	runtimeAuthorizationDenied,
} from "./runtime-authorization.js";

export interface RuntimeGrantValidationOptionsV2 {
	expectedIssuer: string;
	expectedWorkerId: string;
	now?: () => number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
function decode(segment: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(segment))
		runtimeAuthorizationDenied("grant-v2-segment-alphabet");
	const decoded = Buffer.from(segment, "base64url");
	if (decoded.toString("base64url") !== segment)
		runtimeAuthorizationDenied("grant-v2-segment-encoding");
	return decoded;
}

export function createRuntimeExecutionGrantVerifierV2(
	publicKeys: ReadonlyMap<string, KeyObject>,
) {
	return (value: RuntimeExecutionGrantV2) => {
		try {
			const grant = RuntimeExecutionGrantV2Schema.parse(value);
			const parts = grant.token.split(".");
			if (parts.length !== 3) runtimeAuthorizationDenied("grant-v2-format");
			const [headerPart, claimsPart, signaturePart] = parts;
			if (!headerPart || !claimsPart || !signaturePart)
				runtimeAuthorizationDenied("grant-v2-segment-empty");
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
				runtimeAuthorizationDenied("grant-v2-header");
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
				runtimeAuthorizationDenied("grant-v2-signature");
			const verified = VerifiedRuntimeExecutionGrantV2Schema.safeParse({
				token: grant.token,
				claims: JSON.parse(utf8.decode(decode(claimsPart))),
			});
			if (!verified.success)
				runtimeAuthorizationDenied("grant-v2-claims-schema");
			return verified.data;
		} catch (error) {
			if (isRuntimeAuthorizationDenial(error)) throw error;
			runtimeAuthorizationDenied("grant-v2-malformed");
		}
	};
}

type BoundRequest = Omit<RuntimeSubmitTurnRequestV3, "input" | "selection"> & {
	input?: RuntimeSubmitTurnRequestV3["input"];
	consumer?: "platform_worker_persistence";
	afterCursor?: string | null;
	confirmedCursor?: string;
};

export function validateRuntimeExecutionGrantV2(
	request: BoundRequest,
	command: RuntimeExecutionGrantClaimsV2["allowedCommands"][0],
	verificationInput: unknown,
	options: RuntimeGrantValidationOptionsV2,
) {
	try {
		const verification =
			VerifiedRuntimeExecutionGrantV2Schema.parse(verificationInput);
		if (verification.token !== request.grant.token)
			runtimeAuthorizationDenied("v3-token-mismatch");
		let claims: RuntimeExecutionGrantClaimsV2;
		try {
			claims = validateVerifiedRuntimeExecutionGrantClaimsV2(
				verification.claims,
				{
					expectedIssuer: options.expectedIssuer,
					expectedWorkerId: options.expectedWorkerId,
					now: (options.now ?? Date.now)(),
				},
			);
		} catch (error) {
			return runtimeAuthorizationDenied(
				`v3-claims-${runtimeAccessDenialCause(error)}`,
			);
		}
		for (const key of [
			"agentId",
			"channelId",
			"conversationId",
			"executionId",
			"turnId",
			"sessionGeneration",
			"traceId",
			"hostSessionRef",
		] as const) {
			if (claims[key] !== request[key])
				runtimeAuthorizationDenied("v3-scope-mismatch");
		}
		if (
			claims.allowedCommands.length !== 1 ||
			claims.principal.kind !== request.principal.kind ||
			claims.principal.id !== request.principal.id ||
			claims.allowedCommands[0] !== command ||
			Object.entries(claims.operation).some(
				([key, value]) =>
					request.operation[key as keyof typeof request.operation] !== value,
			) ||
			claims.requestDigest !==
				createHash("sha256")
					.update(runtimeRequestSigningPayloadV3(request))
					.digest("hex")
		)
			runtimeAuthorizationDenied("v3-request-mismatch");
		const expectedKind =
			command === "turn.supplement"
				? "message"
				: command === "turn.stop"
					? "stop"
					: command === "generation.cancel"
						? "generation"
						: "execution";
		if (
			claims.operation.kind !== expectedKind ||
			(expectedKind === "execution" &&
				claims.operation.id !== claims.executionId)
		)
			runtimeAuthorizationDenied("v3-operation-kind");
		if (command === "events.persist" || command === "events.ack") {
			const access = claims.eventAccess;
			if (
				!access ||
				access.consumer !== request.consumer ||
				access.command !== command ||
				(access.command === "events.persist" &&
					access.afterCursor !== request.afterCursor) ||
				(access.command === "events.ack" &&
					access.confirmedCursor !== request.confirmedCursor)
			)
				runtimeAuthorizationDenied("v3-event-access");
		}
		if (claims.purpose === "control" && request.input !== undefined)
			runtimeAuthorizationDenied("v3-control-input");
		if (claims.purpose === "business") {
			const requestedAttachments = request.input?.attachments ?? [];
			const requested = new Set(requestedAttachments);
			if (
				requested.size !== requestedAttachments.length ||
				claims.attachments.length !== requestedAttachments.length ||
				claims.attachments.some((entry) => !requested.has(entry.attachmentId))
			)
				runtimeAuthorizationDenied("v3-attachments");
		}
		return claims;
	} catch (error) {
		if (isRuntimeAuthorizationDenial(error)) throw error;
		runtimeAuthorizationDenied("v3-grant-malformed");
	}
}
