import { type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import {
	type ExecutionGrantClaimsV1,
	type ExecutionGrantCommandV1,
	type ExecutionGrantV1,
	VerifiedExecutionGrantV1Schema,
	validateExecutionGrantClaimsV1,
} from "@agent-infra/contracts/runtime";

import { RuntimeHostError } from "./errors.js";

interface GrantBoundRequest {
	agentId: string;
	actorId: string;
	channelId: string;
	conversationId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	traceId: string;
	grant: ExecutionGrantV1;
	input?: { attachments: string[] };
}

export interface ExecutionGrantValidationOptions {
	expectedIssuer: string;
	now?: () => string;
}

function authorizationDenied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Execution Grant is invalid or does not authorize this request",
		403,
	);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const base64Url = /^[A-Za-z0-9_-]+$/;

function decodeSegment(segment: string) {
	if (!base64Url.test(segment)) authorizationDenied();
	const decoded = Buffer.from(segment, "base64url");
	if (decoded.toString("base64url") !== segment) authorizationDenied();
	return decoded;
}

export function createExecutionGrantVerifier(
	publicKeys: ReadonlyMap<string, KeyObject>,
) {
	return (grant: ExecutionGrantV1) => {
		try {
			const [protectedSegment, payloadSegment, signatureSegment, extra] =
				grant.token.split(".");
			if (
				!protectedSegment ||
				!payloadSegment ||
				!signatureSegment ||
				extra !== undefined
			) {
				authorizationDenied();
			}
			const header = JSON.parse(
				utf8.decode(decodeSegment(protectedSegment)),
			) as unknown;
			if (
				typeof header !== "object" ||
				header === null ||
				Array.isArray(header) ||
				Object.keys(header).sort().join(",") !== "alg,kid" ||
				(header as { alg?: unknown }).alg !== "EdDSA" ||
				typeof (header as { kid?: unknown }).kid !== "string" ||
				(header as { kid: string }).kid.length === 0
			) {
				authorizationDenied();
			}
			const key = publicKeys.get((header as { kid: string }).kid);
			if (!key) authorizationDenied();
			const signingInput = `${protectedSegment}.${payloadSegment}`;
			if (
				!verify(
					null,
					Buffer.from(signingInput, "ascii"),
					key,
					decodeSegment(signatureSegment),
				)
			) {
				authorizationDenied();
			}
			return VerifiedExecutionGrantV1Schema.parse({
				token: grant.token,
				claims: JSON.parse(utf8.decode(decodeSegment(payloadSegment))),
			});
		} catch {
			authorizationDenied();
		}
	};
}

export function validateRuntimeExecutionGrant(
	request: GrantBoundRequest,
	requiredCommand: ExecutionGrantCommandV1,
	verificationInput: unknown,
	options: ExecutionGrantValidationOptions,
) {
	let claims: ExecutionGrantClaimsV1;
	try {
		const verification =
			VerifiedExecutionGrantV1Schema.parse(verificationInput);
		if (verification.token !== request.grant.token) authorizationDenied();
		claims = validateExecutionGrantClaimsV1(verification.claims, {
			expectedIssuer: options.expectedIssuer,
			requiredAudience: "runtime_host",
			now: (options.now ?? (() => new Date().toISOString()))(),
			expectedBindings: {
				agentId: request.agentId,
				actorId: request.actorId,
				channelId: request.channelId,
				conversationId: request.conversationId,
				turnId: request.turnId,
				executionId: request.executionId,
				sessionGeneration: request.sessionGeneration,
				traceId: request.traceId,
			},
		});
	} catch {
		authorizationDenied();
	}
	const attachments = request.input?.attachments ?? [];
	const allowedAttachments = new Set(
		claims.attachments
			.filter(({ operations }) => operations.includes("read"))
			.map(({ attachmentId }) => attachmentId),
	);

	if (
		!claims.allowedCommands.includes(requiredCommand) ||
		attachments.some((attachmentId) => !allowedAttachments.has(attachmentId))
	) {
		authorizationDenied();
	}

	return claims;
}
