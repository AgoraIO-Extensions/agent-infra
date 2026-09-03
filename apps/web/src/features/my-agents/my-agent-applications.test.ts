import { AgentApplicationProjectionV1Schema } from "@agent-infra/contracts/pilot";
import { pilotFakeScenariosV1 } from "@agent-infra/test-support/pilot";
import { describe, expect, it } from "vitest";

import { createClient } from "../../pilot/generated/client/index.js";
import {
	loadMyAgentApplication,
	loadMyAgentApplications,
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

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createApplicationClient(fetchImplementation: typeof fetch) {
	return createClient({
		baseUrl: "https://platform.example.test",
		fetch: fetchImplementation,
	});
}

describe("My Agents generated-client consumer", () => {
	it("consumes the current applicant application projection", async () => {
		const requests: Request[] = [];
		const client = createApplicationClient(async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return jsonResponse(200, {
				items: [pendingApplication],
				nextCursor: null,
			});
		});

		await expect(loadMyAgentApplications(client)).resolves.toEqual({
			kind: "ready",
			applications: [pendingApplication],
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agent-applications",
		);
	});

	it("loads every current applicant application page", async () => {
		const cursor = "application-pilot-1";
		const requests: Request[] = [];
		const client = createApplicationClient(async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return new URL(request.url).searchParams.get("cursor") === cursor
				? jsonResponse(200, {
						items: [creatingApplication],
						nextCursor: null,
					})
				: jsonResponse(200, {
						items: [pendingApplication],
						nextCursor: cursor,
					});
		});

		await expect(loadMyAgentApplications(client)).resolves.toEqual({
			kind: "ready",
			applications: [pendingApplication, creatingApplication],
		});
		expect(requests.map((request) => request.url)).toEqual([
			"https://platform.example.test/api/v1/agent-applications",
			"https://platform.example.test/api/v1/agent-applications?cursor=application-pilot-1",
		]);
	});

	it("fails closed when a current applicant cursor repeats", async () => {
		const cursor = "application-pilot-1";
		let requests = 0;
		const client = createApplicationClient(async () => {
			requests += 1;
			if (requests > 2) throw new Error("unexpected extra page request");
			return jsonResponse(200, {
				items: [pendingApplication],
				nextCursor: cursor,
			});
		});

		await expect(loadMyAgentApplications(client)).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
		});
		expect(requests).toBe(2);
	});

	it("bounds a unique current applicant cursor chain", async () => {
		let requests = 0;
		const client = createApplicationClient(async () => {
			requests += 1;
			return jsonResponse(200, {
				items: [],
				nextCursor: `cursor-${requests}`,
			});
		});

		await expect(loadMyAgentApplications(client)).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
		});
		expect(requests).toBe(100);
	});

	it("keeps unavailable current applicant history opaque", async () => {
		for (const status of [403, 404]) {
			const client = createApplicationClient(async () =>
				jsonResponse(status, {
					...pilotFakeScenariosV1.unauthorized.response.body,
					message: "private authorization detail",
				}),
			);

			await expect(loadMyAgentApplications(client)).resolves.toEqual({
				kind: "unavailable",
				retryable: false,
			});
		}
	});

	it("consumes a current applicant application detail", async () => {
		const requests: Request[] = [];
		const client = createApplicationClient(async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return jsonResponse(200, pendingApplication);
		});

		await expect(
			loadMyAgentApplication("application:tenant/01?draft#one%", client),
		).resolves.toEqual({ kind: "ready", application: pendingApplication });
		expect(requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agent-applications/application%3Atenant%2F01%3Fdraft%23one%25",
		);
	});

	it("keeps missing and forbidden application details equally opaque", async () => {
		for (const status of [403, 404]) {
			const client = createApplicationClient(async () =>
				jsonResponse(status, {
					...pilotFakeScenariosV1.unauthorized.response.body,
					message: "private application detail",
				}),
			);

			await expect(
				loadMyAgentApplication("application-pilot-1", client),
			).resolves.toEqual({ kind: "unavailable", retryable: false });
		}
	});

	it("withdraws a pending current applicant application through the generated client", async () => {
		const requests: Request[] = [];
		const client = createApplicationClient(async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			return jsonResponse(200, withdrawnApplication);
		});

		await expect(
			withdrawMyAgentApplication(
				"application:tenant/01?draft#one%",
				"withdrawal-request-1",
				client,
			),
		).resolves.toEqual(withdrawnApplication);
		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.url).toBe(
			"https://platform.example.test/api/v1/agent-applications/application%3Atenant%2F01%3Fdraft%23one%25/withdraw",
		);
		expect(requests[0]?.headers.get("Idempotency-Key")).toBe(
			"withdrawal-request-1",
		);
	});

	it("keeps a withdrawal failure opaque", async () => {
		const client = createApplicationClient(async () =>
			jsonResponse(403, {
				...pilotFakeScenariosV1.unauthorized.response.body,
				message: "private authorization detail",
			}),
		);

		await expect(
			withdrawMyAgentApplication(
				"application-pilot-1",
				"withdrawal-request-1",
				client,
			),
		).rejects.toMatchObject({
			message: "My Agent data is temporarily unavailable",
		});
	});
});
