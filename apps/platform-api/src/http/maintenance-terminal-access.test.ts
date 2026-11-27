import { expect, it } from "vitest";
import { createPlatformHealthApp } from "../app.ts";
import { registerMaintenanceTerminalAccess } from "./maintenance-terminal-access.ts";

it("checks the signed-in user's authority without a business Conversation", async () => {
	const app = createPlatformHealthApp();
	registerMaintenanceTerminalAccess(app, {
		identity: {
			resolve: async () => ({
				schemaVersion: 1,
				userId: "creator",
				displayName: "Creator",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "identity-1",
			}),
			hydrateUsers: async () => [],
		},
		readAccess: async ({ agentId, actorId }) =>
			agentId === "own-agent" && actorId === "creator",
	});
	const access = await app.request(
		"/api/v2/agents/own-agent/maintenance-terminal/access",
	);
	expect(access.status).toBe(204);
	expect(access.headers.get("cache-control")).toBe("no-store");
	const denied = await app.request(
		"/api/v2/agents/other-agent/maintenance-terminal/access",
		{ headers: { "X-User-Id": "other-creator" } },
	);
	expect(denied.status).toBe(403);
	expect(denied.headers.get("cache-control")).toBe("no-store");
	for (const [path, headers, status] of [
		["own-agent/maintenance-terminal/access?actorId=creator", {}, 400],
		[
			"own-agent/maintenance-terminal/access",
			{ Authorization: "Bearer example" },
			401,
		],
	] as const) {
		const response = await app.request(`/api/v2/agents/${path}`, { headers });
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("no-store");
	}
});
