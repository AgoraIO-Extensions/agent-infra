import { describe, expect, it } from "vitest";
import {
	readConnectionMachineOAuthClientV1,
	registerConnectionMachineOAuthClientV1,
	registerStandardOAuthClient,
	revokeConnectionMachineOAuthClientV1,
} from "./standard-oauth.js";

const issuer = "https://connection.example.test/";
const redirectUri = "http://127.0.0.1:3044/callback/install-a";

function response(body: unknown, status = 201) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function valid() {
	return {
		application_type: "native",
		client_id: "client-a",
		client_id_issued_at: 1_792_605_381,
		client_name: "Codex",
		grant_types: ["authorization_code", "refresh_token"],
		redirect_uris: [redirectUri],
		response_types: ["code"],
		scope: "mcp",
		token_endpoint_auth_method: "none",
	};
}

describe("per-install OAuth DCR", () => {
	it("registers an EP-1060 machine client with bearer and idempotency headers", async () => {
		const calls: Request[] = [];
		const receipt = await registerConnectionMachineOAuthClientV1({
			endpoint: `${issuer}connection/v1/agents/agent-a/oauth-clients`,
			serviceCredential: "conn_consumer_test-credential",
			registrationKey: "install-agent-a-r1",
			clientName: "Codex",
			redirectUri: "https://platform.example.test/callback/agent-a",
			resource: "https://connection.example.test/mcp",
			scope: "mcp",
			source: { ref: "platform", revision: "r1" },
			configFingerprint: "a".repeat(64),
			signal: new AbortController().signal,
			assertCurrent() {},
			fetch: async (input, init) => {
				calls.push(new Request(input, init));
				return response({
					registrationVersion: 1,
					outcome: "KNOWN",
					registration: {
						registrationKey: "install-agent-a-r1",
						clientId: "client-agent-a",
					},
				});
			},
		});
		expect(receipt.registration.clientId).toBe("client-agent-a");
		const request = calls[0];
		if (!request) throw new Error("request missing");
		expect(request.headers.get("authorization")).toBe(
			"Bearer conn_consumer_test-credential",
		);
		expect(request.headers.get("idempotency-key")).toBe("install-agent-a-r1");
		expect(await request.json()).toEqual({
			clientName: "Codex",
			redirectUri: "https://platform.example.test/callback/agent-a",
			resource: "https://connection.example.test/mcp",
			scope: "mcp",
			source: { ref: "platform", revision: "r1" },
			configFingerprint: "a".repeat(64),
		});
	});

	it("reads and revokes only the keyed machine registration with bearer auth", async () => {
		const calls: Request[] = [];
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push(new Request(input, init));
			return response(
				{
					registrationVersion: 1,
					outcome: "KNOWN",
					registration: { registrationKey: "install-agent-a-r1", clientId: "client-agent-a" },
				},
				200,
			);
		};
		const options = {
			endpoint: `${issuer}connection/v1/agents/agent-a/oauth-clients`,
			serviceCredential: "conn_consumer_test-credential",
			registrationKey: "install-agent-a-r1",
			signal: new AbortController().signal,
			assertCurrent() {},
			fetch,
		};
		const receipt = await readConnectionMachineOAuthClientV1(options);
		expect(receipt.registration.clientId).toBe("client-agent-a");
		await revokeConnectionMachineOAuthClientV1(options);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[1]?.method).toBe("DELETE");
		for (const request of calls) {
			expect(request.url).toContain("/install-agent-a-r1");
			expect(request.headers.get("authorization")).toBe("Bearer conn_consumer_test-credential");
			expect(request.headers.get("cookie")).toBeNull();
		}
	});

	it("registers and validates the fixed native metadata response", async () => {
		const calls: Request[] = [];
		const clientId = await registerStandardOAuthClient({
			issuer,
			registrationEndpoint: `${issuer}oauth/register`,
			redirectUri,
			scope: "mcp",
			signal: new AbortController().signal,
			assertCurrent() {},
			fetch: async (input, init) => {
				calls.push(new Request(input, init));
				return response(valid());
			},
		});
		expect(clientId).toBe("client-a");
		expect(calls).toHaveLength(1);
		const request = calls[0];
		if (!request) throw new Error("request missing");
		expect(await request.json()).toEqual({
			client_name: "Codex",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			token_endpoint_auth_method: "none",
			response_types: ["code"],
			scope: "mcp",
			application_type: "native",
		});
	});

	it.each([
		["secret response", { ...valid(), client_secret: "secret" }],
		[
			"foreign redirect",
			{ ...valid(), redirect_uris: ["http://127.0.0.1:3044/other"] },
		],
		["wrong scope", { ...valid(), scope: "other" }],
		["wrong grant", { ...valid(), grant_types: ["authorization_code"] }],
	])("rejects %s without returning a client", async (_label, body) => {
		await expect(
			registerStandardOAuthClient({
				issuer,
				registrationEndpoint: `${issuer}oauth/register`,
				redirectUri,
				scope: "mcp",
				signal: new AbortController().signal,
				assertCurrent() {},
				fetch: async () => response(body),
			}),
		).rejects.toMatchObject({ code: "CONNECTION_OAUTH_UNAVAILABLE" });
	});
});
