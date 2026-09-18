import { generateKeyPairSync } from "node:crypto";
import { createProviderEgressApp } from "@agent-infra/connection-provider-egress";
import {
	canonicalJsonV1,
	sha256,
} from "@agent-infra/provider-egress-contracts";
import { describe, expect, it, vi } from "vitest";

import {
	createProviderEgressAssertionIssuer,
	verifyProviderEgressReceipt,
} from "./provider-egress-control";

describe("Control Plane to Provider Egress contract", () => {
	it("prepares, admits, executes, verifies a receipt, and rejects replay", async () => {
		const assertionKeys = generateKeyPairSync("ed25519");
		const receiptKeys = generateKeyPairSync("ed25519");
		let prepared:
			| {
					assertionHash: string;
					dispatchId: string;
					hopId: string;
					jti: string;
			  }
			| undefined;
		let admitted = false;
		const store = {
			prepare: async (input: unknown) => {
				if (!input || typeof input !== "object")
					throw new Error("intent missing");
				const value = input as NonNullable<typeof prepared>;
				prepared = {
					assertionHash: value.assertionHash,
					dispatchId: value.dispatchId,
					hopId: value.hopId,
					jti: value.jti,
				};
			},
			admit: async (input: {
				assertionHash: string;
				dispatchId: string;
				hopId: string;
				jti: string;
			}) => {
				if (!prepared || canonicalJsonV1(input) !== canonicalJsonV1(prepared)) {
					return "REJECTED" as const;
				}
				if (admitted) return "REPLAYED" as const;
				admitted = true;
				return "ACCEPTED_NOW" as const;
			},
		};
		const issue = createProviderEgressAssertionIssuer({
			environment: "local-e2e",
			issuer: "connection-control-plane",
			key: { id: "assertion-key-1", privateKey: assertionKeys.privateKey },
			now: () => 1_800_000_000_000,
			store,
		});
		const dispatch = await issue({
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
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ id: 7, login: "alice" }),
		);
		const egress = createProviderEgressApp({
			admission: {
				admit: async (input) =>
					store.admit({
						assertionHash: input.assertionHash,
						dispatchId: input.dispatchId,
						hopId: input.hopId,
						jti: input.jti,
					}),
			},
			assertionKeys: new Map([["assertion-key-1", assertionKeys.publicKey]]),
			environment: "local-e2e",
			fetcher,
			issuer: "connection-control-plane",
			now: () => 1_800_000_000_000,
			receiptKey: { id: "receipt-key-1", privateKey: receiptKeys.privateKey },
			workloadAuthenticator: {
				authenticate: async () => ({
					certificateThumbprint: "sha256:workload",
				}),
			},
		});
		const execute = () =>
			egress.request("/v1/dispatch", {
				body: JSON.stringify(dispatch),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
		const response = await execute();
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(fetcher).toHaveBeenCalledOnce();
		expect(
			verifyProviderEgressReceipt({
				dispatchId: prepared?.dispatchId ?? "",
				envelope: result.receipt,
				hopId: prepared?.hopId ?? "",
				jti: prepared?.jti ?? "",
				publicKey: receiptKeys.publicKey,
			}),
		).toMatchObject({
			bodyHash: sha256(JSON.stringify({ id: 7, login: "alice" })),
		});

		expect((await execute()).status).toBe(409);
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
