import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	captureConnectionConsumerRegisteredBindingV1,
	planConnectionConsumerRegistrationV1,
} from "@agent-infra/platform-core";
import { beforeEach, expect, it, vi } from "vitest";
import {
	bindCurrentConnectionInstallationAuthorizationV1,
	resolveRegisteredConnectionConsumerBindingsV1,
} from "./connection-registration-bindings.js";

const mocks = vi.hoisted(() => ({
	registered: vi.fn(),
	close: vi.fn(async () => {}),
	construct: vi.fn(),
}));
vi.mock("@agent-infra/platform-store", () => ({
	readConnectionConsumerSourceSelectionV1: vi.fn(async () => ({
		automaticAgentIds: [],
		legacyAgentIds: [],
	})),
	PostgresConnectionConsumerRegistrationStoreV1: class {
		constructor(input: unknown) {
			mocks.construct(input);
		}
		registered = mocks.registered;
		close = mocks.close;
	},
}));

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "controlled-source",
	revision: "policy-1",
	callbackUrl: "https://platform.test/callback",
	resource: "https://connection.test/mcp",
	scope: "mcp",
};
function registered(agentId: string) {
	const intent = planConnectionConsumerRegistrationV1({
		policy,
		platformAgentId: agentId,
		platformOwnerId: `owner-${agentId}`,
		consumerName: agentId,
	});
	return captureConnectionConsumerRegisteredBindingV1({
		intent,
		receipt: {
			schemaVersion: 1,
			operationId: intent.operationId,
			sourceNamespace: intent.sourceNamespace,
			sourceKey: intent.sourceKey,
			consumerId: `random-consumer-${agentId}`,
			consumerRevision: "2",
			registrationId: `registration-${agentId}`,
			requestDigest: intent.requestDigest,
		},
		associationRevision: 1,
	});
}
const registrations = {
	"agent-a": registered("agent-a"),
	"agent-b": registered("agent-b"),
};
function supplied(agentId: keyof typeof registrations) {
	const binding = registrations[agentId];
	const profile = {
		schemaVersion: 1 as const,
		publicOrigin: "https://connection.test",
		mcpPath: "/mcp",
		consumerId: binding.receipt.consumerId,
		audience: "mcp",
		egressProfile: { ref: "approved-egress", revision: "egress-r1" },
	};
	return {
		profile,
		approval: {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true,
			source: { ...binding.source },
		},
		installationSupply: { ref: `protected-${agentId}`, revision: "r1" },
	};
}
const options = {
	databaseUrl: "postgres://controlled.test/platform",
	policy,
	signal: new AbortController().signal,
};
beforeEach(() => {
	mocks.construct.mockClear();
	mocks.close.mockClear();
	mocks.registered.mockReset().mockResolvedValue(registrations);
});

it("passes durable independent Consumer associations to the real resolver and rechecks after its await", async () => {
	const values = {
		"agent-a": supplied("agent-a"),
		"agent-b": supplied("agent-b"),
	};
	const resolve = vi.fn(async (_signal, bindings) => {
		expect(bindings).toEqual(registrations);
		expect(bindings).not.toBe(registrations);
		return values;
	});
	expect(
		await resolveRegisteredConnectionConsumerBindingsV1({
			...options,
			resolve,
		}),
	).toEqual(values);
	expect(resolve).toHaveBeenCalledOnce();
	expect(mocks.registered).toHaveBeenCalledTimes(2);
	expect(mocks.close).toHaveBeenCalledOnce();
});

it("keeps missing supply default-off without querying or registering anything", async () => {
	expect(await resolveRegisteredConnectionConsumerBindingsV1(options)).toEqual(
		{},
	);
	expect(mocks.construct).not.toHaveBeenCalled();
});

it("does not ask for clients or supply when no verified association exists", async () => {
	mocks.registered.mockResolvedValue({});
	const resolve = vi.fn(async () => ({ "agent-a": supplied("agent-a") }));
	expect(
		await resolveRegisteredConnectionConsumerBindingsV1({
			...options,
			resolve,
		}),
	).toEqual({});
	expect(resolve).not.toHaveBeenCalled();
	expect(mocks.close).toHaveBeenCalledOnce();
});

it.each(["Owner removed", "unknown result", "association revision changed"])(
	"rejects a binding changed during supplier I/O: %s",
	async (reason) => {
		const current = structuredClone(registrations);
		if (reason === "association revision changed") {
			Object.assign(current["agent-a"], {
				associationRevision: 2,
				source: { ...current["agent-a"].source, revision: "2" },
			});
		} else Reflect.deleteProperty(current, "agent-a");
		mocks.registered
			.mockResolvedValueOnce(registrations)
			.mockResolvedValueOnce(current);
		expect(
			await resolveRegisteredConnectionConsumerBindingsV1({
				...options,
				resolve: async () => ({ "agent-a": supplied("agent-a") }),
			}),
		).toEqual({});
	},
);

it.each([
	"other Agent",
	"wrong Consumer",
	"old source",
	"wrong resource",
	"unapproved",
	"Agent-wide client",
])("rejects an unbound supplier entry: %s", async (reason) => {
	const binding = supplied("agent-a");
	const values: Record<string, unknown> = { "agent-a": binding };
	if (reason === "other Agent") {
		delete values["agent-a"];
		values["agent-foreign"] = binding;
	}
	if (reason === "wrong Consumer")
		binding.profile.consumerId = "other-consumer";
	if (reason === "old source") binding.approval.source.revision = "0";
	if (reason === "wrong resource") binding.profile.mcpPath = "/other";
	if (reason === "unapproved") binding.approval.egressEnforced = false;
	if (reason === "Agent-wide client")
		Object.assign(binding, {
			oauthClientBinding: { clientId: "shared-client" },
		});
	if (reason !== "unapproved")
		binding.approval.configFingerprint = connectionConsumerProfileFingerprintV1(
			binding.profile,
		);
	expect(
		await resolveRegisteredConnectionConsumerBindingsV1({
			...options,
			resolve: async () =>
				values as Record<string, ReturnType<typeof supplied>>,
		}),
	).toEqual({});
});

it("closes the reader and never retries a failed supplier", async () => {
	const resolve = vi.fn(async () => {
		throw new Error("controlled unavailable");
	});
	await expect(
		resolveRegisteredConnectionConsumerBindingsV1({ ...options, resolve }),
	).rejects.toThrow("controlled unavailable");
	expect(resolve).toHaveBeenCalledOnce();
	expect(mocks.close).toHaveBeenCalledOnce();
});

it("does not publish late data after cancellation", async () => {
	const controller = new AbortController();
	await expect(
		resolveRegisteredConnectionConsumerBindingsV1({
			...options,
			signal: controller.signal,
			resolve: async () => {
				controller.abort();
				return { "agent-a": supplied("agent-a") };
			},
		}),
	).rejects.toThrow();
	expect(mocks.registered).toHaveBeenCalledOnce();
	expect(mocks.close).toHaveBeenCalledOnce();
});

const installationRequest = {
	principal: { kind: "user" as const, id: "alice" },
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
		configFingerprint: "a".repeat(64),
		source: { ref: "operation-a", revision: "1" },
		oauthConfiguration: { ref: "oauth-a-alice", revision: "r1" },
	},
	authorizationId: "authorization-a",
	command: "begin" as const,
};
const installationApproval = {
	...installationRequest,
	revision: "confirmation-r1",
};

it("requires current Platform authorization around the additional deployment check", async () => {
	const finalCheck = vi.fn(async () => {});
	const bindPrincipal = vi.fn((value) => value);
	const authorize = bindCurrentConnectionInstallationAuthorizationV1({
		current: async (_request, _signal, check) => {
			await check();
			return installationApproval;
		},
		additional: async (_request, _signal, check) => {
			await check();
			return {
				...installationApproval,
				connectionPrincipalId: "connection-alice",
			};
		},
		bindPrincipal,
	});
	expect(
		await authorize(installationRequest, options.signal, finalCheck),
	).toEqual({
		...installationApproval,
		connectionPrincipalId: "connection-alice",
	});
	expect(finalCheck).toHaveBeenCalledTimes(2);
	expect(bindPrincipal).not.toHaveBeenCalled();
});

it.each([
	"current denied",
	"additional denied",
	"additional threw",
	"other user",
	"stale confirmation",
])("does not bypass either authorization boundary: %s", async (reason) => {
	const bindPrincipal = vi.fn((value) => value);
	const additional = vi.fn(async () => {
		if (reason === "additional denied") return null;
		if (reason === "additional threw") throw Error("controlled deny");
		return {
			...installationApproval,
			...(reason === "other user"
				? { principal: { kind: "user" as const, id: "bob" } }
				: {}),
			...(reason === "stale confirmation"
				? { revision: "old-confirmation" }
				: {}),
		};
	});
	const authorize = bindCurrentConnectionInstallationAuthorizationV1({
		current: async (_request, _signal, check) => {
			if (reason === "current denied") return null;
			await check();
			return installationApproval;
		},
		additional,
		bindPrincipal,
	});
	expect(
		await authorize(installationRequest, options.signal, async () => {}),
	).toBeNull();
	expect(bindPrincipal).not.toHaveBeenCalled();
	if (reason === "current denied") expect(additional).not.toHaveBeenCalled();
});

it("does not accept the additional approval if the final Platform recheck failed", async () => {
	const authorize = bindCurrentConnectionInstallationAuthorizationV1({
		current: async (_request, _signal, check) => {
			await check();
			return null;
		},
		additional: async () => installationApproval,
		bindPrincipal: (value) => value,
	});
	expect(
		await authorize(installationRequest, options.signal, async () => {}),
	).toBeNull();
});

it("uses the original trusted principal mapping when no additional authorizer is configured", async () => {
	const bindPrincipal = vi.fn(
		(value) => value && { ...value, connectionPrincipalId: "connection-alice" },
	);
	const authorize = bindCurrentConnectionInstallationAuthorizationV1({
		current: async (_request, _signal, check) => {
			await check();
			return installationApproval;
		},
		bindPrincipal,
	});
	expect(
		await authorize(installationRequest, options.signal, async () => {}),
	).toMatchObject({ connectionPrincipalId: "connection-alice" });
	expect(bindPrincipal).toHaveBeenCalledOnce();
});
