import { generateKeyPairSync, sign } from "node:crypto";
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
	function resignProof(
		proof: { token: string },
		keys: ReturnType<typeof generateKeyPairSync>,
		mutateHeader: (header: Record<string, unknown>) => void = () => {},
		mutateClaims: (claims: Record<string, unknown>) => void = () => {},
	) {
		const [encodedHeader, encodedPayload] = proof.token.split(".");
		if (!encodedHeader || !encodedPayload) throw new Error("invalid fixture");
		const header = JSON.parse(
			Buffer.from(encodedHeader, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		const claims = JSON.parse(
			Buffer.from(encodedPayload, "base64url").toString("utf8"),
		) as Record<string, unknown>;
		mutateHeader(header);
		mutateClaims(claims);
		const nextHeader = Buffer.from(JSON.stringify(header)).toString(
			"base64url",
		);
		const nextPayload = Buffer.from(JSON.stringify(claims)).toString(
			"base64url",
		);
		const signingInput = `${nextHeader}.${nextPayload}`;
		return {
			...proof,
			token: `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), keys.privateKey).toString("base64url")}`,
		};
	}

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
		expect(() =>
			verifier.verify({
				...request,
				proof: resignProof(proof, keys, (header) => {
					delete header.kid;
					header.kid = "key-proof";
				}),
			}),
		).toThrow();
		expect(() =>
			verifier.verify({
				...request,
				proof: resignProof(proof, keys, (header) => {
					header.unexpected = "reject";
				}),
			}),
		).toThrow();
		expect(() =>
			verifier.verify({
				...request,
				proof: resignProof(proof, keys, undefined, (claims) => {
					claims.keyVersion = "another-key";
				}),
			}),
		).toThrow();
		expect(() =>
			verifier.verify({
				...request,
				proof: {
					...proof,
					token: (() => {
						const signatureStart = proof.token.lastIndexOf(".") + 1;
						const first = proof.token[signatureStart];
						if (!first) throw new Error("invalid fixture");
						return `${proof.token.slice(0, signatureStart)}${first === "a" ? "b" : "a"}${proof.token.slice(signatureStart + 1)}`;
					})(),
				},
			}),
		).toThrow();
		expect(() =>
			verifier.verify({
				...request,
				proof: resignProof(proof, keys, (header) => {
					header.kid = "other-key";
				}),
			}),
		).toThrow();
		const claimMutations: Record<
			string,
			(claims: Record<string, unknown>) => void
		> = {
			purpose: (claims) => {
				claims.purpose = "other_stage";
			},
			issuer: (claims) => {
				claims.issuer = "other-issuer";
			},
			audience: (claims) => {
				claims.audience = "other-audience";
			},
			workerId: (claims) => {
				claims.workerId = "other-worker";
			},
			issuedAt: (claims) => {
				claims.issuedAt = 2_001;
			},
			expiresAt: (claims) => {
				claims.expiresAt = 20_001;
			},
			requestDigest: (claims) => {
				claims.requestDigest = "a".repeat(64);
			},
			readId: (claims) => {
				claims.readId = "other-read";
			},
			selector: (claims) => {
				claims.selector = "status";
			},
			originalHostScopeRef: (claims) => {
				claims.originalHostScopeRef = "other-host";
			},
			requestId: (claims) => {
				claims.requestId = "other-request";
			},
			traceId: (claims) => {
				claims.traceId = "other-trace";
			},
			apiRequestSourceRef: (claims) => {
				claims.apiRequestSourceRef = "other-api-source";
			},
			scope: (claims) => {
				claims.scope = {
					...(claims.scope as Record<string, unknown>),
					agentId: "other-agent",
				};
			},
		};
		for (const [field, mutate] of Object.entries(claimMutations)) {
			expect(
				() =>
					verifier.verify({
						...request,
						proof: resignProof(proof, keys, undefined, mutate),
					}),
				field,
			).toThrow();
		}
	});
});
