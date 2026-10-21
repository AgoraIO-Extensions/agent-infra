import { describe, expect, it } from "vitest";
import { registerStandardOAuthClient } from "./standard-oauth.js";

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
