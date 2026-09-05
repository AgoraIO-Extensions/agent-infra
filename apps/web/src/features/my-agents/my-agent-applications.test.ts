import { AgentApplicationProjectionV1Schema } from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV1,
	type PilotAgentMockServerScenarioV1,
	pilotFakeScenariosV1,
} from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated/client/index.js";
import type {
	AgentApplicationCreateRequestV1Writable,
	AgentApplicationUpdateRequestV1Writable,
} from "../../pilot/generated/types.gen.js";
import {
	createMyAgentApplication,
	getAgentApplicationEditAction,
	loadMyAgentApplication,
	loadMyAgentApplications,
	updateMyAgentApplication,
	withdrawMyAgentApplication,
} from "./my-agent-applications.js";

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
const creatingApplication = AgentApplicationProjectionV1Schema.parse({
	...pendingApplication,
	applicationId: "application-pilot-2",
	agentId: "agent-pilot-2",
	status: "creating",
});
const withdrawnApplication = AgentApplicationProjectionV1Schema.parse({
	...pendingApplication,
	status: "withdrawn",
});

type ApplicationScenario = Pick<
	PilotAgentMockServerScenarioV1,
	| "createAgentApplication"
	| "getAgentApplication"
	| "listAgentApplications"
	| "updateAgentApplication"
	| "withdrawAgentApplication"
>;

function createApplicationServer(scenario: ApplicationScenario) {
	return createPilotAgentMockServerV1({
		listAgents: { status: 200, body: { items: [], nextCursor: null } },
		getAgent: {
			status: 403,
			body: pilotFakeScenariosV1.unauthorized.response.body,
		},
		...scenario,
	});
}

function createApplicationClient(
	server: ReturnType<typeof createPilotAgentMockServerV1>,
) {
	return createClient({
		baseUrl: "https://platform.example.test",
		fetch: server.fetch,
	});
}

describe("My Agents generated-client consumer", () => {
	it("maps only server-projected editable application states to UI actions", () => {
		expect(getAgentApplicationEditAction(pendingApplication)).toBe("edit");
		expect(
			getAgentApplicationEditAction(
				AgentApplicationProjectionV1Schema.parse({
					...pendingApplication,
					status: "rejected",
					decision: {
						decidedAt: "2026-09-04T00:00:00Z",
						reason: "Capacity unavailable.",
					},
				}),
			),
		).toBe("resubmit");
		expect(
			getAgentApplicationEditAction({
				...pendingApplication,
				status: "withdrawn",
			}),
		).toBeUndefined();
	});

	it("submits create and update commands through generated writable operations", async () => {
		const updatedApplication = AgentApplicationProjectionV1Schema.parse({
			...pendingApplication,
			name: "Updated release assistant request",
		});
		const server = createApplicationServer({
			createAgentApplication: { status: 201, body: pendingApplication },
			updateAgentApplication: { status: 200, body: updatedApplication },
		});
		const client = createApplicationClient(server);
		const createBody = {
			schemaVersion: 1,
			name: pendingApplication.name,
			description: pendingApplication.description,
			source: pendingApplication.source,
			coOwnerIds: [],
			availability: [],
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
			actions: [],
			environment: [],
			secrets: [],
		} satisfies AgentApplicationCreateRequestV1Writable;
		const { secrets: _secrets, ...updateBody } = createBody;

		await expect(
			createMyAgentApplication(createBody, "application-create-1", client),
		).resolves.toEqual(pendingApplication);
		await expect(
			updateMyAgentApplication(
				pendingApplication.applicationId,
				updateBody satisfies AgentApplicationUpdateRequestV1Writable,
				"application-update-1",
				client,
			),
		).resolves.toEqual(updatedApplication);
		expect(
			server.requests.map((request) => [request.method, request.url]),
		).toEqual([
			["POST", "https://platform.example.test/api/v1/agent-applications"],
			[
				"PUT",
				"https://platform.example.test/api/v1/agent-applications/application-pilot-1",
			],
		]);
		expect(server.requests[0]?.headers.get("Idempotency-Key")).toBe(
			"application-create-1",
		);
		expect(server.requests[1]?.headers.get("Idempotency-Key")).toBe(
			"application-update-1",
		);
		await expect(server.requests[0]?.clone().json()).resolves.toEqual(
			createBody,
		);
		await expect(server.requests[1]?.clone().json()).resolves.toEqual(
			updateBody,
		);
	});

	it("fails closed when an update response belongs to another application", async () => {
		const server = createApplicationServer({
			updateAgentApplication: {
				status: 200,
				body: {
					...pendingApplication,
					applicationId: "application-other",
				},
			},
		});
		const { secrets: _secrets, ...updateBody } = {
			schemaVersion: 1,
			name: pendingApplication.name,
			description: pendingApplication.description,
			source: pendingApplication.source,
			coOwnerIds: [],
			availability: [],
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
			actions: [],
			environment: [],
			secrets: [],
		} satisfies AgentApplicationCreateRequestV1Writable;

		await expect(
			updateMyAgentApplication(
				pendingApplication.applicationId,
				updateBody satisfies AgentApplicationUpdateRequestV1Writable,
				"application-update-cross-subject",
				createApplicationClient(server),
			),
		).rejects.toMatchObject({ retryable: false });
	});

	it("uses schema-validated Pilot responses for current applicant list, detail, and withdrawal", async () => {
		const server = createApplicationServer({
			listAgentApplications: {
				status: 200,
				body: { items: [pendingApplication], nextCursor: null },
			},
			getAgentApplication: { status: 200, body: pendingApplication },
			withdrawAgentApplication: { status: 200, body: withdrawnApplication },
		});
		const client = createApplicationClient(server);

		await expect(loadMyAgentApplications(client)).resolves.toEqual({
			kind: "ready",
			applications: [pendingApplication],
		});
		await expect(
			loadMyAgentApplication(pendingApplication.applicationId, client),
		).resolves.toEqual({ kind: "ready", application: pendingApplication });
		await expect(
			withdrawMyAgentApplication(
				pendingApplication.applicationId,
				"withdrawal-request-1",
				client,
			),
		).resolves.toEqual(withdrawnApplication);
		expect(
			server.requests.map((request) => [request.method, request.url]),
		).toEqual([
			["GET", "https://platform.example.test/api/v1/agent-applications"],
			[
				"GET",
				"https://platform.example.test/api/v1/agent-applications/application-pilot-1",
			],
			[
				"POST",
				"https://platform.example.test/api/v1/agent-applications/application-pilot-1/withdraw",
			],
		]);
		expect(server.requests[2]?.headers.get("Idempotency-Key")).toBe(
			"withdrawal-request-1",
		);
	});

	it("consumes the current applicant application projection", async () => {
		const server = createApplicationServer({
			listAgentApplications: {
				status: 200,
				body: {
					items: [pendingApplication],
					nextCursor: null,
				},
			},
		});

		await expect(
			loadMyAgentApplications(createApplicationClient(server)),
		).resolves.toEqual({
			kind: "ready",
			applications: [pendingApplication],
		});
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agent-applications",
		);
	});

	it("loads every current applicant application page", async () => {
		const cursor = "application-pilot-1";
		const server = createApplicationServer({
			listAgentApplications: (request) =>
				new URL(request.url).searchParams.get("cursor") === cursor
					? {
							status: 200,
							body: {
								items: [creatingApplication],
								nextCursor: null,
							},
						}
					: {
							status: 200,
							body: {
								items: [pendingApplication],
								nextCursor: cursor,
							},
						},
		});

		await expect(
			loadMyAgentApplications(createApplicationClient(server)),
		).resolves.toEqual({
			kind: "ready",
			applications: [pendingApplication, creatingApplication],
		});
		expect(server.requests.map((request) => request.url)).toEqual([
			"https://platform.example.test/api/v1/agent-applications",
			"https://platform.example.test/api/v1/agent-applications?cursor=application-pilot-1",
		]);
	});

	it("fails closed when a current applicant cursor repeats", async () => {
		const cursor = "application-pilot-1";
		let requests = 0;
		const server = createApplicationServer({
			listAgentApplications: () => {
				requests += 1;
				if (requests > 2) throw new Error("unexpected extra page request");
				return {
					status: 200,
					body: { items: [pendingApplication], nextCursor: cursor },
				};
			},
		});

		await expect(
			loadMyAgentApplications(createApplicationClient(server)),
		).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
		});
		expect(requests).toBe(2);
	});

	it("bounds a unique current applicant cursor chain", async () => {
		let requests = 0;
		const server = createApplicationServer({
			listAgentApplications: () => {
				requests += 1;
				return {
					status: 200,
					body: { items: [], nextCursor: `cursor-${requests}` },
				};
			},
		});

		await expect(
			loadMyAgentApplications(createApplicationClient(server)),
		).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
		});
		expect(requests).toBe(100);
	});

	it("keeps unavailable current applicant history opaque", async () => {
		for (const status of [403, 404]) {
			const server = createApplicationServer({
				listAgentApplications: {
					status,
					body: {
						...pilotFakeScenariosV1.unauthorized.response.body,
						message: "private authorization detail",
					},
				},
			});

			await expect(
				loadMyAgentApplications(createApplicationClient(server)),
			).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
			});
		}
	});

	it("surfaces a retryable current applicant history failure", async () => {
		const server = createApplicationServer({
			listAgentApplications: {
				status: pilotFakeScenariosV1.unavailable.response.status,
				body: pilotFakeScenariosV1.unavailable.response.body,
			},
		});

		await expect(
			loadMyAgentApplications(createApplicationClient(server)),
		).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
		});
	});

	it("consumes a current applicant application detail", async () => {
		const server = createApplicationServer({
			getAgentApplication: { status: 200, body: pendingApplication },
		});

		await expect(
			loadMyAgentApplication(
				"application:tenant/01?draft#one%",
				createApplicationClient(server),
			),
		).resolves.toEqual({ kind: "ready", application: pendingApplication });
		expect(server.requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agent-applications/application%3Atenant%2F01%3Fdraft%23one%25",
		);
	});

	it("keeps missing and forbidden application details equally opaque", async () => {
		for (const status of [403, 404]) {
			const server = createApplicationServer({
				getAgentApplication: {
					status,
					body: {
						...pilotFakeScenariosV1.unauthorized.response.body,
						message: "private application detail",
					},
				},
			});

			await expect(
				loadMyAgentApplication(
					"application-pilot-1",
					createApplicationClient(server),
				),
			).resolves.toEqual({ kind: "unavailable", retryable: false });
		}
	});

	it("withdraws a pending current applicant application through the generated client", async () => {
		const server = createApplicationServer({
			withdrawAgentApplication: { status: 200, body: withdrawnApplication },
		});

		await expect(
			withdrawMyAgentApplication(
				"application:tenant/01?draft#one%",
				"withdrawal-request-1",
				createApplicationClient(server),
			),
		).resolves.toEqual(withdrawnApplication);
		expect(server.requests[0]?.method).toBe("POST");
		expect(server.requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agent-applications/application%3Atenant%2F01%3Fdraft%23one%25/withdraw",
		);
		expect(server.requests[0]?.headers.get("Idempotency-Key")).toBe(
			"withdrawal-request-1",
		);
	});

	it("keeps terminal withdrawal failures opaque and non-retryable", async () => {
		for (const status of [403, 404, 409]) {
			const server = createApplicationServer({
				withdrawAgentApplication: {
					status,
					body: {
						...pilotFakeScenariosV1.unauthorized.response.body,
						message: "private authorization detail",
					},
				},
			});

			await expect(
				withdrawMyAgentApplication(
					"application-pilot-1",
					"withdrawal-request-1",
					createApplicationClient(server),
				),
			).rejects.toMatchObject({
				message: "My Agent data is temporarily unavailable",
				retryable: false,
			});
		}
	});

	it("keeps retryable withdrawal outages retryable without exposing details", async () => {
		const server = createApplicationServer({
			withdrawAgentApplication: {
				status: 503,
				body: {
					...pilotFakeScenariosV1.unavailable.response.body,
					message: "private upstream detail",
				},
			},
		});

		await expect(
			withdrawMyAgentApplication(
				"application-pilot-1",
				"withdrawal-request-1",
				createApplicationClient(server),
			),
		).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
			retryable: true,
		});
	});
});
