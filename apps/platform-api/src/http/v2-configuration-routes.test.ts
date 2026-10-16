import {
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { AgentConfigurationError } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";

import { createPlatformHealthApp } from "../app.js";
import { registerV2ConfigurationRoutes } from "./v2-configuration-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

const agentProjection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	managementStatus: "available" as const,
	serviceAvailability: "ready" as const,
	configuration: {
		owners: [
			{ userId: "user-1", displayName: "Ada", roles: ["employee" as const] },
		],
		availability: [{ kind: "organization" as const, organizationId: "org-1" }],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		actions: [],
		environment: [],
		channels: [{ kind: "web" as const, status: "available" as const }],
		secrets: [],
	},
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
};

function createApp(savedKeyCandidates?: {
	read: (...args: never[]) => Promise<unknown>;
}) {
	const app = createPlatformHealthApp();
	const update = vi.fn().mockResolvedValue({});
	const read = vi.fn().mockResolvedValue({
		outcome: "found",
		configuration: { revision: 7 },
	});
	const readAgentProjection = vi.fn().mockResolvedValue(agentProjection);

	registerV2ConfigurationRoutes(app, {
		identity: {
			resolve: vi.fn().mockResolvedValue(identity),
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		configuration: { update },
		configurationQuery: { read },
		readAgentProjection,
		prepareSecretReplacements: vi.fn().mockResolvedValue({
			secrets: [],
			modelCredentialOptionIds: [],
		}),
		...(savedKeyCandidates ? { savedKeyCandidates } : {}),
	});

	return { app, update, read, readAgentProjection };
}

describe("V2 configuration routes", () => {
	it("updates through the V2 Core command and returns an action-free projection", async () => {
		const { app, update, readAgentProjection } = createApp();
		const response = await app.request("/api/v2/agents/agent-1/configuration", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "Command.Aa-02",
			},
			body: JSON.stringify({
				schemaVersion: 2,
				environment: [{ name: "MODE", value: "safe" }],
			}),
		});

		expect(response.status).toBe(200);
		const projection = AgentProjectionV2Schema.parse(await response.json());
		expect(projection.schemaVersion).toBe(2);
		expect(projection.configuration).not.toHaveProperty("actions");
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ schemaVersion: 2, agentId: "agent-1" }),
			expect.objectContaining({ actorId: "user-1" }),
			undefined,
		);
		expect(readAgentProjection).toHaveBeenCalledOnce();
	});

	it("rejects the retired actions field before touching Core", async () => {
		const { app, update } = createApp();
		const response = await app.request("/api/v2/agents/agent-1/configuration", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "Command.Aa-03",
			},
			body: JSON.stringify({ schemaVersion: 2, actions: [] }),
		});

		expect(response.status).toBe(400);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"INVALID_REQUEST",
		);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("V2 configuration routes with a re-submitted default Relay Key (#2421)", () => {
	const key = "SYNTHETIC_ROUTE_KEY_000000001";
	const modelConfiguration = {
		options: [
			{
				optionId: "ep:gpt-5",
				endpointId: "ep",
				modelId: "gpt-5",
				reasoningLevels: ["high", "medium"],
			},
		],
		defaultOptionId: "ep:gpt-5",
		defaultReasoningLevel: "medium",
	};
	const replacement = {
		schemaVersion: 2,
		defaultRelayKey: key,
		expectedConfigurationRevision: 7,
		expectedKeyVersion: 2,
		modelConfiguration,
	};
	const put = (
		app: ReturnType<typeof createApp>["app"],
		payload: unknown,
		path = "/api/v2/agents/agent-1/configuration",
	) =>
		app.request(path, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "Command.Aa-04",
			},
			body: JSON.stringify(payload),
		});

	it("sends the V3 Core command with the Key, expected versions and credential-free models", async () => {
		const { app, update } = createApp();
		const response = await put(app, {
			...replacement,
			availability: [{ kind: "organization", organizationId: "org-1" }],
		});
		expect(response.status).toBe(200);
		// 响应是不含 Key 的 Agent 投影。
		expect(await response.text()).not.toContain(key);
		expect(update).toHaveBeenCalledWith(
			{
				schemaVersion: 3,
				agentId: "agent-1",
				idempotencyKey: "Command.Aa-04",
				requestId: expect.any(String),
				traceId: expect.any(String),
				defaultRelayKey: key,
				expectedConfigurationRevision: 7,
				expectedKeyVersion: 2,
				changes: {
					availability: [{ kind: "organization", organizationId: "org-1" }],
					modelConfiguration,
				},
			},
			expect.objectContaining({ actorId: "user-1" }),
			undefined,
		);
	});

	it("accepts a null expected Key version for an Agent without a Key version yet", async () => {
		const { app, update } = createApp();
		const response = await put(app, {
			...replacement,
			expectedKeyVersion: null,
		});
		expect(response.status).toBe(200);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ schemaVersion: 3, expectedKeyVersion: null }),
			expect.anything(),
			undefined,
		);
	});

	it.each([
		[
			"a Key without the expected versions",
			{
				expectedConfigurationRevision: undefined,
				expectedKeyVersion: undefined,
			},
		],
		[
			"a Key without the expected Key version",
			{ expectedKeyVersion: undefined },
		],
		[
			"a Key without the expected configuration revision",
			{ expectedConfigurationRevision: undefined },
		],
		["a Key without a model selection", { modelConfiguration: undefined }],
		[
			"a Key together with per-model credentials",
			{
				modelConfiguration: {
					...modelConfiguration,
					options: [
						{ ...modelConfiguration.options[0], credentialValue: "per-model" },
					],
				},
			},
		],
		["expected versions without a Key", { defaultRelayKey: undefined }],
	])("rejects %s before touching Core", async (_label, override) => {
		const { app, update } = createApp();
		const response = await put(app, { ...replacement, ...override });
		expect(response.status).toBe(400);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"INVALID_REQUEST",
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("reports an unavailable saved-Key reader when no Key is submitted", async () => {
		const { app, update } = createApp();
		const response = await put(
			app,
			{ ...replacement, defaultRelayKey: undefined },
			"/api/v2/agents/agent-1/configuration/saved-model",
		);
		expect(response.status).toBe(503);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"DEPENDENCY_UNAVAILABLE",
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("keeps V2-shaped model changes on the V2 command so Core can refuse them for keyless Agents", async () => {
		const { app, update } = createApp();
		await put(app, { schemaVersion: 2, modelConfiguration });
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ schemaVersion: 2 }),
			expect.anything(),
			undefined,
		);
	});

	it.each([
		["key_version_conflict"],
		["stale_revision"],
		["not_admitted"],
	] as const)(
		"answers a %s failure with 409 and never echoes the Key",
		async (code) => {
			const { app, update } = createApp();
			update.mockRejectedValueOnce(new AgentConfigurationError(code));
			const response = await put(app, replacement);
			expect(response.status).toBe(409);
			const text = await response.text();
			expect(JSON.parse(text)).toMatchObject({
				code: "INVALID_REQUEST",
				message: "Request conflicts with current state.",
				retryable: false,
			});
			expect(text).not.toContain(key);
		},
	);

	it("rejects a saved response bound to another Agent", async () => {
		const savedKeyCandidates = {
			read: vi.fn().mockResolvedValue({
				schemaVersion: 1,
				agentId: "agent-2",
				configurationRevision: 7,
				keyVersion: 2,
				candidates: [
					{
						endpointId: "ep",
						modelId: "gpt-5",
						reasoningLevels: ["high", "medium"],
					},
				],
			}),
		};
		const { app, update } = createApp(savedKeyCandidates);
		const response = await app.request(
			"/api/v2/agents/agent-1/configuration/saved-model",
			{
				method: "PUT",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "Command.Aa-05",
				},
				body: JSON.stringify({ ...replacement, defaultRelayKey: undefined }),
			},
		);
		expect(response.status).toBe(400);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"INVALID_REQUEST",
		);
		expect(update).not.toHaveBeenCalled();
	});
});
