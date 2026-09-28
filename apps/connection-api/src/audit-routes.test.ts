import {
	ConnectionApplicationService,
	type ConnectionOAuthService,
	type ConnectionRepository,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import { describe, expect, it } from "vitest";
import { createConnectionOAuthApp } from "./oauth-routes";

describe("administrator audit HTTP boundary", () => {
	it("rejects missing sessions, non-admins, forged identities and bad ranges; fails closed on query failure", async () => {
		let admin = true;
		let reads = 0;
		let fail = false;
		const repository = {
			authorizeConnectionAdministration: async (id: string) =>
				admin && id === "admin",
			listAuditCalls: async (id: string) => {
				expect(id).toBe("admin");
				reads++;
				if (fail) throw new Error("DATABASE-SECRET-CANARY");
				return [];
			},
			getAuditCall: async () => {
				throw new Error("DATABASE-SECRET-CANARY");
			},
		} as unknown as ConnectionRepository;
		const service = new ConnectionApplicationService(repository, {} as never);
		const oauth = {
			getBrowserAccount: async (token?: string) => {
				if (!token)
					throw new OAuthProtocolError("invalid_token", "denied", 401);
				return {
					principalId: token === "admin-session" ? "admin" : "user",
					displayName: "Test",
				};
			},
		} as unknown as ConnectionOAuthService;
		const app = createConnectionOAuthApp({
			issuer: "https://connection.example",
			resource: "https://connection.example/mcp",
			service: oauth,
			management: {
				githubRedirectUri: "https://connection.example/callback",
				service,
			},
		});
		const path =
			"/api/v1/connection/admin/action-calls?from=2026-09-01T00:00:00Z&to=2026-09-27T00:00:00Z";
		expect((await app.request(path)).status).toBe(401);
		expect(
			(
				await app.request(path, {
					headers: { cookie: "connection_session=user-session" },
				})
			).status,
		).toBe(404);
		const headers = { cookie: "connection_session=admin-session" };
		expect(
			(await app.request(`${path}&principalId=other`, { headers })).status,
		).toBe(400);
		expect(
			(await app.request(path.replace("2026-09-01", "2025-09-01"), { headers }))
				.status,
		).toBe(400);
		expect(reads).toBe(0);
		const response = await app.request(path, { headers });
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ items: [], nextCursor: null });
		admin = false;
		expect((await app.request(path, { headers })).status).toBe(404);
		expect(
			(
				await app.request("/api/v1/connection/admin/action-calls/other-call", {
					headers,
				})
			).status,
		).toBe(404);
		admin = true;
		fail = true;
		const failed = await app.request(path, { headers });
		expect(failed.status).toBe(500);
		expect(await failed.text()).not.toContain("DATABASE-SECRET-CANARY");
	});
});
