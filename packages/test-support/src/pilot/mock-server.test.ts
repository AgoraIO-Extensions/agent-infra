import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
	BrowserSessionProjectionV1Schema,
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
const administratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-administrator-1",
		displayName: "Administrator",
		roles: ["system_admin"],
	},
});

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

	it("routes schema-validated administrator decisions and lifecycle commands", async () => {
		const server = createPilotAgentMockServerV1({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgent },
			getCurrentSession: { status: 200, body: administratorSession },
			listPendingAgentApplications: {
				status: 200,
				body: { items: [pendingApplication], nextCursor: null },
			},
			decideAgentApplication: { status: 200, body: pendingApplication },
			commandAgentLifecycle: { status: 202, body: startingAgent },
		});

		const session = await server.fetch(
			new Request("https://platform.example.test/api/v1/session"),
		);
		const pending = await server.fetch(
			new Request(
				"https://platform.example.test/api/v1/admin/agent-applications",
			),
		);
		const decision = await server.fetch(
			new Request(
				"https://platform.example.test/api/v1/admin/agent-applications/application-pilot-1/decision",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": "application-decision-1",
					},
					body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
				},
			),
		);
		const lifecycle = await server.fetch(
			new Request(
				"https://platform.example.test/api/v1/agents/agent-pilot-1/lifecycle",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": "agent-lifecycle-1",
					},
					body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
				},
			),
		);

		expect(await session.json()).toEqual(administratorSession);
		expect(await pending.json()).toEqual({
			items: [pendingApplication],
			nextCursor: null,
		});
		expect(await decision.json()).toEqual(pendingApplication);
		expect(await lifecycle.json()).toEqual(startingAgent);
		await expect(
			server.fetch(
				new Request(
					"https://platform.example.test/api/v1/agents/agent-pilot-1/lifecycle",
					{
						method: "POST",
						headers: { "Idempotency-Key": "agent-lifecycle-invalid" },
						body: JSON.stringify({ schemaVersion: 1, command: "unknown" }),
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
