import { type KeyObject, verify } from "node:crypto";
import { TextDecoder } from "node:util";

import {
	ExecutionGrantClaimsV1Schema,
	type RuntimeGrantOperationV1,
	type SignedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";

import { RuntimeHostError } from "./errors.js";

interface GrantBoundRequest {
	agentId: string;
	conversationId: string;
	executionId: string;
	turnId: string;
	sessionGeneration: number;
	grant: SignedExecutionGrantV1;
	input?: { attachments: string[] };
}

export interface ExecutionGrantVerifierOptions {
	expectedIssuer: string;
	expectedAudience: string;
	publicKeys: ReadonlyMap<string, KeyObject>;
	now?: () => Date;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function authorizationDenied(): never {
	throw new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Execution Grant is invalid or does not authorize this request",
		403,
	);
}

export function verifyExecutionGrant(
	request: GrantBoundRequest,
	requiredOperation: RuntimeGrantOperationV1,
	options: ExecutionGrantVerifierOptions,
) {
	const key = options.publicKeys.get(request.grant.keyId);
	if (!key) authorizationDenied();

	let payload: Buffer;
	let claimsValue: unknown;
	try {
		payload = Buffer.from(request.grant.payload, "base64url");
		const signature = Buffer.from(request.grant.signature, "base64url");
		if (!verify(null, payload, key, signature)) authorizationDenied();
		claimsValue = JSON.parse(utf8.decode(payload));
	} catch (error) {
		if (error instanceof RuntimeHostError) throw error;
		authorizationDenied();
	}

	const parsed = ExecutionGrantClaimsV1Schema.safeParse(claimsValue);
	if (!parsed.success) authorizationDenied();
	const claims = parsed.data;
	const now = (options.now ?? (() => new Date()))().getTime();
	const issuedAt = Date.parse(claims.issuedAt);
	const expiresAt = Date.parse(claims.expiresAt);
	const attachments = request.input?.attachments ?? [];
	const allowedAttachments = new Set(
		claims.attachments
			.filter(({ operations }) => operations.includes("read"))
			.map(({ attachmentId }) => attachmentId),
	);

	if (
		claims.issuer !== options.expectedIssuer ||
		!claims.audience.includes(options.expectedAudience) ||
		issuedAt > now ||
		expiresAt <= now ||
		issuedAt >= expiresAt ||
		claims.agentId !== request.agentId ||
		claims.conversationId !== request.conversationId ||
		claims.executionId !== request.executionId ||
		claims.turnId !== request.turnId ||
		claims.sessionGeneration !== request.sessionGeneration ||
		!claims.operations.includes(requiredOperation) ||
		attachments.some((attachmentId) => !allowedAttachments.has(attachmentId))
	) {
		authorizationDenied();
	}

	return claims;
}
