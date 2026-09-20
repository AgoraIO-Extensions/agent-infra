import { AgentProjectionV2Schema } from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated-v2/client/index.js";
import { loadAgentDetail, loadAgentDiscovery } from "./agent-discovery.js";

const startingAgent = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
const secondAgent = AgentProjectionV2Schema.parse({
	...startingAgent,
	agentId: "agent-pilot-2",
});
const emptyAgentPage = { status: 200, body: { items: [], nextCursor: null } };

function createAgentClient(
	server: ReturnType<typeof createPilotAgentMockServerV2>,
) {
	return createClient({
		baseUrl: "https://platform.example.test",
		fetch: server.fetch,
	});
}

describe("Agent discovery generated-client consumer", () => {
	it("consumes the generated visible-Agent list and preserves its projection", async () => {
		const server = createPilotAgentMockServerV2({
			listAgents: {
				status: 200,
				body: { items: [startingAgent], nextCursor: null },
			},
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			loadAgentDiscovery(createAgentClient(server)),
		).resolves.toEqual({
			kind: "ready",
			agents: [startingAgent],
		});
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.url).toBe(
			"https://platform.example.test/api/v2/agents",
		);
	});

	it("requests the server-owned Agent projection for the management view", async () => {
		const server = createPilotAgentMockServerV2({
			listAgents: {
				status: 200,
				body: { items: [startingAgent], nextCursor: null },
			},
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			loadAgentDiscovery(createAgentClient(server), "owner"),
		).resolves.toEqual({
			kind: "ready",
			agents: [startingAgent],
		});
		expect(server.requests[0]?.url).toBe(
			"https://platform.example.test/api/v2/agents?scope=owner",
		);
	});

	it("aggregates every visible-Agent page from the generated client", async () => {
		const cursor = "agent-pilot-1";
		const server = createPilotAgentMockServerV2({
			listAgents: (request) =>
				new URL(request.url).searchParams.get("cursor") === cursor
					? { status: 200, body: { items: [secondAgent], nextCursor: null } }
					: {
							status: 200,
							body: { items: [startingAgent], nextCursor: cursor },
						},
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			loadAgentDiscovery(createAgentClient(server)),
		).resolves.toEqual({
			kind: "ready",
			agents: [startingAgent, secondAgent],
		});
	});

	it("fails closed when a visible-Agent cursor repeats", async () => {
		const cursor = "agent-pilot-1";
		const server = createPilotAgentMockServerV2({
			listAgents: {
				status: 200,
				body: { items: [startingAgent], nextCursor: cursor },
			},
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			loadAgentDiscovery(createAgentClient(server)),
		).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
		expect(server.requests).toHaveLength(2);
	});

	it("bounds a unique visible-Agent cursor chain", async () => {
		let requests = 0;
		const server = createPilotAgentMockServerV2({
			listAgents: () => {
				requests += 1;
				return {
					status: 200,
					body: { items: [], nextCursor: `cursor-${requests}` },
				};
			},
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			loadAgentDiscovery(createAgentClient(server)),
		).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
		expect(requests).toBe(100);
	});

	it("keeps non-retryable visible-Agent failures opaque", async () => {
		for (const status of [403, 404]) {
			const server = createPilotAgentMockServerV2({
				listAgents: {
					status,
					body: pilotFakeScenariosV2.unauthorized.response.body,
				},
				getAgent: { status: 200, body: startingAgent },
			});

			await expect(
				loadAgentDiscovery(createAgentClient(server)),
			).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
			});
		}
	});

	it("rejects retryable generated-client list failures without exposing details", async () => {
		const server = createPilotAgentMockServerV2({
			listAgents: {
				status: 503,
				body: {
					...pilotFakeScenariosV2.unavailable.response.body,
					message: "private upstream detail",
				},
			},
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			loadAgentDiscovery(createAgentClient(server)),
		).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
	});

	it("keeps missing and forbidden detail responses equally opaque", async () => {
		for (const status of [403, 404]) {
			const server = createPilotAgentMockServerV2({
				listAgents: emptyAgentPage,
				getAgent: {
					status,
					body: pilotFakeScenariosV2.unauthorized.response.body,
				},
			});

			await expect(
				loadAgentDetail("agent-pilot-1", createAgentClient(server)),
			).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
			});
		}
	});

	it("rejects retryable generated-client detail failures without exposing details", async () => {
		const server = createPilotAgentMockServerV2({
			listAgents: emptyAgentPage,
			getAgent: {
				status: 503,
				body: {
					...pilotFakeScenariosV2.unavailable.response.body,
					message: "private upstream detail",
				},
			},
		});

		await expect(
			loadAgentDetail("agent-pilot-1", createAgentClient(server)),
		).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
	});
});
