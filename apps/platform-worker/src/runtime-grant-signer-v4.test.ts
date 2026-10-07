import { sign, verify } from "node:crypto";
import {
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	RuntimeSupplementRequestV4Schema,
	runtimeEventRequestDigestV4,
	runtimeRequestDigestV4,
	validateRuntimeBusinessBindingV4,
	validateVerifiedRuntimeExecutionGrantClaimsV2,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createWorkerRuntimeGrantSignerV4 } from "./runtime-grant-signer-v4.js";
import { signing, signingKeys, time } from "./test-support/runtime-v4.js";

function fixture() {
	const signer = createWorkerRuntimeGrantSignerV4(signing);
	const request = RuntimeSubmitTurnRequestV4Schema.parse({
		schemaVersion: 4,
		requestId: "request",
		traceId: "trace",
		principal: { kind: "user", id: "user" },
		executionSource: "web",
		channelId: "web",
		agentId: "agent",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "execution",
			deliveryFence: 2,
			executionDeliveryFence: 2,
		},
		keyBinding: {
			purpose: "personal",
			subjectId: "user",
			ciphertextRef: "key-original",
			version: 1,
		},
		input: { text: "accepted input", attachments: ["attachment"] },
		selection: {
			schemaVersion: 1,
			modelOptionId: "option",
			reasoningLevel: "high",
		},
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "unsigned.unsigned.unsigned",
		},
	});
	return { signer, request };
}
function decoded(token: string) {
	const [header, payload, signature] = token.split(".");
	if (!header || !payload || !signature) throw new Error("Missing JWS fixture");
	expect(
		verify(
			null,
			Buffer.from(`${header}.${payload}`, "ascii"),
			signingKeys.publicKey,
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("V4 production Grant signer", () => {
	it("signs submit and supplement with independent signature and published digest checks", async () => {
		const { signer, request } = fixture();
		const { selection: _selection, ...context } = request;
		const supplement = RuntimeSupplementRequestV4Schema.parse({
			...context,
			hostSessionRef: "host",
			operation: {
				kind: "message",
				id: "message",
				deliveryFence: 3,
				executionDeliveryFence: 2,
			},
		});
		for (const value of [request, supplement]) {
			const grant = signer.sign(value, "authorization");
			const claims = decoded(grant.token);
			expect(claims).toMatchObject({
				schemaVersion: 4,
				issuer: "platform",
				audience: "runtime_host",
				workerId: "transport",
				purpose: "business",
				authorizationRecordId: "authorization",
				relayKeyBinding: value.keyBinding,
				executionSource: "web",
				allowedCommands: [
					"selection" in value ? "turn.submit" : "turn.supplement",
				],
				attachments: [{ attachmentId: "attachment", operations: ["read"] }],
			});
			expect(claims.requestDigest).toBe(await runtimeRequestDigestV4(value));
			await expect(
				validateRuntimeBusinessBindingV4(
					{ ...value, grant },
					signer.verify(grant),
				),
			).resolves.toBeUndefined();
			expect(claims).not.toHaveProperty("relayKey");
			expect(claims).not.toHaveProperty("privateKeyField");
		}
	});

	it.each([
		"wrong source",
		"application personal Key",
		"cross subject",
		"wrong operation",
		"duplicate attachment",
	])("refuses %s before signing", (mismatch) => {
		const { signer, request } = fixture();
		if (mismatch === "wrong source") request.executionSource = "eval";
		if (mismatch === "application personal Key")
			request.principal.kind = "application";
		if (mismatch === "cross subject")
			request.keyBinding.subjectId = "other-user";
		if (mismatch === "wrong operation") request.operation.kind = "message";
		if (mismatch === "duplicate attachment")
			request.input.attachments.push("attachment");
		expect(() => signer.sign(request, "authorization")).toThrow();
	});

	it.each([
		"issuer",
		"worker",
		"expired",
		"future",
		"purpose",
		"command",
		"event access",
	])("rejects cryptographically signed %s claims", (mismatch) => {
		const { signer, request } = fixture();
		const grant = signer.sign(request, "authorization");
		const [header] = grant.token.split(".");
		const claims = decoded(grant.token);
		if (mismatch === "issuer") claims.issuer = "other-platform";
		if (mismatch === "worker") claims.workerId = "other-worker";
		if (mismatch === "expired") claims.expiresAt = time;
		if (mismatch === "future") claims.issuedAt = time + 1;
		if (mismatch === "purpose") claims.purpose = "control";
		if (mismatch === "command") claims.allowedCommands = ["execution.renew"];
		if (mismatch === "event access")
			claims.eventAccess = {
				command: "events.persist",
				consumer: "platform_worker_persistence",
				afterCursor: null,
			};
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const input = `${header}.${payload}`;
		const token = `${input}.${sign(null, Buffer.from(input, "ascii"), signingKeys.privateKey).toString("base64url")}`;
		expect(() => signer.verify({ ...grant, token })).toThrow(
			"Runtime V4 grant is invalid",
		);
	});

	it("rejects token tampering and a different signing key", () => {
		const { signer, request } = fixture();
		const grant = signer.sign(request, "authorization");
		const token = `${grant.token.slice(0, -10)}AAAAAAAAAA`;
		expect(() => signer.verify({ ...grant, token })).toThrow();
		expect(() =>
			createWorkerRuntimeGrantSignerV4({
				...signing,
				keyId: "other-key",
			}).verify(grant),
		).toThrow();
	});

	it("retains V2 event Grant semantics and binds the exact V4 read/ACK cursor", async () => {
		const { signer, request } = fixture();
		const { input: _input, selection: _selection, ...context } = request;
		const read = RuntimeEventReadRequestV4Schema.parse({
			...context,
			hostSessionRef: "host",
			consumer: "platform_worker_persistence",
			afterCursor: null,
			grant: {
				schemaVersion: 2,
				format: "runtime-execution-jws",
				token: "unsigned.unsigned.unsigned",
			},
		});
		const { afterCursor: _cursor, ...ackContext } = read;
		const ack = RuntimeEventAckRequestV4Schema.parse({
			...ackContext,
			confirmedCursor: "committed",
		});
		for (const value of [read, ack]) {
			const grant = await signer.signEvent(value, {
				purpose: "control",
				controlRecordId: "control",
				reason: "recovery",
			});
			const claims = decoded(grant.token);
			expect(grant.schemaVersion).toBe(2);
			expect(claims.requestDigest).toBe(
				await runtimeEventRequestDigestV4(value),
			);
			expect(claims.allowedCommands).toEqual([
				"afterCursor" in value ? "events.persist" : "events.ack",
			]);
			expect(claims.eventAccess).toEqual(
				"afterCursor" in value
					? {
							command: "events.persist",
							consumer: "platform_worker_persistence",
							afterCursor: null,
						}
					: {
							command: "events.ack",
							consumer: "platform_worker_persistence",
							confirmedCursor: "committed",
						},
			);
			expect(
				validateVerifiedRuntimeExecutionGrantClaimsV2(claims, {
					expectedIssuer: "platform",
					expectedWorkerId: "transport",
					now: time,
				}).purpose,
			).toBe("control");
			expect(() => signer.verify({ ...grant, schemaVersion: 4 })).toThrow();
			expect(claims).not.toHaveProperty("relayKeyBinding");
		}
	});
});
