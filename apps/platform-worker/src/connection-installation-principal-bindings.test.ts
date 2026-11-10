import type { RuntimeOAuthConfigurationV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createConnectionInstallationPrincipalBindingsV1 } from "./connection-installation-principal-bindings.js";

const configuration: RuntimeOAuthConfigurationV1 = {
	schemaVersion: 1,
	ref: "oauth-a",
	revision: "r1",
	clientId: "client-a",
	issuer: "https://connection.example.test/",
	authorizationEndpoint: "https://connection.example.test/oauth/authorize",
	tokenEndpoint: "https://connection.example.test/oauth/token",
	revocationEndpoint: "https://connection.example.test/oauth/revoke",
	callbackUrl: "https://platform.example.test/connection/callback",
	runtimeOrigin: "https://runtime.example.test:3443/",
	resource: "https://connection.example.test/mcp",
	scope: "mcp",
	configFingerprint: "a".repeat(64),
	source: { ref: "approved-deployment", revision: "r1" },
	patBinding: {
		consumerId: "registered-consumer-a",
		bindingEndpoint:
			"https://connection.example.test/api/v1/connection/pat-bindings",
	},
};
const binding = {
	configuration: { ref: configuration.ref, revision: configuration.revision },
	issuer: configuration.issuer,
	principals: { alice: "connection-alice" },
};
const approval: NonNullable<
	Parameters<
		ReturnType<typeof createConnectionInstallationPrincipalBindingsV1>
	>[0]
> = {
	principal: { kind: "user", id: "alice" },
	reference: {
		agentId: "agent-a",
		conversationId: "conversation-a",
		executionId: "execution-a",
		sessionGeneration: 1,
	},
	scope: {
		agentId: "agent-a",
		sandboxId: "sandbox-a",
		podUid: "pod-a",
		sessionGeneration: 1,
		configFingerprint: configuration.configFingerprint,
		source: configuration.source,
		oauthConfiguration: {
			ref: configuration.ref,
			revision: configuration.revision,
		},
	},
	authorizationId: "authorization-a",
	command: "begin",
	revision: "confirmation-r1",
};
const options = () => ({
	configuration,
	principalBindingsByAgent: { "agent-a": structuredClone(binding) },
});

describe("deployment-approved Connection principal bindings", () => {
	it("adds the original user's exact binding after an approved command", () => {
		const bind = createConnectionInstallationPrincipalBindingsV1(options());
		expect(bind(approval)).toEqual({
			...approval,
			connectionPrincipalId: "connection-alice",
		});
		expect(bind(null)).toBeNull();
	});

	it("does not infer a binding for another user, Agent or application", () => {
		const bind = createConnectionInstallationPrincipalBindingsV1(options());
		expect(
			bind({ ...approval, principal: { kind: "user", id: "bob" } }),
		).toBeNull();
		expect(
			bind({ ...approval, principal: { kind: "user", id: "toString" } }),
		).toBeNull();
		expect(
			bind({ ...approval, principal: { kind: "application", id: "alice" } }),
		).toBeNull();
		expect(
			bind({
				...approval,
				reference: { ...approval.reference, agentId: "agent-b" },
				scope: { ...approval.scope, agentId: "agent-b" },
			}),
		).toBeNull();
		expect(
			bind({ ...approval, scope: { ...approval.scope, agentId: "agent-b" } }),
		).toBeNull();
	});

	it("rejects an old configuration scope and never replaces the confirmation revision", () => {
		const bind = createConnectionInstallationPrincipalBindingsV1(options());
		expect(
			bind({
				...approval,
				scope: {
					...approval.scope,
					oauthConfiguration: { ref: "oauth-a", revision: "old" },
				},
			}),
		).toBeNull();
		expect(bind(approval)?.revision).toBe(approval.revision);
	});

	it("does not supply PAT identity without an explicit deployment binding", () => {
		expect(
			createConnectionInstallationPrincipalBindingsV1({ configuration })(
				approval,
			),
		).toBeNull();
	});

	it("binds an explicitly approved OAuth identity without using a PAT profile", () => {
		const { patBinding: _pat, ...oauth } = configuration;
		const bind = createConnectionInstallationPrincipalBindingsV1({
			configuration: oauth,
			principalBindingsByAgent: { "agent-a": binding },
		});
		expect(bind(approval)?.connectionPrincipalId).toBe("connection-alice");
		expect(
			bind({ ...approval, principal: { kind: "user", id: "bob" } }),
		).toBeNull();
		expect(
			bind({
				...approval,
				reference: { ...approval.reference, agentId: "agent-b" },
			}),
		).toBeNull();
	});

	it("keeps standard OAuth approval unchanged", () => {
		const { patBinding: _pat, ...oauth } = configuration;
		const bind = createConnectionInstallationPrincipalBindingsV1({
			configuration: oauth,
		});
		expect(bind(approval)).toBe(approval);
		expect(bind(null)).toBeNull();
	});

	it("selects per-Agent configuration without a shared fallback", () => {
		const bind = createConnectionInstallationPrincipalBindingsV1({
			configurationsByAgent: { "agent-a": configuration },
			principalBindingsByAgent: { "agent-a": binding },
		});
		expect(bind(approval)?.connectionPrincipalId).toBe("connection-alice");
		expect(
			bind({
				...approval,
				reference: { ...approval.reference, agentId: "agent-b" },
			}),
		).toBeNull();
	});

	it("captures an immutable deployment snapshot", () => {
		const input = options();
		input.configuration = structuredClone(configuration);
		const bind = createConnectionInstallationPrincipalBindingsV1(input);
		input.principalBindingsByAgent["agent-a"].principals.alice = "mutated";
		input.configuration.revision = "changed";
		expect(bind(approval)?.connectionPrincipalId).toBe("connection-alice");
	});

	it.each([
		["malformed map", []],
		["missing fields", { "agent-a": {} }],
		[
			"wrong issuer",
			{ "agent-a": { ...binding, issuer: "https://foreign.example.test/" } },
		],
		[
			"wrong configuration",
			{
				"agent-a": {
					...binding,
					configuration: { ref: "oauth-a", revision: "old" },
				},
			},
		],
		[
			"invalid principal",
			{ "agent-a": { ...binding, principals: { alice: "" } } },
		],
		[
			"shared identity across users",
			{
				"agent-a": {
					...binding,
					principals: { alice: "connection-alice", bob: "connection-alice" },
				},
			},
		],
		[
			"conflicting user across Agents",
			{
				"agent-a": binding,
				"agent-b": { ...binding, principals: { alice: "different-alice" } },
			},
		],
		[
			"conflicting identity across Agents",
			{
				"agent-a": binding,
				"agent-b": { ...binding, principals: { bob: "connection-alice" } },
			},
		],
	])(
		"rejects the whole mapping when %s",
		(_label, principalBindingsByAgent) => {
			expect(() =>
				createConnectionInstallationPrincipalBindingsV1({
					configuration,
					principalBindingsByAgent,
				}),
			).toThrow("CONNECTION_INSTALLATION_UNAVAILABLE");
		},
	);
});
