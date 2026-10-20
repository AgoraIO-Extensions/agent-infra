import {
	AgentDetailProjectionV1Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV2,
	pilotAgentDetailFromV2,
	pilotFakeScenariosV2,
} from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated-v2/client/index.js";
import {
	isRetryableAgentDiscoveryError,
	loadAgentDetail,
	loadAgentDetailView,
	loadAgentDiscovery,
} from "./agent-discovery.js";

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
	it.each(["visible", "owner"] as const)(
		"discards prior pages when the %s response contains an invalid projection",
		async (scope) => {
			let requests = 0;
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => {
					requests += 1;
					return Response.json({
						items:
							requests === 1
								? [startingAgent]
								: [
										{
											...secondAgent,
											serviceAvailability: "private-invalid-state",
										},
									],
						nextCursor: requests === 1 ? "agent-pilot-1" : null,
					});
				},
			});
			await expect(loadAgentDiscovery(client, scope)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			});
			expect(requests).toBe(2);
		},
	);

	it.each([
		null,
		{ items: [], nextCursor: 42 },
		{ items: [], nextCursor: null, privateField: "rejected" },
	])(
		"fails closed for a malformed successful collection response %j",
		async (body) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => Response.json(body),
			});
			await expect(loadAgentDiscovery(client)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
				reason: "invalid-response",
			});
		},
	);

	it.each([
		null,
		{ ...startingAgent, serviceAvailability: "private-invalid-state" },
		secondAgent,
	])(
		"rejects invalid or mismatched successful detail without returning its data",
		async (body) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => Response.json(body),
			});
			await expect(
				loadAgentDetail(startingAgent.agentId, client),
			).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
				// P-01：schema 不符或 agentId 不一致单独标为响应无效，页面给「数据无法读取」卡。
				reason: "invalid-response",
			});
		},
	);

	it.each([
		[401, { retryable: false, reason: "authentication-required" }],
		[400, { retryable: false }],
		[405, { retryable: false }],
	] as const)(
		"keeps the HTTP %i detail failure reason for the state card",
		async (status, expected) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					Response.json(
						{
							...pilotFakeScenariosV2.unauthorized.response.body,
							message: "private detail failure",
						},
						{ status },
					),
			});
			await expect(
				loadAgentDetail(startingAgent.agentId, client),
			).resolves.toEqual({ kind: "unavailable", ...expected });
		},
	);

	it.each([429, 500, 503])(
		"rejects a retryable HTTP %i detail failure by status",
		async (status) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () => Response.json({}, { status }),
			});
			await expect(
				loadAgentDetail(startingAgent.agentId, client),
			).rejects.toMatchObject({ retryable: true });
		},
	);

	it("reads the Owner-status detail projection from the detail entry (#2910)", async () => {
		const detail = AgentDetailProjectionV1Schema.parse(
			pilotAgentDetailFromV2(startingAgent, { "user-owner-1": "disabled" }),
		);
		const server = createPilotAgentMockServerV2({
			listAgents: emptyAgentPage,
			getAgent: { status: 200, body: startingAgent },
			getAgentDetail: { status: 200, body: detail },
		});
		await expect(
			loadAgentDetailView(startingAgent.agentId, createAgentClient(server)),
		).resolves.toEqual({ kind: "ready", agent: detail });
		expect(
			server.requests.map((request) => new URL(request.url).pathname),
		).toEqual(["/api/v2/agents/agent-pilot-1/detail"]);
	});

	it.each([
		// 旧 V2 Owner 形状、伪造的未知状态与他人 Agent 都不能当作详情显示。
		startingAgent,
		{
			...pilotAgentDetailFromV2(startingAgent),
			configuration: {
				...pilotAgentDetailFromV2(startingAgent).configuration,
				owners: [
					{ userId: "user-owner-1", displayName: "Owner", status: "valid" },
				],
			},
		},
		pilotAgentDetailFromV2(secondAgent),
	])("rejects an invalid or mismatched Owner-status detail", async (body) => {
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: async () => Response.json(body),
		});
		await expect(
			loadAgentDetailView(startingAgent.agentId, client),
		).resolves.toEqual({
			kind: "unavailable",
			retryable: false,
			reason: "invalid-response",
		});
	});

	it.each([403, 404])(
		"keeps an HTTP %i Owner-status detail indistinguishable from a missing Agent",
		async (status) => {
			const client = createClient({
				baseUrl: "https://platform.example.test",
				fetch: async () =>
					Response.json(pilotFakeScenariosV2.unauthorized.response.body, {
						status,
					}),
			});
			await expect(
				loadAgentDetailView(startingAgent.agentId, client),
			).resolves.toEqual({ kind: "unavailable", retryable: false });
		},
	);

	it("treats unclassified transport errors as retryable", () => {
		expect(isRetryableAgentDiscoveryError(new Error("network failure"))).toBe(
			true,
		);
		expect(
			isRetryableAgentDiscoveryError(
				Object.assign(new Error("forbidden"), { retryable: false }),
			),
		).toBe(false);
	});

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
			retryable: true,
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
			retryable: true,
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
				reason: status === 403 ? "denied" : "not-found",
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
			retryable: true,
		});
	});
});
