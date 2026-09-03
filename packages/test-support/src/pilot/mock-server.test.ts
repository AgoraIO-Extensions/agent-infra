import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import { pilotFakeScenariosV1 } from "./index.js";
import { createPilotAgentMockServerV1 } from "./mock-server.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);
const secondAgent = AgentProjectionV1Schema.parse({
	...startingAgent,
	agentId: "agent-pilot-2",
});
const cursor = "cursor:agent-pilot-1";

describe("Pilot Agent Mock Server", () => {
	it("routes list pages by the generated client's cursor request", async () => {
		const server = createPilotAgentMockServerV1({
			listAgents: (request) => ({
				status: 200,
				body:
					new URL(request.url).searchParams.get("cursor") === cursor
						? { items: [secondAgent], nextCursor: null }
						: { items: [startingAgent], nextCursor: cursor },
			}),
			getAgent: { status: 200, body: startingAgent },
		});

		const firstPage = await server.fetch(
			new Request("https://platform.example.test/api/v1/agents"),
		);
		const secondPage = await server.fetch(
			new Request(
				`https://platform.example.test/api/v1/agents?cursor=${cursor}`,
			),
		);

		expect(await firstPage.json()).toEqual({
			items: [startingAgent],
			nextCursor: cursor,
		});
		expect(await secondPage.json()).toEqual({
			items: [secondAgent],
			nextCursor: null,
		});
		expect(server.requests.map((request) => request.url)).toEqual([
			"https://platform.example.test/api/v1/agents",
			`https://platform.example.test/api/v1/agents?cursor=${cursor}`,
		]);
	});

	it("rejects invalid contract scenario data before serving a response", () => {
		expect(() =>
			createPilotAgentMockServerV1({
				listAgents: {
					status: 200,
					body: { items: [startingAgent], nextCursor: "" },
				},
				getAgent: { status: 200, body: startingAgent },
			}),
		).toThrow();
		expect(() =>
			createPilotAgentMockServerV1({
				listAgents: { status: 200, body: { items: [], nextCursor: null } },
				getAgent: {
					status: 403,
					body: { schemaVersion: 1, code: "RESOURCE_UNAVAILABLE" },
				},
			}),
		).toThrow();
		expect(() =>
			createPilotAgentMockServerV1({
				listAgents: { status: 200, body: { items: [], nextCursor: null } },
				getAgent: {
					status: 200,
					body: { ...startingAgent, name: "" },
				},
			}),
		).toThrow();
	});
});
