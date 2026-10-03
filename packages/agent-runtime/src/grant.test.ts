import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	type RuntimeGrantFixtureBinding,
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "./grant-fixture.test-support.js";
import {
	createExecutionGrantVerifier,
	RuntimeHostError,
	validateRuntimeExecutionGrant,
} from "./index.js";

const binding: RuntimeGrantFixtureBinding = {
	agentId: "agent-1",
	actorId: "actor-1",
	channelId: "web",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	traceId: "trace-1",
};

function request() {
	return {
		...binding,
		grant: runtimeGrantFixture(binding, ["turn.submit"], {
			attachments: [{ attachmentId: "attachment-1", operations: ["read"] }],
		}),
		input: { attachments: ["attachment-1"] },
	};
}

const options = {
	expectedIssuer: "agent-platform",
	now: () => "2026-08-28T10:00:00Z",
};

describe("Execution Grant validation", () => {
	it("verifies a compact EdDSA JWS before returning claims evidence", () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const fixture = request();
		const claims = verificationForRuntimeGrant(fixture.grant).claims;
		const protectedSegment = Buffer.from(
			JSON.stringify({ alg: "EdDSA", kid: "key-1" }),
		).toString("base64url");
		const payloadSegment = Buffer.from(JSON.stringify(claims)).toString(
			"base64url",
		);
		const signingInput = `${protectedSegment}.${payloadSegment}`;
		const token = `${signingInput}.${sign(
			null,
			Buffer.from(signingInput, "ascii"),
			privateKey,
		).toString("base64url")}`;
		const verifyGrant = createExecutionGrantVerifier(
			new Map([["key-1", publicKey]]),
		);

		expect(
			verifyGrant({ schemaVersion: 1, format: "compact-jws", token }),
		).toEqual({ token, claims });
		expect(() =>
			verifyGrant({
				schemaVersion: 1,
				format: "compact-jws",
				token: `${signingInput}.dGFtcGVyZWQ`,
			}),
		).toThrow(RuntimeHostError);
		expect(() =>
			verifyGrant({
				schemaVersion: 1,
				format: "compact-jws",
				token: `${Buffer.from(
					JSON.stringify({ alg: "HS256", kid: "key-1" }),
				).toString("base64url")}.${payloadSegment}.dGFtcGVyZWQ`,
			}),
		).toThrow(RuntimeHostError);
	});

	it("accepts exact ingress verification, command, bindings, and attachments", () => {
		const input = request();
		expect(
			validateRuntimeExecutionGrant(
				input,
				"turn.submit",
				verificationForRuntimeGrant(input.grant),
				options,
			),
		).toMatchObject(binding);
	});

	it.each([
		[
			"token",
			(input: ReturnType<typeof request>) => ({
				...verificationForRuntimeGrant(input.grant),
				token: "other.payload.signature",
			}),
		],
		[
			"issuer",
			(input: ReturnType<typeof request>) => ({
				...verificationForRuntimeGrant(input.grant),
				claims: {
					...verificationForRuntimeGrant(input.grant).claims,
					issuer: "other-platform",
				},
			}),
		],
		[
			"audience",
			(input: ReturnType<typeof request>) => ({
				...verificationForRuntimeGrant(input.grant),
				claims: {
					...verificationForRuntimeGrant(input.grant).claims,
					audience: ["connection_api"],
				},
			}),
		],
		[
			"binding",
			(input: ReturnType<typeof request>) => ({
				...verificationForRuntimeGrant(input.grant),
				claims: {
					...verificationForRuntimeGrant(input.grant).claims,
					conversationId: "conversation-2",
				},
			}),
		],
		[
			"command",
			(input: ReturnType<typeof request>) => ({
				...verificationForRuntimeGrant(input.grant),
				claims: {
					...verificationForRuntimeGrant(input.grant).claims,
					allowedCommands: ["session.status"],
				},
			}),
		],
		[
			"expiry",
			(input: ReturnType<typeof request>) => ({
				...verificationForRuntimeGrant(input.grant),
				claims: {
					...verificationForRuntimeGrant(input.grant).claims,
					expiresAt: "2026-08-28T09:59:59Z",
				},
			}),
		],
	])("rejects invalid %s evidence", (_name, invalidEvidence) => {
		const input = request();
		expect(() =>
			validateRuntimeExecutionGrant(
				input,
				"turn.submit",
				invalidEvidence(input),
				options,
			),
		).toThrow(RuntimeHostError);
	});

	it("rejects an attachment outside the verified Grant", () => {
		const input = request();
		expect(() =>
			validateRuntimeExecutionGrant(
				{ ...input, input: { attachments: ["attachment-2"] } },
				"turn.submit",
				verificationForRuntimeGrant(input.grant),
				options,
			),
		).toThrow(RuntimeHostError);
	});
});
