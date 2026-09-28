import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeRequestSigningPayloadV4,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantVerifierV4,
} from "./grant-v4.js";

const keys = generateKeyPairSync("ed25519");
const verifyGrant = createRuntimeExecutionGrantVerifierV4(
	new Map([["fixture", keys.publicKey]]),
);
const now = 1_800_000_000_000;
const options = {
	expectedIssuer: "platform-fixture",
	expectedWorkerId: "worker-fixture",
	now: () => now,
};
const validateGrant = createRuntimeExecutionGrantValidatorV4(
	new Map([["fixture", keys.publicKey]]),
	options,
);

const request = RuntimeSubmitTurnRequestV4Schema.parse({
	schemaVersion: 4,
	requestId: "request-fixture",
	traceId: "trace-fixture",
	principal: { kind: "user", id: "user-fixture" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-fixture",
	conversationId: "conversation-fixture",
	executionId: "execution-fixture",
	turnId: "turn-fixture",
	sessionGeneration: 1,
	hostSessionRef: null,
	operation: {
		kind: "execution",
		id: "execution-fixture",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "user-fixture",
		ciphertextRef: "key-fixture",
		version: 1,
	},
	input: { text: "synthetic input", attachments: [] },
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-fixture",
		reasoningLevel: "high",
	},
});

function signed(
	changes: Record<string, unknown> = {},
	headerChanges: Record<string, unknown> = {},
) {
	const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
		schemaVersion: 4,
		issuer: "platform-fixture",
		audience: "runtime_host",
		issuedAt: now,
		expiresAt: now + 30_000,
		grantId: "grant-fixture",
		workerId: "worker-fixture",
		principal: request.principal,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		operation: request.operation,
		requestDigest: createHash("sha256")
			.update(runtimeRequestSigningPayloadV4(request))
			.digest("hex"),
		purpose: "business",
		authorizationRecordId: "authorization-fixture",
		allowedCommands: ["turn.submit"],
		attachments: [],
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		...changes,
	});
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "fixture",
			typ: "runtime-execution+jws",
			...headerChanges,
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const signature = sign(
		null,
		Buffer.from(`${header}.${payload}`),
		keys.privateKey,
	).toString("base64url");
	return {
		...request,
		grant: { ...request.grant, token: `${header}.${payload}.${signature}` },
	};
}

describe("Runtime V4 Grant trust boundary", () => {
	it("verifies Ed25519 JWS and binds the accepted Execution and Key version", async () => {
		const accepted = signed();
		const verified = verifyGrant(accepted.grant);
		await expect(validateGrant(accepted)).resolves.toMatchObject({
			claims: { relayKeyBinding: request.keyBinding },
		});
		expect(verified.claims.grantId).toBe("grant-fixture");
		for (const changed of [
			{ ...accepted, channelId: "wecom" },
			{ ...accepted, executionId: "other-execution" },
			{ ...accepted, keyBinding: { ...accepted.keyBinding, version: 2 } },
			{
				...accepted,
				operation: { ...accepted.operation, deliveryFence: 2 },
			},
		]) {
			await expect(validateGrant(changed)).rejects.toThrow(
				"Runtime authorization is unavailable",
			);
		}
	});

	it("rejects forged, wrong-domain, noncanonical and old-version tokens", () => {
		const accepted = signed();
		const [header, payload, signature] = accepted.grant.token.split(".");
		if (!header || !payload || !signature) throw new Error("Invalid fixture");
		const forgedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
		for (const grant of [
			{ ...accepted.grant, token: `${header}.${payload}.${forgedSignature}` },
			{ ...accepted.grant, token: `${accepted.grant.token}.extra` },
			{ ...accepted.grant, token: accepted.grant.token.replace(".", "=.") },
			{ ...accepted.grant, schemaVersion: 2 },
			signed({}, { typ: "workload-readiness+jws" }).grant,
			signed({}, { kid: "unknown" }).grant,
		]) {
			expect(() => verifyGrant(grant)).toThrow(
				"Runtime authorization is unavailable",
			);
		}
	});

	it("rejects validly signed claims with wrong source, subject or lifetime", async () => {
		for (const changes of [
			{ executionSource: "platform-api" },
			{ relayKeyBinding: { ...request.keyBinding, subjectId: "other-user" } },
			{ issuer: "other-issuer" },
			{ workerId: "other-worker" },
			{ expiresAt: now + 30_001 },
			{
				eventAccess: {
					command: "events.persist",
					consumer: "platform_worker_persistence",
					afterCursor: null,
				},
			},
		]) {
			const changed = signed(changes);
			await expect(validateGrant(changed)).rejects.toThrow(
				"Runtime authorization is unavailable",
			);
		}
	});
});
