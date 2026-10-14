import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkerRuntimeNativeMetadataProofIssuerV1 } from "../../platform-worker/src/runtime-native-metadata-proof.js";
import { createRuntimeNativeMetadataProofVerifierV1 } from "./native-metadata-proof.js";

const binding = {
	schemaVersion: 1 as const,
	readId: "read-proof-host",
	selector: "skills" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-proof-host" },
		agentId: "agent-proof-host",
		channelId: "web",
		conversationId: "conversation-proof-host",
		executionId: "execution-proof-host",
		sessionGeneration: 1,
		authorizationRevision: "authorization-proof-host",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-proof-host",
	traceId: "trace-proof-host",
	originalHostScopeRef: "host-proof-host",
};

describe("Runtime native metadata proof verifier", () => {
	it("accepts the Worker proof and rejects request drift", async () => {
		const keys = generateKeyPairSync("ed25519");
		const issuer = createWorkerRuntimeNativeMetadataProofIssuerV1({
			issuer: "platform-proof",
			workerId: "worker-proof",
			keyVersion: "key-proof",
			privateKey: keys.privateKey,
			now: () => 2_000,
		});
		const proof = await issuer.issue({
			request: binding,
			apiRequestSourceRef: "api-proof",
			signal: new AbortController().signal,
		});
		const request = { ...binding, apiRequestSourceRef: "api-proof", proof };
		const verifier = createRuntimeNativeMetadataProofVerifierV1({
			publicKey: keys.publicKey,
			issuer: "platform-proof",
			workerId: "worker-proof",
			keyVersion: "key-proof",
			now: () => 2_000,
		});
		expect(() => verifier.verify(request)).not.toThrow();
		expect(() =>
			verifier.verify({
				...request,
				scope: { ...request.scope, agentId: "other-agent" },
			}),
		).toThrow();
	});
});
