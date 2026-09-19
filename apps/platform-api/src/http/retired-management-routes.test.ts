import { AgentApplicationCreateRequestV2Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import { createPlatformHealthApp } from "../app.js";
import { registerRetiredManagementRoutes } from "./retired-management-routes.js";

describe("retired management API", () => {
	it("rejects legacy mutations without reaching any business handler", async () => {
		const app = createPlatformHealthApp();
		registerRetiredManagementRoutes(app);
		const response = await app.request("/api/v1/agent-applications", {
			method: "POST",
			body: JSON.stringify({ schemaVersion: 1, actions: [] }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "INVALID_REQUEST",
			retryable: false,
			message: "This Agent management API version is retired. Use /api/v2.",
		});
	});

	it("keeps Conversation URLs available to their own versioned contract", async () => {
		const app = createPlatformHealthApp();
		registerRetiredManagementRoutes(app);
		app.get("/api/v1/agents/:agentId/conversations", (context) =>
			context.json({ items: [] }),
		);
		expect(
			(await app.request("/api/v1/agents/agent_01/conversations")).status,
		).toBe(200);
	});

	it("does not accept old Action fields in a new create request", () => {
		const request = {
			schemaVersion: 2,
			name: "Agent",
			description: "Example",
			source: { kind: "standard", templateId: "codex" },
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
		};
		expect(
			AgentApplicationCreateRequestV2Schema.safeParse(request).success,
		).toBe(true);
		expect(
			AgentApplicationCreateRequestV2Schema.safeParse({
				...request,
				actions: [],
			}).success,
		).toBe(false);
	});
});
