import { describe, expect, it } from "vitest";
import { createPlatformHealthApp } from "../app.js";
import { registerRetiredManagementRoutes } from "./retired-management-routes.js";

describe("retired management API", () => {
	it.each([
		"/api/v1/agent-applications",
		"/api/v1/agent-applications/application-1",
		"/api/v1/agent-applications/application-1/withdraw",
		"/api/v1/admin/agent-applications",
		"/api/v1/admin/agent-applications/application-1/decision",
		"/api/v1/agents",
		"/api/v1/agents/agent-1",
		"/api/v1/agents/agent-1/configuration",
		"/api/v1/agents/agent-1/lifecycle",
	])("rejects legacy management path %s", async (path) => {
		const app = createPlatformHealthApp();
		registerRetiredManagementRoutes(app);
		for (const method of ["GET", "POST", "PUT"]) {
			const result = await app.request(path, { method });
			expect(result.status).toBe(400);
			expect(await result.json()).toMatchObject({
				code: "INVALID_REQUEST",
				retryable: false,
				message: "This Agent management API version is retired. Use /api/v2.",
			});
		}
	});

	it("leaves V1 Conversation paths independent", async () => {
		const app = createPlatformHealthApp();
		registerRetiredManagementRoutes(app);
		app.get("/api/v1/agents/:agentId/conversations", (context) =>
			context.json({ items: [] }),
		);
		expect(
			(await app.request("/api/v1/agents/agent-1/conversations")).status,
		).toBe(200);
	});
});
