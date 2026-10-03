import { AgentDefaultRelayKeyErrorV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
	type AgentDefaultRelayKeyRoutesDependencies,
	registerAgentDefaultRelayKeyRoutes,
} from "./agent-default-relay-key-routes.ts";

const state = {
	schemaVersion: 1 as const,
	isSet: true,
	keyVersion: 2,
	configurationRevision: 7,
};
function fixture() {
	const replace = vi.fn(async () => state);
	const deps: AgentDefaultRelayKeyRoutesDependencies = {
		identity: {
			resolve: async () => ({
				schemaVersion: 1,
				userId: "owner_01",
				displayName: "Owner",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "auth-1",
			}),
			hydrateUsers: async () => [],
		},
		keys: {
			current: async () => state,
			replace,
			candidates: async () => ({
				schemaVersion: 1,
				configurationRevision: 7,
				candidates: [],
			}),
		},
	};
	const app = new Hono();
	registerAgentDefaultRelayKeyRoutes(app, deps);
	return { app, replace };
}
const url = "/api/v2/agents/agent_01/default-relay-key";
const key = "SYNTHETIC_DEFAULT_RELAY_KEY";
const body = { keyValue: key, expectedVersion: 1, configurationRevision: 7 };
it("passes server identity and returns only the committed public state with no-store", async () => {
	const f = fixture();
	const response = await f.app.request(url, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).toEqual(state);
	expect(f.replace.mock.calls[0]?.[0]).toMatchObject({
		userId: "owner_01",
		agentId: "agent_01",
	});
});
it.each(["foreign identity field", "query", "Authorization", "malformed Key"])(
	"rejects %s before dispatch",
	async (mode) => {
		const f = fixture();
		const response = await f.app.request(
			url + (mode === "query" ? "?key=not-allowed" : ""),
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					...(mode === "Authorization"
						? { Authorization: "Bearer synthetic" }
						: {}),
				},
				body: JSON.stringify(
					mode === "foreign identity field"
						? { ...body, userId: "other" }
						: mode === "malformed Key"
							? { ...body, keyValue: "short" }
							: body,
				),
			},
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(f.replace).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(key);
	},
);
it("conceals absent/foreign Agent and dependency detail", async () => {
	for (const error of [
		new AgentDefaultRelayKeyErrorV1("not_authorized"),
		new Error(key),
	]) {
		const f = fixture();
		f.replace.mockRejectedValueOnce(error);
		const response = await f.app.request(url, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(
			error instanceof AgentDefaultRelayKeyErrorV1 ? 404 : 503,
		);
		expect(await response.text()).not.toContain(key);
	}
});
