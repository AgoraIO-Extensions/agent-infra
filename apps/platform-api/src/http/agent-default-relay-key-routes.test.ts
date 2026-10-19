import {
	AgentDefaultRelayKeyCandidatesV1Schema,
	AgentDefaultRelayKeySavedCandidatesV1Schema,
} from "@agent-infra/contracts/pilot";
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
function fixture(
	overrides: Partial<AgentDefaultRelayKeyRoutesDependencies> = {},
) {
	const replace = vi.fn<
		AgentDefaultRelayKeyRoutesDependencies["keys"]["replace"]
	>(async () => state);
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
		savedCandidates: {
			read: vi.fn(async () => ({
				schemaVersion: 1,
				agentId: "agent_01",
				configurationRevision: 7,
				keyVersion: 2,
				candidates: [
					{
						endpointId: "endpoint_01",
						modelId: "model_01",
						reasoningLevels: ["medium"],
					},
				],
			})),
		},
		...overrides,
	};
	const app = new Hono();
	registerAgentDefaultRelayKeyRoutes(app, deps);
	return { app, replace };
}
const url = "/api/v2/agents/agent_01/default-relay-key";
const key = "SYNTHETIC_DEFAULT_RELAY_KEY";
const body = { keyValue: key, expectedVersion: 1, configurationRevision: 7 };
it("reads saved-Key candidates through the server-bound Worker projection", async () => {
	const f = fixture();
	const response = await f.app.request(`${url}/candidates`, { method: "GET" });
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		schemaVersion: 1,
		configurationRevision: 7,
		keyVersion: 2,
		candidates: [
			{
				endpointId: "endpoint_01",
				modelId: "model_01",
				reasoningLevels: ["medium"],
			},
		],
	});
});
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

it.each(["GET", "POST"])(
	"adds only trusted names on the new %s path and retains the exact old response",
	async (method) => {
		const candidate = {
			endpointId: "endpoint_01",
			modelId: "model_01",
			reasoningLevels: ["medium"],
		};
		const lookup = vi.fn(() => "部署模型甲");
		const names = vi.fn(async () => lookup);
		const f = fixture({
			readModelDisplayNames: names,
			keys: {
				current: async () => state,
				replace: async () => state,
				candidates: async () => ({
					schemaVersion: 1,
					configurationRevision: 7,
					candidates: [candidate],
				}),
			},
		});
		const init = {
			method,
			...(method === "POST"
				? {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ keyValue: key, configurationRevision: 7 }),
					}
				: {}),
		};
		const legacy = await f.app.request(`${url}/candidates`, init);
		expect(legacy.status).toBe(200);
		const oldProjection = (
			method === "GET"
				? AgentDefaultRelayKeySavedCandidatesV1Schema
				: AgentDefaultRelayKeyCandidatesV1Schema
		).parse(await legacy.json());
		expect(oldProjection).toEqual({
			schemaVersion: 1,
			configurationRevision: 7,
			...(method === "GET" ? { keyVersion: 2 } : {}),
			candidates: [candidate],
		});
		expect(names).not.toHaveBeenCalled();
		const display = await f.app.request(`${url}/display-candidates`, init);
		expect(display.status).toBe(200);
		expect(display.headers.get("Cache-Control")).toBe("no-store");
		expect(await display.json()).toEqual({
			...oldProjection,
			schemaVersion: 2,
			candidates: [{ ...candidate, displayName: "部署模型甲" }],
		});
		expect(lookup).toHaveBeenCalledWith(candidate);
	},
);

it.each(["GET", "POST"])(
	"rejects foreign-subject %s before reading names",
	async (method) => {
		const refused = async () => {
			throw new AgentDefaultRelayKeyErrorV1("not_authorized");
		};
		const names = vi.fn();
		const f = fixture({
			readModelDisplayNames: names,
			keys: { current: refused, candidates: refused, replace: refused },
		});
		const response = await f.app.request(`${url}/display-candidates`, {
			method,
			...(method === "POST"
				? {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ keyValue: key, configurationRevision: 7 }),
					}
				: {}),
		});
		expect(response.status).toBe(404);
		expect(names).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(key);
	},
);

it("does not enrich stale saved-Key evidence or expose display dependency failures", async () => {
	const names = vi.fn(async () => {
		throw new Error(key);
	});
	const stale = fixture({
		readModelDisplayNames: names,
		savedCandidates: {
			read: async () => ({
				schemaVersion: 1,
				agentId: "agent_01",
				configurationRevision: 8,
				keyVersion: 2,
				candidates: [],
			}),
		},
	});
	expect((await stale.app.request(`${url}/display-candidates`)).status).toBe(
		503,
	);
	expect(names).not.toHaveBeenCalled();
	const current = fixture({ readModelDisplayNames: names });
	const response = await current.app.request(`${url}/display-candidates`);
	expect(response.status).toBe(503);
	expect(await response.text()).not.toContain(key);
});
