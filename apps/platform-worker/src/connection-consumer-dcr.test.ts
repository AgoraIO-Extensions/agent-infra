import { describe, expect, it } from "vitest";
import { createConnectionConsumerDcrResolverV1 } from "./connection-consumer-dcr.js";

const profile = {
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp",
	audience: "connection-api",
	egressProfile: { ref: "egress", revision: "r1" },
};

describe("per-Agent Connection DCR resolver", () => {
	it("registers a distinct approved client for every Agent", async () => {
		const calls: string[] = [];
		const resolve = createConnectionConsumerDcrResolverV1({
			agentIds: ["agent-a", "agent-b"],
			issuer: "https://connection.example.test/",
			registrationEndpoint: "https://connection.example.test/oauth/register",
			...profile,
			approvalSource: { ref: "deployment", revision: "r1" },
			callbackUrlForAgent: (agentId) =>
				`http://127.0.0.1:3044/callback/${agentId}`,
			installationSupplyForAgent: (agentId) => ({
				ref: agentId,
				revision: "r1",
			}),
			consumerIdForAgent: (agentId) =>
				agentId === "agent-a" ? "consumer-a" : "consumer-b",
			approvedOAuthClientIdForAgent: (agentId) =>
				agentId === "agent-a" ? "oauth-client-a" : "oauth-client-b",
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body));
				calls.push(body.redirect_uris[0]);
				const clientId = body.redirect_uris[0].includes("agent-a")
					? "oauth-client-a"
					: "oauth-client-b";
				return new Response(
					JSON.stringify({
						application_type: "native",
						client_id: clientId,
						client_id_issued_at: 1_792_605_381,
						client_name: "Codex",
						grant_types: ["authorization_code", "refresh_token"],
						redirect_uris: body.redirect_uris,
						response_types: ["code"],
						scope: "mcp",
						token_endpoint_auth_method: "none",
					}),
					{ status: 201 },
				);
			},
		});
		const result = await resolve(new AbortController().signal);
		expect(calls).toEqual([
			"http://127.0.0.1:3044/callback/agent-a",
			"http://127.0.0.1:3044/callback/agent-b",
		]);
		expect(result["agent-a"]?.profile.consumerId).toBe("consumer-a");
		expect(result["agent-b"]?.profile.consumerId).toBe("consumer-b");
		expect(result["agent-a"]?.oauthClientBinding.clientId).toBe(
			"oauth-client-a",
		);
		expect(result["agent-b"]?.oauthClientBinding.clientId).toBe(
			"oauth-client-b",
		);
		expect(result["agent-a"]?.installationSupply).toEqual({
			ref: "agent-a",
			revision: "r1",
		});
	});

	it("requires an approved Consumer mapping for every Agent", async () => {
		const resolve = createConnectionConsumerDcrResolverV1({
			agentIds: ["agent-a"],
			issuer: "https://connection.example.test/",
			registrationEndpoint: "https://connection.example.test/oauth/register",
			...profile,
			approvalSource: { ref: "deployment", revision: "r1" },
			callbackUrlForAgent: () => "http://127.0.0.1:3044/callback/agent-a",
			installationSupplyForAgent: () => ({ ref: "a", revision: "r1" }),
			consumerIdForAgent: () => "",
			approvedOAuthClientIdForAgent: () => "oauth-client-a",
			fetch: async () => {
				throw new Error("fetch must not run");
			},
		});
		await expect(resolve(new AbortController().signal)).rejects.toThrow(
			"CONNECTION_CONSUMER_PROFILE_UNAVAILABLE",
		);
	});

	it("validates the approved OAuth client before registration", async () => {
		let registrations = 0;
		const resolve = createConnectionConsumerDcrResolverV1({
			agentIds: ["agent-a"],
			issuer: "https://connection.example.test/",
			registrationEndpoint: "https://connection.example.test/oauth/register",
			...profile,
			approvalSource: { ref: "deployment", revision: "r1" },
			callbackUrlForAgent: () => "http://127.0.0.1:3044/callback/agent-a",
			consumerIdForAgent: () => "consumer-a",
			approvedOAuthClientIdForAgent: () => "",
			installationSupplyForAgent: () => ({ ref: "a", revision: "r1" }),
			fetch: async () => {
				registrations += 1;
				throw new Error("unexpected registration");
			},
		});
		await expect(resolve(new AbortController().signal)).rejects.toThrow(
			"CONNECTION_CONSUMER_PROFILE_UNAVAILABLE",
		);
		expect(registrations).toBe(0);
	});
});
