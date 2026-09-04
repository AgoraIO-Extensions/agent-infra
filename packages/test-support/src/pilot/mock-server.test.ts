import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
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
const pendingApplication = AgentApplicationProjectionV1Schema.parse({
	schemaVersion: 1,
	applicationId: "application-pilot-1",
	agentId: null,
	name: "Release assistant request",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	status: "pending_approval",
	resourceProfile: {
		profileId: "small",
		displayName: "Small",
		estimatedResources: {
			cpuMillicores: 250,
			memoryMiB: 512,
			storageGiB: 1,
		},
	},
	configuration: {
		owners: [
			{
				userId: "user-applicant-1",
				displayName: "Applicant",
				roles: ["employee"],
			},
		],
		availability: [],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		actions: [],
		environment: [],
		channels: [],
		secrets: [],
	},
	submittedAt: "2026-09-03T08:00:00Z",
	decision: null,
});
const cursor = "cursor:agent-pilot-1";
const applicationInput = {
	schemaVersion: 1,
	name: "Release assistant request",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "codex" },
	coOwnerIds: ["user-co-owner-1"],
	availability: [
		{ kind: "organization" as const, organizationId: "organization-1" },
	],
	modelConfiguration: {
		options: [
			{
				optionId: "model-option-1",
				endpointId: "model-endpoint-1",
				modelId: "gpt-5",
				reasoningLevels: ["medium"],
			},
		],
		defaultOptionId: "model-option-1",
		defaultReasoningLevel: "medium",
	},
	actions: [
		{
			providerId: "provider-1",
			actionId: "action-1",
			actionVersion: "1",
		},
	],
	environment: [{ name: "LOG_LEVEL", value: "info" }],
	secrets: [{ name: "API_TOKEN", value: "test-secret" }],
};

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

	it("routes schema-validated Agent Application operations", async () => {
		const withdrawnApplication = AgentApplicationProjectionV1Schema.parse({
			...pendingApplication,
			status: "withdrawn",
		});
		const server = createPilotAgentMockServerV1({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgent },
			listAgentApplications: {
				status: 200,
				body: { items: [pendingApplication], nextCursor: null },
			},
			getAgentApplication: { status: 200, body: pendingApplication },
			withdrawAgentApplication: { status: 200, body: withdrawnApplication },
		});

		const list = await server.fetch(
			new Request("https://platform.example.test/api/v1/agent-applications"),
		);
		const detail = await server.fetch(
			new Request(
				"https://platform.example.test/api/v1/agent-applications/application-pilot-1",
			),
		);
		const withdrawal = await server.fetch(
			new Request(
				"https://platform.example.test/api/v1/agent-applications/application-pilot-1/withdraw",
				{
					method: "POST",
					headers: { "Idempotency-Key": "withdrawal-request-1" },
				},
			),
		);

		expect(await list.json()).toEqual({
			items: [pendingApplication],
			nextCursor: null,
		});
		expect(await detail.json()).toEqual(pendingApplication);
		expect(await withdrawal.json()).toEqual(withdrawnApplication);
		await expect(
			server.fetch(
				new Request(
					"https://platform.example.test/api/v1/agent-applications/application-pilot-1/withdraw",
					{ method: "POST" },
				),
			),
		).rejects.toThrow();
	});

	it("routes schema-validated Agent Application create and update commands", async () => {
		const updatedApplication = AgentApplicationProjectionV1Schema.parse({
			...pendingApplication,
			name: "Updated release assistant request",
		});
		const server = createPilotAgentMockServerV1({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgent },
			createAgentApplication: { status: 201, body: pendingApplication },
			updateAgentApplication: { status: 200, body: updatedApplication },
		});

		const created = await server.fetch(
			new Request("https://platform.example.test/api/v1/agent-applications", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": "create-request-1",
				},
				body: JSON.stringify(applicationInput),
			}),
		);
		const updated = await server.fetch(
			new Request(
				"https://platform.example.test/api/v1/agent-applications/application-pilot-1",
				{
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": "update-request-1",
					},
					body: JSON.stringify({
						...applicationInput,
						name: "Updated release assistant request",
						secrets: undefined,
					}),
				},
			),
		);

		expect(created.status).toBe(201);
		expect(await created.json()).toEqual(pendingApplication);
		expect(updated.status).toBe(200);
		expect(await updated.json()).toEqual(updatedApplication);
		expect(server.requests).toHaveLength(2);
		expect(await server.requests[0]?.json()).toEqual(applicationInput);
		const updateRequestBody = await server.requests[1]?.json();
		expect(updateRequestBody).toMatchObject({
			name: "Updated release assistant request",
		});
		expect(updateRequestBody).not.toHaveProperty("secrets");

		await expect(
			server.fetch(
				new Request("https://platform.example.test/api/v1/agent-applications", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(applicationInput),
				}),
			),
		).rejects.toThrow();
		await expect(
			server.fetch(
				new Request(
					"https://platform.example.test/api/v1/agent-applications/application-pilot-1",
					{
						method: "PUT",
						headers: { "Idempotency-Key": "update-request-2" },
						body: JSON.stringify({ ...applicationInput, name: "" }),
					},
				),
			),
		).rejects.toThrow();
		await expect(
			server.fetch(
				new Request(
					"https://platform.example.test/api/v1/agent-applications/%E0",
					{
						method: "PUT",
						headers: { "Idempotency-Key": "update-request-3" },
						body: JSON.stringify(applicationInput),
					},
				),
			),
		).rejects.toThrow();
	});

	it("rejects invalid contract scenario data before serving a response", () => {
		const protocolError = pilotFakeScenariosV1.unauthorized.response.body;
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
		expect(() =>
			createPilotAgentMockServerV1({
				listAgents: { status: 201, body: protocolError },
				getAgent: { status: 200, body: startingAgent },
			}),
		).toThrow();
		expect(() =>
			createPilotAgentMockServerV1({
				listAgents: { status: 500, body: protocolError },
				getAgent: { status: 200, body: startingAgent },
			}),
		).toThrow();
		expect(() =>
			createPilotAgentMockServerV1({
				listAgents: { status: 200, body: { items: [], nextCursor: null } },
				getAgent: { status: 200, body: startingAgent },
				withdrawAgentApplication: {
					status: 201,
					body: pendingApplication,
				},
			}),
		).toThrow();
	});

	it("rejects requests that violate the generated Agent operation schemas", async () => {
		const server = createPilotAgentMockServerV1({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgent },
		});

		await expect(
			server.fetch(
				new Request("https://platform.example.test/api/v1/agents?limit=101"),
			),
		).rejects.toThrow();
		await expect(
			server.fetch(
				new Request("https://platform.example.test/api/v1/agents/%E0"),
			),
		).rejects.toThrow();
	});
});
