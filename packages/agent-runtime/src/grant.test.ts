import { generateKeyPairSync, sign } from "node:crypto";

import type {
	ExecutionGrantClaimsV1,
	RuntimeSubmitTurnRequestV1,
	SignedExecutionGrantV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";

import { RuntimeHostError, verifyExecutionGrant } from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const claims: ExecutionGrantClaimsV1 = {
	schemaVersion: 1,
	issuer: "agent-platform",
	audience: ["agent-runtime-host"],
	issuedAt: "2026-08-28T09:59:00Z",
	expiresAt: "2026-08-28T10:01:00Z",
	grantId: "grant-1",
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	operations: ["turn.submit"],
	attachments: [{ attachmentId: "attachment-1", operations: ["read"] }],
	actionSetVersion: "actions-1",
};

function signedGrant(
	value: ExecutionGrantClaimsV1 = claims,
): SignedExecutionGrantV1 {
	const payload = Buffer.from(JSON.stringify(value));
	return {
		schemaVersion: 1,
		algorithm: "Ed25519",
		keyId: "key-1",
		payload: payload.toString("base64url"),
		signature: sign(null, payload, privateKey).toString("base64url"),
	};
}

function request(grant = signedGrant()): RuntimeSubmitTurnRequestV1 {
	return {
		schemaVersion: 1,
		requestId: "request-1",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		turnId: "turn-1",
		sessionGeneration: 1,
		deliveryFence: 1,
		grant,
		input: {
			text: "synthetic-conformance-input",
			attachments: ["attachment-1"],
		},
	};
}

const verifier = {
	expectedIssuer: "agent-platform",
	expectedAudience: "agent-runtime-host",
	publicKeys: new Map([["key-1", publicKey]]),
	now: () => new Date("2026-08-28T10:00:00Z"),
};

describe("Execution Grant verification", () => {
	it("returns verified claims only when signature, context, operation, and attachments match", () => {
		expect(verifyExecutionGrant(request(), "turn.submit", verifier)).toEqual(
			claims,
		);
	});

	it.each([
		[
			"signature",
			() => ({
				...request(),
				grant: { ...signedGrant(), signature: "dGFtcGVyZWQ" },
			}),
		],
		[
			"issuer",
			() => request(signedGrant({ ...claims, issuer: "other-platform" })),
		],
		[
			"audience",
			() => request(signedGrant({ ...claims, audience: ["tool-gateway"] })),
		],
		[
			"expired",
			() =>
				request(signedGrant({ ...claims, expiresAt: "2026-08-28T09:59:59Z" })),
		],
		["binding", () => ({ ...request(), conversationId: "conversation-2" })],
		[
			"operation",
			() => request(signedGrant({ ...claims, operations: ["session.status"] })),
		],
		[
			"attachment",
			() => ({
				...request(),
				input: { text: "synthetic", attachments: ["attachment-2"] },
			}),
		],
	])(
		"rejects invalid %s before authorization succeeds",
		(_name, invalidRequest) => {
			expect(() =>
				verifyExecutionGrant(invalidRequest(), "turn.submit", verifier),
			).toThrow(RuntimeHostError);
		},
	);
});
