import { connectionServiceCredentialFingerprintV1 } from "@agent-infra/platform-core";
import { describe, expect, it } from "vitest";
import {
	type ConnectionMachineClientBindingStoreV1,
	createOwnerConnectionBindingsResolverV1,
} from "./connection-manual-bindings.js";

describe("Owner Connection Host binding resolver", () => {
	it("decrypts only inside the resolver and returns a protected supply ref", async () => {
		const credential = "conn_consumer_0123456789";
		const supplyCalls: string[] = [];
		let persisted: unknown;
		const store: ConnectionMachineClientBindingStoreV1 = {
			load: async () => undefined,
			persist: async (_agentId, binding) => {
				persisted = binding;
			},
		};
		const resolver = createOwnerConnectionBindingsResolverV1({
			databaseUrl: "postgres://unused",
			associationReader: {
				current: async () => ({
					"agent-a": {
						agentId: "agent-a",
						connectionAgentId: "consumer-a",
						ownerId: "owner-a",
						associationRevision: 3,
						credentialFingerprint:
							connectionServiceCredentialFingerprintV1(credential),
						credentialCiphertext: { encrypted: true },
					},
				}),
				close: async () => {},
			},
			decryptor: {
				decrypt: async ({ encryptedRecord }) => {
					expect(encryptedRecord).toEqual({ encrypted: true });
					return {
						outcome: "decrypted",
						plaintext: new TextEncoder().encode(credential),
					};
				},
			},
			hostSupply: {
				materialize: async ({
					agentId,
					associationRevision,
					serviceCredential,
				}) => {
					supplyCalls.push(
						`${agentId}:${associationRevision}:${serviceCredential}`,
					);
					return { ref: "host-secret-agent-a", revision: "r3" };
				},
				revoke: async () => {},
			},
			machineClientBindings: store,
			machineRegistrationEndpointForAgent: () =>
				"https://connection.example.test/connection/v1/agents/consumer-a/oauth-clients",
			issuer: "https://connection.example.test/",
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			audience: "connection-api",
			egressProfile: { ref: "egress", revision: "r1" },
			approvalSource: { ref: "association:agent-a", revision: "r3" },
			callbackUrlForAgent: () =>
				"https://platform.example.test/internal/runtime/oauth/v1/callback/agent-a",
			fetch: async () =>
				new Response(
					JSON.stringify({
						registrationVersion: 1,
						outcome: "KNOWN",
						registration: {
							registrationKey: "agent-a-association-3",
							clientId: "machine-client-a",
						},
					}),
					{ status: 200 },
				),
		});
		const result = await resolver(new AbortController().signal);
		expect(supplyCalls).toEqual([`agent-a:3:${credential}`]);
		expect(result["agent-a"]?.installationSupply).toEqual({
			ref: "host-secret-agent-a",
			revision: "r3",
		});
		expect(persisted).toMatchObject({
			clientId: "machine-client-a",
			registrationKey: "agent-a-association-3",
		});
	});
});
