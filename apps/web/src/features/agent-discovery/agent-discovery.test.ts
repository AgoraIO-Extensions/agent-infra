import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated/client/index.js";
import { loadAgentDetail, loadAgentDiscovery } from "./agent-discovery.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);

describe("Agent discovery generated-client consumer", () => {
	it("consumes the generated visible-Agent list and preserves its projection", async () => {
		const requests: Request[] = [];
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input) => {
				const request = new Request(input);
				requests.push(request);
				return new Response(
					JSON.stringify({ items: [startingAgent], nextCursor: null }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		await expect(loadAgentDiscovery(client)).resolves.toEqual({
			kind: "ready",
			agents: [startingAgent],
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agents",
		);
	});

	it("keeps missing and forbidden detail responses equally opaque", async () => {
		for (const status of [403, 404]) {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					new Response(
						JSON.stringify(pilotFakeScenariosV1.unauthorized.response.body),
						{
							status,
							headers: { "Content-Type": "application/json" },
						},
					),
			});

			await expect(loadAgentDetail("agent-pilot-1", client)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
			});
		}
	});
});
