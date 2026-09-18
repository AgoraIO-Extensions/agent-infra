import { generateKeyPairSync } from "node:crypto";
import {
	canonicalJsonV1,
	sha256,
	signEnvelopeV1,
	verifyEnvelopeV1,
} from "@agent-infra/provider-egress-contracts";
import { describe, expect, it, vi } from "vitest";

import {
	createProviderEgressAdmissionApp,
	createProviderEgressAssertionIssuer,
	verifyProviderEgressReceipt,
} from "./provider-egress-control";

describe("Provider Egress control plane", () => {
	it("persists an exact hop before returning a signed assertion", async () => {
		const keys = generateKeyPairSync("ed25519");
		const prepare = vi.fn(async () => undefined);
		const issue = createProviderEgressAssertionIssuer({
			environment: "test",
			issuer: "connection-control-plane",
			key: { id: "assertion-key-1", privateKey: keys.privateKey },
			now: () => 1_800_000_000_000,
			store: { prepare },
		});
		const result = await issue({
			actionVersionId: "github.get_current_user@v8",
			callId: "call-1",
			certificateThumbprint: "sha256:workload",
			connectionId: "connection-1",
			credential: "github-token",
			credentialVersionId: "credential-1",
			effect: "READ",
			plan: {
				actionVersionId: "github.get_current_user@v8",
				method: "GET",
				origin: "https://api.github.com",
				path: "/user",
				version: 1,
			},
			providerReleaseId: "github-connection-v8",
			recoveryGeneration: "generation-1",
		});
		const claims = verifyEnvelopeV1(result.assertion, keys.publicKey);
		expect(claims).toMatchObject({
			callId: "call-1",
			credentialHash: sha256("github-token"),
			expiresAt: 1_800_000_030,
		});
		expect(prepare).toHaveBeenCalledWith(
			expect.objectContaining({
				assertionHash: sha256(canonicalJsonV1(result.assertion)),
				callId: "call-1",
				effect: "READ",
			}),
		);
	});

	it("admits only the configured Egress workload", async () => {
		const admit = vi.fn(async () => "ACCEPTED_NOW" as const);
		const app = createProviderEgressAdmissionApp({
			authenticateEgress: async () => ({ serviceId: "egress-la3" }),
			expectedServiceId: "egress-la3",
			store: { admit },
		});
		const response = await app.request("/internal/provider-egress/admissions", {
			body: JSON.stringify({
				assertionHash: "sha256:assertion",
				dispatchId: "dispatch-1",
				hopId: "hop-1",
				jti: "jti-1",
				leaseProofHash: "sha256:lease",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ admission: "ACCEPTED_NOW" });
		expect(admit).toHaveBeenCalledOnce();
	});

	it("verifies receipt identity bindings", () => {
		const keys = generateKeyPairSync("ed25519");
		const envelope = signEnvelopeV1(
			{
				dispatchId: "dispatch-1",
				hopId: "hop-1",
				jti: "jti-1",
				type: "COMPLETED",
				version: 1,
			},
			"receipt-key-1",
			keys.privateKey,
		);
		expect(
			verifyProviderEgressReceipt({
				dispatchId: "dispatch-1",
				envelope,
				hopId: "hop-1",
				jti: "jti-1",
				publicKey: keys.publicKey,
			}),
		).toMatchObject({ type: "COMPLETED" });
		expect(() =>
			verifyProviderEgressReceipt({
				dispatchId: "dispatch-other",
				envelope,
				hopId: "hop-1",
				jti: "jti-1",
				publicKey: keys.publicKey,
			}),
		).toThrow(/binding/);
	});
});
