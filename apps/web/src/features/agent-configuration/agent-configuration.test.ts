import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated-v2/client/index.js";
import type { AgentConfigurationUpdateRequestV2Writable } from "../../pilot/generated-v2/types.gen.js";
import {
	loadAgentDefaultRelayKeySavedCandidates,
	updateAgentConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";

const agent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const body = {
	schemaVersion: 2,
	coOwnerIds: ["user-owner-1", "user-owner-2"],
	availability: [{ kind: "organization", organizationId: "organization-1" }],

	secrets: [{ name: "MODEL_API_KEY", value: "replacement-secret" }],
} satisfies AgentConfigurationUpdateRequestV2Writable;

describe("Agent configuration generated-client consumer", () => {
	it("uses the generated configuration and custom image commands", async () => {
		const configuredAgent = AgentProjectionV2Schema.parse({
			...agent,
			configuration: {
				...agent.configuration,
				owners: [
					...agent.configuration.owners,
					{
						userId: "user-owner-2",
						displayName: "Co-owner",
						roles: ["employee"],
					},
				],
			},
		});
		const upgradedAgent = AgentProjectionV2Schema.parse({
			...configuredAgent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:2",
				interactionMode: "platform-adapter",
			},
		});
		const server = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: agent },
			updateAgentConfiguration: { status: 200, body: configuredAgent },
			commandAgentLifecycle: { status: 202, body: upgradedAgent },
		});
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: server.fetch,
		});

		await expect(
			updateAgentConfiguration(
				agent.agentId,
				body,
				"configuration-request-1",
				client,
			),
		).resolves.toEqual(configuredAgent);
		await expect(
			upgradeAgentCustomImage(
				agent.agentId,
				"registry.example/agents/release:2",
				"image-request-1",
				client,
			),
		).resolves.toEqual(upgradedAgent);

		expect(
			server.requests.map((request) => [request.method, request.url]),
		).toEqual([
			[
				"PUT",
				"https://platform.example.test/api/v2/agents/agent-pilot-1/configuration",
			],
			[
				"POST",
				"https://platform.example.test/api/v2/agents/agent-pilot-1/lifecycle",
			],
		]);
		expect(server.requests[0]?.headers.get("Idempotency-Key")).toBe(
			"configuration-request-1",
		);
		expect(await server.requests[0]?.json()).toEqual(body);
		expect(await server.requests[1]?.json()).toEqual({
			schemaVersion: 1,
			command: "upgrade_custom_image",
			imageReference: "registry.example/agents/release:2",
		});
	});

	it("fails closed when configuration response belongs to another Agent", async () => {
		const server = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: agent },
			updateAgentConfiguration: {
				status: 200,
				body: { ...agent, agentId: "agent-other" },
			},
		});

		await expect(
			updateAgentConfiguration(
				agent.agentId,
				body,
				"configuration-request-cross-subject",
				createClient({
					baseUrl: "https://platform.example.test",
					fetch: server.fetch,
				}),
			),
		).rejects.toMatchObject({ retryable: false });
	});

	it("reads saved default-Key candidates through the generated GET client", async () => {
		const candidates = {
			schemaVersion: 2 as const,
			configurationRevision: 8,
			keyVersion: 4,
			candidates: [
				{
					endpointId: "endpoint-primary",
					modelId: "model-a",
					displayName: "受信模型甲",
					reasoningLevels: ["medium", "high"],
				},
			],
		};
		const requests: Request[] = [];
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return Response.json(candidates);
			},
		});

		await expect(
			loadAgentDefaultRelayKeySavedCandidates(agent.agentId, client),
		).resolves.toEqual(candidates);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("GET");
		expect(requests[0]?.url).toBe(
			"https://platform.example.test/api/v2/agents/agent-pilot-1/default-relay-key/display-candidates",
		);
	});

	it.each(["old version", "missing name", "extra field"])(
		"rejects %s on the explicit display endpoint",
		async (mode) => {
			const candidate = {
				endpointId: "endpoint-primary",
				modelId: "model-a",
				displayName: "受信模型甲",
				reasoningLevels: ["medium"],
			};
			const { displayName: _displayName, ...withoutName } = candidate;
			const projection = {
				schemaVersion: mode === "old version" ? 1 : 2,
				configurationRevision: 8,
				keyVersion: 4,
				candidates: [
					mode === "missing name"
						? withoutName
						: mode === "extra field"
							? { ...candidate, credential: "synthetic-sensitive-value" }
							: candidate,
				],
			};
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => Response.json(projection),
			});
			await expect(
				loadAgentDefaultRelayKeySavedCandidates(agent.agentId, client),
			).rejects.toMatchObject({ retryable: false });
		},
	);
});
