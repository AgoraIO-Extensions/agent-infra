import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createRuntimeExecutionGrantVerifierV2,
	validateRuntimeExecutionGrantV2,
} from "../../../packages/agent-runtime/src/grant-v2.js";
import { createWorkerRuntimeGrantSignerV2 } from "./runtime-grant-signer.js";

const now = 1_800_000_000_000;
const keys = generateKeyPairSync("ed25519");
const signer = createWorkerRuntimeGrantSignerV2({
	issuer: "platform",
	workerId: "worker",
	keyId: "signer",
	privateKey: keys.privateKey,
	now: () => now,
});
const verify = createRuntimeExecutionGrantVerifierV2(
	new Map([["signer", keys.publicKey]]),
);
const request = {
	schemaVersion: 3 as const,
	requestId: "request",
	traceId: "trace",
	principal: { kind: "user" as const, id: "user" },
	channelId: "web",
	agentId: "agent",
	conversationId: "conversation",
	executionId: "execution",
	turnId: "turn",
	sessionGeneration: 1,
	hostSessionRef: null,
	operation: {
		kind: "execution" as const,
		id: "execution",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
};
const validation = {
	expectedIssuer: "platform",
	expectedWorkerId: "worker",
	now: () => now,
};

describe("Worker Runtime grant signer", () => {
	it("signs the final input/selection and original authorization record with a 30-second lifetime", () => {
		const body = {
			...request,
			input: { text: "synthetic request", attachments: ["attachment-1"] },
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "option",
				reasoningLevel: "high",
			},
		};
		const grant = signer(
			body,
			{ purpose: "business", authorizationRecordId: "original-boundary" },
			"turn.submit",
		);
		const claims = validateRuntimeExecutionGrantV2(
			{ ...body, grant },
			"turn.submit",
			verify(grant),
			validation,
		);
		expect(claims).toMatchObject({
			purpose: "business",
			authorizationRecordId: "original-boundary",
			expiresAt: now + 30_000,
			attachments: [{ attachmentId: "attachment-1", operations: ["read"] }],
		});
		expect(() =>
			validateRuntimeExecutionGrantV2(
				{
					...body,
					input: { text: "tampered", attachments: ["attachment-1"] },
					grant,
				},
				"turn.submit",
				verify(grant),
				validation,
			),
		).toThrow();
	});
	it("control carries only a control source and never grants renewal or input", () => {
		const body = { ...request, originalOperationDigest: "a".repeat(43) };
		const authority = {
			purpose: "control" as const,
			controlRecordId: "stored-control",
			reason: "authorization_revoked" as const,
		};
		const grant = signer(body, authority, "session.status");
		const claims = validateRuntimeExecutionGrantV2(
			{ ...body, grant },
			"session.status",
			verify(grant),
			validation,
		);
		expect(claims).toMatchObject({
			purpose: "control",
			controlRecordId: "stored-control",
		});
		expect(claims).not.toHaveProperty("attachments");
		expect(claims).not.toHaveProperty("authorizationRecordId");
		expect(() => signer(body, authority, "execution.renew")).toThrow();
	});
	it.each(["session.status", "events.persist", "events.ack"] as const)(
		"binds the original recovery pass ID in a %s grant",
		(command) => {
			const body = {
				...request,
				hostSessionRef: "original-host",
				...(command === "session.status"
					? { originalOperationDigest: "a".repeat(43) }
					: {
							consumer: "platform_worker_persistence" as const,
							...(command === "events.persist"
								? { afterCursor: null }
								: { confirmedCursor: "original-cursor" }),
						}),
			};
			const grant = signer(
				body,
				{
					purpose: "control",
					controlRecordId: "original-control",
					reason: "recovery",
				},
				command,
			);
			const verified = verify(grant);
			expect(() =>
				validateRuntimeExecutionGrantV2(
					{ ...body, grant },
					command,
					verified,
					validation,
				),
			).not.toThrow();
			expect(() =>
				validateRuntimeExecutionGrantV2(
					{ ...body, grant, requestId: "substituted-pass" },
					command,
					verified,
					validation,
				),
			).toThrow();
		},
	);
});
