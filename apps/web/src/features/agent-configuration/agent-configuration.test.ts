import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV1,
	pilotFakeScenariosV1,
} from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated/client/index.js";
import type { AgentConfigurationUpdateRequestV1Writable } from "../../pilot/generated/types.gen.js";
import {
	updateAgentConfiguration,
	upgradeAgentCustomImage,
} from "./agent-configuration.js";

const agent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);
const body = {
	schemaVersion: 1,
	coOwnerIds: ["user-owner-1", "user-owner-2"],
	availability: [{ kind: "organization", organizationId: "organization-1" }],
	actions: [],
	secrets: [{ name: "MODEL_API_KEY", value: "replacement-secret" }],
} satisfies AgentConfigurationUpdateRequestV1Writable;

describe("Agent configuration generated-client consumer", () => {
	it("uses the generated configuration and custom image commands", async () => {
		const configuredAgent = AgentProjectionV1Schema.parse({
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
		const upgradedAgent = AgentProjectionV1Schema.parse({
			...configuredAgent,
			source: {
				kind: "custom",
				imageReference: "registry.example/agents/release:2",
				interactionMode: "platform-adapter",
			},
		});
		const server = createPilotAgentMockServerV1({
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
				"https://platform.example.test/api/v1/agents/agent-pilot-1/configuration",
			],
			[
				"POST",
				"https://platform.example.test/api/v1/agents/agent-pilot-1/lifecycle",
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
		const server = createPilotAgentMockServerV1({
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
});
