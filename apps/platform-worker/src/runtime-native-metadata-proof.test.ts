import { generateKeyPairSync, verify } from "node:crypto";

import {
	type RuntimeNativeMetadataBindingResponseV1,
	RuntimeNativeMetadataProofClaimsV1Schema,
	runtimeNativeMetadataProofSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "./runtime-native-metadata-proof.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const binding: RuntimeNativeMetadataBindingResponseV1 = {
	schemaVersion: 1,
	readId: "read-proof",
	selector: "skills",
	scope: {
		schemaVersion: 1,
		principal: { kind: "user", id: "user-proof" },
		agentId: "agent-proof",
		channelId: "web",
		conversationId: "conversation-proof",
		executionId: "execution-proof",
		sessionGeneration: 2,
		authorizationRevision: "authorization-proof",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-proof",
	traceId: "trace-proof",
	originalHostScopeRef: "host-proof",
};

function decode(segment: string) {
	return JSON.parse(
		Buffer.from(segment, "base64url").toString("utf8"),
	) as unknown;
}

describe("Worker native metadata proof issuer", () => {
	it("issues a bounded proof that verifies against its deployment key", async () => {
		const issuer = createWorkerRuntimeNativeMetadataProofIssuerV1({
			issuer: "platform-worker",
			workerId: "worker-proof",
			keyVersion: "metadata-key-v1",
			privateKey,
			now: () => 2_000,
		});
		const proof = await issuer.issue({
			request: binding,
			signal: new AbortController().signal,
		});
		const [headerSegment, payloadSegment, signatureSegment] =
			proof.token.split(".");
		if (!headerSegment || !payloadSegment || !signatureSegment)
			throw new Error("Malformed proof");
		const header = decode(headerSegment) as {
			alg: string;
			kid: string;
			typ: string;
		};
		const claims = RuntimeNativeMetadataProofClaimsV1Schema.parse(
			decode(payloadSegment),
		);
		expect(header).toEqual({
			alg: "EdDSA",
			kid: "metadata-key-v1",
			typ: "native-metadata+jws",
		});
		expect(claims).toMatchObject({
			issuer: "platform-worker",
			workerId: "worker-proof",
			originalHostScopeRef: binding.originalHostScopeRef,
			requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(
			verify(
				null,
				Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
				publicKey,
				Buffer.from(signatureSegment, "base64url"),
			),
		).toBe(true);
		expect(runtimeNativeMetadataProofSigningPayloadV1(claims)).toContain(
			'"purpose":"native_metadata_read"',
		);
	});

	it.each(["aborted", "clock-before-read"] as const)(
		"rejects %s proof inputs",
		async (failure) => {
			const issuer = createWorkerRuntimeNativeMetadataProofIssuerV1({
				issuer: "platform-worker",
				workerId: "worker-proof",
				keyVersion: "metadata-key-v1",
				privateKey,
				now: () => (failure === "clock-before-read" ? 999 : 2_000),
			});
			const controller = new AbortController();
			if (failure === "aborted") controller.abort();
			await expect(
				issuer.issue({ request: binding, signal: controller.signal }),
			).rejects.toThrow("RUNTIME_NATIVE_METADATA_PROOF_UNAVAILABLE");
		},
	);

	it("rejects an invalid signing key before issuing any proof", () => {
		const { privateKey: rsaKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		expect(() =>
			createWorkerRuntimeNativeMetadataProofIssuerV1({
				issuer: "platform-worker",
				workerId: "worker-proof",
				keyVersion: "metadata-key-v1",
				privateKey: rsaKey,
			}),
		).toThrow("Runtime native metadata proof options are invalid");
	});
});
