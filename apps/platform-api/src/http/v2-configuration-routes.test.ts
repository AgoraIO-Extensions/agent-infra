import {
	AgentProjectionV2Schema,
	PilotProtocolErrorV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it, vi } from "vitest";

import { createPlatformHealthApp } from "../app.js";
import { registerV2ConfigurationRoutes } from "./v2-configuration-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const],
	authorizationRevision: "authorization-1",
};

const agentProjection = {
	schemaVersion: 1 as const,
	agentId: "agent-1",
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	managementStatus: "available" as const,
	serviceAvailability: "ready" as const,
	configuration: {
		owners: [
			{ userId: "user-1", displayName: "Ada", roles: ["employee" as const] },
		],
		availability: [{ kind: "organization" as const, organizationId: "org-1" }],
		modelOptions: [],
		defaultModelOptionId: null,
		defaultReasoningLevel: null,
		actions: [],
		environment: [],
		channels: [{ kind: "web" as const, status: "available" as const }],
		secrets: [],
	},
	capabilities: {
		modelSelection: false,
		attachments: false,
		resultFiles: false,
		connection: false,
		supplementaryInstruction: false,
	},
	interactionUrl: null,
};

function createApp() {
	const app = createPlatformHealthApp();
	const update = vi.fn().mockResolvedValue({});
	const read = vi.fn().mockResolvedValue({
		outcome: "found",
		configuration: { revision: 7 },
	});
	const readAgentProjection = vi.fn().mockResolvedValue(agentProjection);

	registerV2ConfigurationRoutes(app, {
		identity: {
			resolve: vi.fn().mockResolvedValue(identity),
			hydrateUsers: vi.fn().mockResolvedValue([]),
		},
		configuration: { update },
		configurationQuery: { read },
		readAgentProjection,
		prepareSecretReplacements: vi.fn().mockResolvedValue({
			secrets: [],
			modelCredentialOptionIds: [],
		}),
	});

	return { app, update, read, readAgentProjection };
}

describe("V2 configuration routes", () => {
	it("updates through the V2 Core command and returns an action-free projection", async () => {
		const { app, update, readAgentProjection } = createApp();
		const response = await app.request("/api/v2/agents/agent-1/configuration", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "Command.Aa-02",
			},
			body: JSON.stringify({
				schemaVersion: 2,
				environment: [{ name: "MODE", value: "safe" }],
			}),
		});

		expect(response.status).toBe(200);
		const projection = AgentProjectionV2Schema.parse(await response.json());
		expect(projection.schemaVersion).toBe(2);
		expect(projection.configuration).not.toHaveProperty("actions");
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ schemaVersion: 2, agentId: "agent-1" }),
			expect.objectContaining({ actorId: "user-1" }),
			undefined,
		);
		expect(readAgentProjection).toHaveBeenCalledOnce();
	});

	it("rejects the retired actions field before touching Core", async () => {
		const { app, update } = createApp();
		const response = await app.request("/api/v2/agents/agent-1/configuration", {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "Command.Aa-03",
			},
			body: JSON.stringify({ schemaVersion: 2, actions: [] }),
		});

		expect(response.status).toBe(400);
		expect(PilotProtocolErrorV1Schema.parse(await response.json()).code).toBe(
			"INVALID_REQUEST",
		);
		expect(update).not.toHaveBeenCalled();
	});
});
