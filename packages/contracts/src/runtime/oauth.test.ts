import { describe, expect, it } from "vitest";
import { RuntimeOAuthConfigurationV1Schema } from "./oauth.js";

const base = {
	schemaVersion: 1 as const,
	ref: "oauth-v1",
	revision: "r1",
	clientId: "client-a",
	issuer: "https://connection.example.test/",
	authorizationEndpoint: "https://connection.example.test/oauth/authorize",
	tokenEndpoint: "https://connection.example.test/oauth/token",
	revocationEndpoint: "https://connection.example.test/oauth/revoke",
	callbackUrl: "https://platform.example.test/connection/callback",
	runtimeOrigin: "https://runtime.example.test/",
	resource: "https://connection.example.test/mcp",
	scope: "mcp" as const,
	configFingerprint: "a".repeat(64),
	source: { ref: "deployment", revision: "r1" },
};

describe("Runtime OAuth configuration", () => {
	it("accepts a DCR marker with an issuer registration endpoint", () => {
		expect(
			RuntimeOAuthConfigurationV1Schema.parse({
				...base,
				clientId: "dcr",
				clientRegistration: "dcr",
				registrationEndpoint: "https://connection.example.test/oauth/register",
				callbackUrl: "http://127.0.0.1:3044/callback/install-a",
			}),
		).toMatchObject({ clientRegistration: "dcr", clientId: "dcr" });
	});

	it.each([
		{
			clientId: "client-a",
			registrationEndpoint: `${base.issuer}oauth/register`,
		},
		{ clientId: "dcr", clientRegistration: "dcr" as const },
	])("rejects incomplete DCR configuration %j", (change) => {
		expect(() =>
			RuntimeOAuthConfigurationV1Schema.parse({ ...base, ...change }),
		).toThrow();
	});

	it("rejects non-loopback HTTP callbacks", () => {
		expect(() =>
			RuntimeOAuthConfigurationV1Schema.parse({
				...base,
				clientId: "dcr",
				clientRegistration: "dcr",
				registrationEndpoint: "https://connection.example.test/oauth/register",
				callbackUrl: "http://runtime.example.test/callback",
			}),
		).toThrow();
	});
});
