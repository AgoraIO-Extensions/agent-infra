import { describe, expect, it } from "vitest";
import {
	parseRuntimeOAuthConfigurationsByAgentAndPrincipalV1,
	RuntimeOAuthConfigurationV1Schema,
	runtimeOAuthConfigurationRevisionV1,
} from "./oauth.js";

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

const principalConfiguration = (id: string) => {
	const c = { ...base, ref: `oauth-${id}`, clientId: `client-${id}` };
	return { ...c, revision: runtimeOAuthConfigurationRevisionV1(c) };
};
describe("pre-registered OAuth configurations by Agent and user", () => {
	it("captures independent clients and content revisions without depending on property order", () => {
		const alice = principalConfiguration("alice");
		const bob = principalConfiguration("bob");
		const input = { agent: { alice, bob } };
		const parsed = parseRuntimeOAuthConfigurationsByAgentAndPrincipalV1(input);
		input.agent.alice.clientId = "mutated";
		expect(parsed.agent?.alice?.clientId).toBe("client-alice");
		expect(
			runtimeOAuthConfigurationRevisionV1({ ...bob, revision: "ignored" }),
		).toBe(bob.revision);
		expect(
			runtimeOAuthConfigurationRevisionV1(
				Object.fromEntries(Object.entries(bob).reverse()) as typeof bob,
			),
		).toBe(bob.revision);
	});
	it.each([
		[
			"stale content revision",
			() => ({
				agent: {
					alice: { ...principalConfiguration("alice"), clientId: "different" },
				},
			}),
		],
		[
			"shared client across users",
			() => ({
				agent: {
					alice: principalConfiguration("alice"),
					bob: principalConfiguration("alice"),
				},
			}),
		],
		[
			"shared client across Agents",
			() => ({
				a: { alice: principalConfiguration("alice") },
				b: { alice: principalConfiguration("alice") },
			}),
		],
		[
			"PAT",
			() => {
				const c = {
					...principalConfiguration("alice"),
					patBinding: {
						consumerId: "c",
						bindingEndpoint:
							"https://connection.example.test/api/v1/connection/pat-bindings",
					},
				};
				return {
					agent: {
						alice: { ...c, revision: runtimeOAuthConfigurationRevisionV1(c) },
					},
				};
			},
		],
		[
			"DCR",
			() => {
				const c = {
					...principalConfiguration("alice"),
					clientId: "dcr" as const,
					clientRegistration: "dcr" as const,
					registrationEndpoint:
						"https://connection.example.test/oauth/register",
				};
				return {
					agent: {
						alice: { ...c, revision: runtimeOAuthConfigurationRevisionV1(c) },
					},
				};
			},
		],
		[
			"HTTP callback",
			() => {
				const c = {
					...principalConfiguration("alice"),
					callbackUrl: "http://127.0.0.1:3443/callback",
				};
				return {
					agent: {
						alice: { ...c, revision: runtimeOAuthConfigurationRevisionV1(c) },
					},
				};
			},
		],
		[
			"mixed callback",
			() => {
				const c = {
					...principalConfiguration("bob"),
					callbackUrl: "https://platform.example.test/other",
				};
				return {
					agent: {
						alice: principalConfiguration("alice"),
						bob: { ...c, revision: runtimeOAuthConfigurationRevisionV1(c) },
					},
				};
			},
		],
		[
			"unknown configuration field",
			() => ({
				agent: {
					alice: {
						...principalConfiguration("alice"),
						token: "never-accepted",
					},
				},
			}),
		],
		[
			"invalid user key",
			() => ({ agent: { "": principalConfiguration("alice") } }),
		],
		["array", () => []],
		["null user map", () => ({ agent: null })],
	] as const)("rejects the whole explicit index for %s", (_label, make) => {
		expect(() =>
			parseRuntimeOAuthConfigurationsByAgentAndPrincipalV1(make()),
		).toThrow();
	});
});
