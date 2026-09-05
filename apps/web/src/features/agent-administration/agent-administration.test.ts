import {
	AgentProjectionV1Schema,
	BrowserSessionProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createPilotAgentMockServerV1,
	type PilotAgentMockServerScenarioV1,
} from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated/client/index.js";
import { pendingApplication } from "../my-agents/test-fixtures.js";
import {
	commandAgentLifecycle,
	decideAgentApplication,
	loadBrowserSession,
	loadPendingAgentApplications,
} from "./agent-administration.js";

const approvedApplication = {
	...pendingApplication,
	agentId: "agent-pilot-1",
	status: "creating" as const,
	decision: {
		decidedAt: "2026-09-04T08:00:00Z",
		reason: null,
	},
};
const restartingAgent = AgentProjectionV1Schema.parse({
	schemaVersion: 1,
	agentId: "agent-pilot-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard", templateId: "codex" },
	managementStatus: "available",
	serviceAvailability: "starting",
	configuration: pendingApplication.configuration,
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
});
const administratorSession = BrowserSessionProjectionV1Schema.parse({
	schemaVersion: 1,
	user: {
		userId: "user-admin-1",
		displayName: "Administrator",
		roles: ["employee", "system_admin"],
	},
});

describe("Agent administration generated-client consumer", () => {
	it("uses schema-validated commands for approval and the matching Agent lifecycle", async () => {
		const scenario: PilotAgentMockServerScenarioV1 = {
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: {
				status: 403,
				body: {
					schemaVersion: 1,
					code: "RESOURCE_UNAVAILABLE",
					message: "Unavailable",
					retryable: false,
					traceId: "trace-agent-administration",
				},
			},
			getCurrentSession: { status: 200, body: administratorSession },
			listPendingAgentApplications: {
				status: 200,
				body: { items: [pendingApplication], nextCursor: null },
			},
			decideAgentApplication: { status: 200, body: approvedApplication },
			commandAgentLifecycle: { status: 202, body: restartingAgent },
		};
		const server = createPilotAgentMockServerV1(scenario);
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: server.fetch,
		});

		await expect(loadBrowserSession(client)).resolves.toEqual({
			kind: "ready",
			session: administratorSession,
		});
		await expect(loadPendingAgentApplications(client)).resolves.toEqual({
			kind: "ready",
			applications: [pendingApplication],
		});
		await expect(
			decideAgentApplication(
				pendingApplication.applicationId,
				{ decision: "approve" },
				"approval-request-1",
				client,
			),
		).resolves.toEqual(approvedApplication);
		await expect(
			commandAgentLifecycle(
				restartingAgent.agentId,
				"restart",
				"lifecycle-request-1",
				client,
			),
		).resolves.toEqual(restartingAgent);
		expect(
			server.requests.map((request) => [request.method, request.url]),
		).toEqual([
			["GET", "https://platform.example.test/api/v1/session"],
			["GET", "https://platform.example.test/api/v1/admin/agent-applications"],
			[
				"POST",
				"https://platform.example.test/api/v1/admin/agent-applications/application%3Atenant%2F01%3Fdraft%23one%25/decision",
			],
			[
				"POST",
				"https://platform.example.test/api/v1/agents/agent-pilot-1/lifecycle",
			],
		]);
		expect(server.requests[2]?.headers.get("Idempotency-Key")).toBe(
			"approval-request-1",
		);
		expect(server.requests[3]?.headers.get("Idempotency-Key")).toBe(
			"lifecycle-request-1",
		);
	});

	it("fails closed when a generated command response belongs to another application or Agent", async () => {
		const server = createPilotAgentMockServerV1({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: {
				status: 403,
				body: {
					schemaVersion: 1,
					code: "RESOURCE_UNAVAILABLE",
					message: "Unavailable",
					retryable: false,
					traceId: "trace-agent-administration-cross-subject",
				},
			},
			decideAgentApplication: {
				status: 200,
				body: { ...approvedApplication, applicationId: "application-other" },
			},
			commandAgentLifecycle: {
				status: 202,
				body: { ...restartingAgent, agentId: "agent-other" },
			},
		});
		const client = createClient({
			baseUrl: "https://platform.example.test",
			fetch: server.fetch,
		});

		await expect(
			decideAgentApplication(
				pendingApplication.applicationId,
				{ decision: "approve" },
				"approval-cross-subject-1",
				client,
			),
		).rejects.toMatchObject({ retryable: false });
		await expect(
			commandAgentLifecycle(
				restartingAgent.agentId,
				"restart",
				"lifecycle-cross-subject-1",
				client,
			),
		).rejects.toMatchObject({ retryable: false });
	});

	it("keeps a non-retryable browser session failure opaque", async () => {
		const server = createPilotAgentMockServerV1({
			listAgents: { status: 200, body: { items: [], nextCursor: null } },
			getAgent: {
				status: 403,
				body: {
					schemaVersion: 1,
					code: "RESOURCE_UNAVAILABLE",
					message: "private authorization detail",
					retryable: false,
					traceId: "trace-session-unavailable",
				},
			},
			getCurrentSession: {
				status: 403,
				body: {
					schemaVersion: 1,
					code: "RESOURCE_UNAVAILABLE",
					message: "private authorization detail",
					retryable: false,
					traceId: "trace-session-unavailable",
				},
			},
		});

		await expect(
			loadBrowserSession(
				createClient({
					baseUrl: "https://platform.example.test",
					fetch: server.fetch,
				}),
			),
		).resolves.toEqual({ kind: "unavailable", retryable: false });
	});
});
