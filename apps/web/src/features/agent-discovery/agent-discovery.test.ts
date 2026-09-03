import { AgentProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated/client/index.js";
import { loadAgentDetail, loadAgentDiscovery } from "./agent-discovery.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);
const secondAgent = AgentProjectionV1Schema.parse({
	...startingAgent,
	agentId: "agent-pilot-2",
});

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

	it("aggregates every visible-Agent page from the generated client", async () => {
		const cursor = "agent-pilot-1";
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input) => {
				const request = new Request(input);
				const isSecondPage =
					new URL(request.url).searchParams.get("cursor") === cursor;
				return new Response(
					JSON.stringify(
						isSecondPage
							? { items: [secondAgent], nextCursor: null }
							: { items: [startingAgent], nextCursor: cursor },
					),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		await expect(loadAgentDiscovery(client)).resolves.toEqual({
			kind: "ready",
			agents: [startingAgent, secondAgent],
		});
	});

	it("fails closed when a visible-Agent cursor repeats", async () => {
		const cursor = "agent-pilot-1";
		const requests: Request[] = [];
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async (input) => {
				requests.push(new Request(input));
				return new Response(
					JSON.stringify({ items: [startingAgent], nextCursor: cursor }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		await expect(loadAgentDiscovery(client)).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
		expect(requests).toHaveLength(2);
	});

	it("bounds a unique visible-Agent cursor chain", async () => {
		let requests = 0;
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => {
				requests += 1;
				return new Response(
					JSON.stringify({
						items: [],
						nextCursor: `cursor-${requests}`,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			},
		});

		await expect(loadAgentDiscovery(client)).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
		expect(requests).toBe(100);
	});

	it("keeps non-retryable visible-Agent failures opaque", async () => {
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

			await expect(loadAgentDiscovery(client)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
			});
		}
	});

	it("rejects retryable generated-client list failures without exposing details", async () => {
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () =>
				new Response(
					JSON.stringify({
						...pilotFakeScenariosV1.unavailable.response.body,
						message: "private upstream detail",
					}),
					{
						status: 503,
						headers: { "Content-Type": "application/json" },
					},
				),
		});

		await expect(loadAgentDiscovery(client)).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
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

	it("rejects retryable generated-client detail failures without exposing details", async () => {
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () =>
				new Response(
					JSON.stringify({
						...pilotFakeScenariosV1.unavailable.response.body,
						message: "private upstream detail",
					}),
					{
						status: 503,
						headers: { "Content-Type": "application/json" },
					},
				),
		});

		await expect(
			loadAgentDetail("agent-pilot-1", client),
		).rejects.toMatchObject({
			message: "Agent data is temporarily unavailable",
		});
	});
});
