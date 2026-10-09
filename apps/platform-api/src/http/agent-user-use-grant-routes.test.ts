import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAgentUserUseGrantRoutes } from "./agent-user-use-grant-routes.js";

const identity = {
	schemaVersion: 1,
	userId: "owner-1",
	displayName: "Owner",
	accountStatus: "active",
	organizationIds: [],
	roles: ["employee"],
	authorizationRevision: "identity-1",
};

function fixture() {
	const revoke = vi.fn().mockResolvedValue({
		schemaVersion: 1,
		agentId: "agent-1",
		userId: "user-2",
		granted: false,
		authorizationRevision: "grant-2",
		replayed: false,
	});
	const recordRefusal = vi.fn().mockResolvedValue(undefined);
	const app = new Hono();
	registerAgentUserUseGrantRoutes(app, {
		identity: { resolve: async () => identity, hydrateUsers: async () => [] },
		revoke,
		recordRefusal,
	});
	return { app, revoke, recordRefusal };
}

describe("Agent user API-use revoke HTTP", () => {
	it("requires a browser session and forwards the server identity", async () => {
		const f = fixture();
		const response = await f.app.request(
			"/api/v2/agents/agent-1/api-use-grants/user-2",
			{
				method: "DELETE",
				headers: {
					Cookie: "session=owner",
					"Idempotency-Key": "revoke-1",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, expectedRevision: 1 }),
			},
		);
		expect(response.status).toBe(200);
		expect(f.revoke).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				userId: "user-2",
				actorId: "owner-1",
				idempotencyKey: "revoke-1",
			}),
		);
	});

	it("rejects Bearer credentials and never calls the governance writer", async () => {
		const f = fixture();
		const response = await f.app.request(
			"/api/v2/agents/agent-1/api-use-grants/user-2",
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer papi_${"A".repeat(43)}`,
					"Idempotency-Key": "revoke-1",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, expectedRevision: 1 }),
			},
		);
		expect(response.status).toBe(401);
		expect(f.revoke).not.toHaveBeenCalled();
	});
});
