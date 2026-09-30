import { describe, expect, it, vi } from "vitest";
import {
	AgentDefaultRelayKeyErrorV1,
	type AgentDefaultRelayKeyStorePortV1,
	agentDefaultRelayKeyAuditIntentV1,
	createAgentDefaultRelayKeyUseCaseV1,
	isAgentDefaultRelayKeyAuthorizedV1,
} from "./agent-default-relay-key.js";

const actor = { userId: "owner-1", accountStatus: "active" as const };
const agentId = "agent-1";
const selection = {
	catalogRevision: "catalog-1",
	options: [
		{
			optionId: "option-1",
			endpointId: "endpoint-1",
			modelId: "model-1",
			reasoningLevels: ["medium"],
		},
	],
	defaultOptionId: "option-1",
	defaultReasoningLevel: "medium",
};
const runtimeOption = {
	modelOptionId: "option-1",
	endpoint: "https://relay.example/v1",
	model: "model-1",
	reasoningLevels: ["medium"],
	protocol: "openai-responses-v1" as const,
	authentication: "bearer" as const,
};
const runtime = {
	schemaVersion: 4 as const,
	configVersion: "runtime-1",
	defaultModelOptionId: "option-1",
	defaultReasoningLevel: "medium",
	modelOptions: [runtimeOption],
};
const current = {
	keyVersion: 1,
	configurationRevision: 7,
	source: {
		kind: "standard" as const,
		templateId: "template-1",
		imageDigest: `sha256:${"a".repeat(64)}`,
		admissionRevision: "admission-1",
		allowedEnvironmentKeys: [],
		allowedSecretKeys: [],
		platformManagedKeys: [],
		connectionEnabled: false,
	},
	runtime,
};

function fixture() {
	const store = {
		current: vi.fn(async () => current),
		replace: vi.fn(async () => 2 as number | null),
		recordRejected: vi.fn(async () => {}),
	} satisfies AgentDefaultRelayKeyStorePortV1;
	const admit = vi.fn(async () => ({
		catalogRevision: "catalog-2",
		runtime: { ...runtime, configVersion: "runtime-2" },
	}));
	return {
		store,
		admit,
		keys: createAgentDefaultRelayKeyUseCaseV1({ store, admit }),
	};
}

describe("Agent default Relay Key Core", () => {
	it("requires a current user API credential and per-Agent manage grant", () => {
		const facts = {
			actorUserId: actor.userId,
			currentUser: {
				userId: actor.userId,
				accountStatus: "active" as const,
				authorizationRevision: "user-revision-1",
			},
			isOwner: true,
			source: current.source,
			runtime,
			api: {
				credentialId: "credential-1",
				identityRevision: "user-revision-1",
			},
			agentAuthorizationRevision: "agent-revision-1",
			credential: {
				principalType: "user",
				principalId: actor.userId,
				scopes: ["agent:manage"],
				expiresAt: null,
				revokedAt: null,
			},
			grant: {
				authorizationRevision: "agent-revision-1",
				revokedAt: null,
			},
		};
		expect(isAgentDefaultRelayKeyAuthorizedV1(facts)).toBe(true);
		for (const denied of [
			{ ...facts, credential: { ...facts.credential, revokedAt: new Date() } },
			{ ...facts, credential: { ...facts.credential, scopes: ["agent:read"] } },
			{ ...facts, grant: { ...facts.grant, revokedAt: new Date() } },
			{ ...facts, agentAuthorizationRevision: "new-revision" },
			{
				...facts,
				currentUser: {
					...facts.currentUser,
					authorizationRevision: "new-revision",
				},
			},
			{ ...facts, isOwner: false },
		]) {
			expect(isAgentDefaultRelayKeyAuthorizedV1(denied)).toBe(false);
		}
		expect(
			isAgentDefaultRelayKeyAuthorizedV1({ ...facts, api: undefined }),
		).toBe(true);
	});

	it("selects non-secret audit outcomes", () => {
		expect(agentDefaultRelayKeyAuditIntentV1({ operation: "current" })).toEqual(
			{
				action: "relay_key.agent_default.read",
				outcome: "succeeded",
			},
		);
		expect(
			agentDefaultRelayKeyAuditIntentV1({
				operation: "replace",
				result: "replaced",
			}),
		).toEqual({
			action: "relay_key.agent_default.replaced",
			outcome: "succeeded",
		});
	});

	it("validates the candidate against the current model choices and replaces by CAS", async () => {
		const { keys, store, admit } = fixture();
		const result = await keys.replace(
			actor,
			agentId,
			{
				expectedVersion: 1,
				keyValue: "replacement-key",
				modelSelection: selection,
			},
			"trace-1",
			"request-1",
		);
		expect(result).toEqual({ schemaVersion: 1, isSet: true, keyVersion: 2 });
		expect(admit).toHaveBeenCalledWith({
			agentId,
			requestId: "request-1",
			traceId: "trace-1",
			source: current.source,
			requested: selection,
			candidateRelayKey: "replacement-key",
		});
		expect(store.replace).toHaveBeenCalledWith({
			agentId,
			actorUserId: actor.userId,
			expectedVersion: 1,
			expectedConfigurationRevision: 7,
			keyValue: "replacement-key",
			traceId: "trace-1",
			requestId: "request-1",
		});
	});

	it("passes API credential authority to both Store checks", async () => {
		const { keys, store } = fixture();
		const apiActor = {
			...actor,
			principal: { kind: "user" as const, id: actor.userId },
			credential: { credentialId: "credential-1" },
			identityRevision: "user-revision-1",
		};
		await keys.replace(
			apiActor,
			agentId,
			{
				expectedVersion: 1,
				keyValue: "replacement-key",
				modelSelection: selection,
			},
			"trace-1",
			"request-1",
		);
		const access = {
			actorUserId: actor.userId,
			api: {
				credentialId: "credential-1",
				identityRevision: "user-revision-1",
			},
		};
		expect(store.current).toHaveBeenCalledWith(expect.objectContaining(access));
		expect(store.replace).toHaveBeenCalledWith(expect.objectContaining(access));
	});

	it.each([
		["query endpoint", { endpoint: "https://relay.example/v1?key=x" }],
		["invalid model ID", { model: "bad model" }],
		["unsupported auth pair", { authentication: "api-key" }],
	])("rejects admitted V4 %s before replacement", async (_name, changed) => {
		const { keys, store, admit } = fixture();
		admit.mockResolvedValueOnce({
			catalogRevision: "catalog-2",
			runtime: {
				...runtime,
				modelOptions: [
					{ ...runtimeOption, ...changed } as typeof runtimeOption,
				],
			},
		});
		await expect(
			keys.replace(
				actor,
				agentId,
				{
					expectedVersion: 1,
					keyValue: "replacement-key",
					modelSelection: selection,
				},
				"trace-1",
				"request-1",
			),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
		expect(store.replace).not.toHaveBeenCalled();
	});

	it("rejects non-Owners, application credentials, stale versions, and changed models", async () => {
		const { keys, store, admit } = fixture();
		await expect(
			keys.current(
				{
					...actor,
					principal: { kind: "application", id: "application-1" },
				},
				agentId,
				"trace-1",
				"request-1",
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		expect(store.current).not.toHaveBeenCalled();
		store.current.mockResolvedValueOnce(null as never);
		await expect(
			keys.current(actor, agentId, "trace-1", "request-1"),
		).rejects.toMatchObject({ code: "not_authorized" });
		await expect(
			keys.replace(
				actor,
				agentId,
				{
					expectedVersion: 3,
					keyValue: "replacement-key",
					modelSelection: selection,
				},
				"trace-1",
				"request-1",
			),
		).rejects.toMatchObject({ code: "conflict" });
		expect(admit).not.toHaveBeenCalled();
		expect(store.recordRejected).toHaveBeenCalledWith({
			agentId,
			actorUserId: actor.userId,
			traceId: "trace-1",
			requestId: "request-1",
			reason: "STALE_VERSION",
			outcome: "rejected",
		});
		admit.mockResolvedValueOnce({
			catalogRevision: "catalog-2",
			runtime: {
				...runtime,
				modelOptions: runtime.modelOptions.map((option) => ({
					...option,
					model: "other-model",
				})),
			},
		});
		await expect(
			keys.replace(
				actor,
				agentId,
				{
					expectedVersion: 1,
					keyValue: "replacement-key",
					modelSelection: selection,
				},
				"trace-1",
				"request-1",
			),
		).rejects.toMatchObject({ code: "invalid_model" });
		expect(store.replace).not.toHaveBeenCalled();
	});

	it("fails closed when admission or persistence is unavailable", async () => {
		const { keys, store, admit } = fixture();
		admit.mockRejectedValueOnce(new Error("private provider detail"));
		await expect(
			keys.replace(
				actor,
				agentId,
				{
					expectedVersion: 1,
					keyValue: "replacement-key",
					modelSelection: selection,
				},
				"trace-1",
				"request-1",
			),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
		store.replace.mockResolvedValueOnce(null);
		await expect(
			keys.replace(
				actor,
				agentId,
				{
					expectedVersion: 1,
					keyValue: "replacement-key",
					modelSelection: selection,
				},
				"trace-1",
				"request-1",
			),
		).rejects.toBeInstanceOf(AgentDefaultRelayKeyErrorV1);
	});
});
