import {
	AgentApplicationProjectionV1Schema,
	AgentCreationFailureProjectionV1Schema,
	AgentDetailProjectionV1Schema,
	AgentProjectionV1Schema,
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
	DeploymentConfigurationProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";

import {
	pilotAgentDetailFromV2,
	pilotFakeScenariosV1,
	pilotFakeScenariosV2,
} from "./index.js";
import {
	createPilotAgentMockServerV1,
	createPilotAgentMockServerV2,
} from "./mock-server.js";

const startingAgent = AgentProjectionV1Schema.parse(
	pilotFakeScenariosV1.starting.response.body,
);
const secondAgent = AgentProjectionV1Schema.parse({
	...startingAgent,
	agentId: "agent-pilot-2",
});
const startingAgentV2 = AgentProjectionV2Schema.parse(
	pilotFakeScenariosV2.starting.response.body,
);
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
	it("routes the v2 deployment configuration endpoint", async () => {
		const deploymentConfiguration =
			DeploymentConfigurationProjectionV2Schema.parse({
				schemaVersion: 2,
				status: "empty",
				templates: [],
				modelCatalog: { status: "empty", revision: null, endpoints: [] },
			});
		const server = createPilotAgentMockServerV2({
			getDeploymentConfiguration: {
				status: 200,
				body: deploymentConfiguration,
			},
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgentV2 },
		});

		const response = await server.fetch(
			new Request(
				"https://platform.example.test/api/v2/deployment/configuration",
			),
		);

		expect(await response.json()).toEqual(deploymentConfiguration);
	});

	it("derives the Agent detail with active Owners from getAgent and validates overrides (#2910)", async () => {
		const derived = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgentV2 },
		});
		const response = await derived.fetch(
			new Request(
				"https://platform.example.test/api/v2/agents/agent-pilot-1/detail",
			),
		);
		expect(response.status).toBe(200);
		const detail = AgentDetailProjectionV1Schema.parse(await response.json());
		expect(detail.configuration.owners).toEqual([
			{ userId: "user-owner-1", displayName: "Owner", status: "active" },
		]);
		const overridden = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgentV2 },
			getAgentDetail: {
				status: 200,
				body: pilotAgentDetailFromV2(startingAgentV2, {
					"user-owner-1": "departed",
				}),
			},
		});
		expect(
			AgentDetailProjectionV1Schema.parse(
				await (
					await overridden.fetch(
						new Request(
							"https://platform.example.test/api/v2/agents/agent-pilot-1/detail",
						),
					)
				).json(),
			).configuration.owners,
		).toEqual([
			{ userId: "user-owner-1", displayName: null, status: "departed" },
		]);
		// V2 Owner 形状不能冒充详情投影。
		expect(() =>
			createPilotAgentMockServerV2({
				listAgents: { status: 200, body: { items: [], nextCursor: null } },
				getAgent: { status: 200, body: startingAgentV2 },
				getAgentDetail: { status: 200, body: startingAgentV2 },
			}),
		).toThrow();
	});

	it("answers the creation failure category as unavailable unless a scenario declares it (#3034)", async () => {
		const fallback = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgentV2 },
		});
		const unavailable = await fallback.fetch(
			new Request(
				"https://platform.example.test/api/v2/agents/agent-pilot-1/creation-failure",
			),
		);
		expect(unavailable.status).toBe(404);
		expect(await unavailable.json()).toMatchObject({
			code: "RESOURCE_UNAVAILABLE",
			retryable: false,
		});
		const declared = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgentV2 },
			getAgentCreationFailure: (_request, agentId) => ({
				status: 200,
				body: {
					schemaVersion: 1,
					agentId,
					category: "configuration_rejected",
				},
			}),
		});
		const response = await declared.fetch(
			new Request(
				"https://platform.example.test/api/v2/agents/agent-pilot-1/creation-failure",
			),
		);
		expect(
			AgentCreationFailureProjectionV1Schema.parse(await response.json()),
		).toEqual({
			schemaVersion: 1,
			agentId: "agent-pilot-1",
			category: "configuration_rejected",
		});
		// 契约之外的类别或字段不能伪装成服务端结果。
		expect(() =>
			createPilotAgentMockServerV2({
				listAgents: { status: 200, body: { items: [], nextCursor: null } },
				getAgent: { status: 200, body: startingAgentV2 },
				getAgentCreationFailure: {
					status: 200,
					body: {
						schemaVersion: 1,
						agentId: "agent-pilot-1",
						category: "kubernetes_policy",
					},
				},
			}),
		).toThrow();
	});

	it("answers the default Relay Key state as not set so Owner pages keep the per-model credential UI (#2421)", async () => {
		const server = createPilotAgentMockServerV2({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: { status: 200, body: startingAgentV2 },
		});
		const response = await server.fetch(
			new Request(
				"https://platform.example.test/api/v2/agents/agent-pilot-1/default-relay-key",
			),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			isSet: false,
			keyVersion: null,
			configurationRevision: 1,
		});
		// 只回答读取；写入默认 Key 的请求仍然不在场景里，必须显式声明。
		await expect(
			server.fetch(
				new Request(
					"https://platform.example.test/api/v2/agents/agent-pilot-1/default-relay-key",
					{ method: "PUT", body: "{}" },
				),
			),
		).rejects.toThrow("does not handle PUT");
	});

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
