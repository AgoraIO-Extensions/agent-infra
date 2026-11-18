import { connectionServiceCredentialFingerprintV1 } from "@agent-infra/platform-core";
import { describe, expect, it } from "vitest";
import {
	type ConnectionMachineClientBindingStoreV1,
	createOwnerConnectionBindingsResolverV1,
	revokeOwnerConnectionMachineBindingV1,
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

	it("keeps two Owners and Agents on separate protected supplies", async () => {
		const credentials = {
			"agent-a": "conn_consumer_aaaaaaaa",
			"agent-b": "conn_consumer_bbbbbbbb",
		} as const;
		const persisted: string[] = [];
		const supplyCalls: string[] = [];
		const resolver = createOwnerConnectionBindingsResolverV1({
			databaseUrl: "postgres://unused",
			associationReader: {
				current: async () =>
					Object.fromEntries(
						Object.entries(credentials).map(([agentId, credential], index) => [
							agentId,
							{
								agentId,
								connectionAgentId: `consumer-${agentId}`,
								ownerId: `owner-${agentId}`,
								associationRevision: index + 1,
								credentialFingerprint:
									connectionServiceCredentialFingerprintV1(credential),
								credentialCiphertext: { agentId },
							},
						]),
					),
				close: async () => {},
			},
			decryptor: {
				decrypt: async ({ encryptedRecord }) => {
					const agentId = (encryptedRecord as { agentId: string }).agentId;
					return {
						outcome: "decrypted" as const,
						plaintext: new TextEncoder().encode(
							credentials[agentId as keyof typeof credentials],
						),
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
					return {
						ref: `host-${agentId}`,
						revision: `r${associationRevision}`,
					};
				},
				revoke: async () => {},
			},
			machineClientBindings: {
				load: async () => undefined,
				persist: async (agentId) => {
					persisted.push(agentId);
				},
			},
			machineRegistrationEndpointForAgent: (agentId) =>
				`https://connection.example.test/connection/v1/agents/consumer-${agentId}/oauth-clients`,
			issuer: "https://connection.example.test/",
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			audience: "connection-api",
			egressProfile: { ref: "egress", revision: "r1" },
			approvalSource: { ref: "association", revision: "r1" },
			callbackUrlForAgent: (agentId) =>
				`https://platform.example.test/connection/callback/${agentId}`,
			fetch: async (input) => {
				const endpoint = String(input);
				const agentId = endpoint.includes("consumer-agent-a")
					? "agent-a"
					: "agent-b";
				return new Response(
					JSON.stringify({
						registrationVersion: 1,
						outcome: "KNOWN",
						registration: {
							registrationKey: `${agentId}-association-${agentId === "agent-a" ? 1 : 2}`,
							clientId: `client-${agentId}`,
						},
					}),
					{ status: 200 },
				);
			},
		});

		const result = await resolver(new AbortController().signal);
		expect(Object.keys(result).sort()).toEqual(["agent-a", "agent-b"]);
		expect(result["agent-a"]?.installationSupply).toEqual({
			ref: "host-agent-a",
			revision: "r1",
		});
		expect(result["agent-b"]?.installationSupply).toEqual({
			ref: "host-agent-b",
			revision: "r2",
		});
		expect(supplyCalls).toEqual([
			"agent-a:1:conn_consumer_aaaaaaaa",
			"agent-b:2:conn_consumer_bbbbbbbb",
		]);
		expect(persisted).toEqual(["agent-a", "agent-b"]);
	});

	it("revokes the machine client before closing the matching Host supply", async () => {
		const events: string[] = [];
		await revokeOwnerConnectionMachineBindingV1({
			endpoint:
				"https://connection.example.test/connection/v1/agents/consumer-a/oauth-clients",
			serviceCredential: "conn_consumer_0123456789",
			binding: { registrationKey: "agent-a-association-3" },
			signal: new AbortController().signal,
			fetch: async (_input, init) => {
				events.push(`connection:${init?.method}`);
				return new Response(null, { status: 204 });
			},
			hostSupply: {
				materialize: async () => ({ ref: "agent-a", revision: "r3" }),
				revoke: async (input) => {
					events.push(`host:${input.agentId}:${input.associationRevision}`);
				},
			},
			agentId: "agent-a",
			associationRevision: 3,
		});
		expect(events).toEqual(["connection:DELETE", "host:agent-a:3"]);
	});
});
