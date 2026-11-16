import {
	AgentConnectionAssociationErrorV1,
	type AgentConnectionAssociationRequestV1,
	type AgentConnectionAssociationUseCaseV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerAgentConnectionAssociationRoutes } from "./agent-connection-association-routes.ts";

const url = "/api/v2/agents/agent_01/connection-association";
const credential = "SYNTHETIC_CONNECTION_SERVICE_CREDENTIAL";
const apiMaterial = `papi_${"a".repeat(43)}`;
const state = {
	schemaVersion: 1 as const,
	status: "associated" as const,
	source: "manual" as const,
	associationRevision: 1,
	automaticRegistrationAvailable: false,
};
const manual = {
	schemaVersion: 1,
	mode: "manual",
	connectionAgentId: "connection-agent-01",
	serviceCredential: credential,
	expectedRevision: null,
};

function fixture(
	associate: AgentConnectionAssociationUseCaseV1["associate"] = async () =>
		state,
) {
	const calls: AgentConnectionAssociationRequestV1[] = [];
	const associations = {
		current: vi.fn(async (request: AgentConnectionAssociationRequestV1) => {
			calls.push(request);
			return state;
		}),
		associate: vi.fn(
			async (request: AgentConnectionAssociationRequestV1, value: unknown) => {
				calls.push(request);
				return associate(request, value);
			},
		),
		disconnect: vi.fn(async (request: AgentConnectionAssociationRequestV1) => {
			calls.push(request);
			return {
				...state,
				status: "not_enabled" as const,
				source: null,
				associationRevision: null,
			};
		}),
	} satisfies AgentConnectionAssociationUseCaseV1;
	const app = new Hono();
	registerAgentConnectionAssociationRoutes(app, {
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
		associations,
	});
	return { app, associations, calls };
}
const put = (body: unknown, headers: Record<string, string> = {}) => ({
	method: "PUT",
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify(body),
});

it("routes browser and Owner API credential entries to the same command", async () => {
	const f = fixture();
	const browser = await f.app.request(url, put(manual));
	const api = await f.app.request(
		url,
		put(manual, { authorization: `Bearer ${apiMaterial}` }),
	);
	expect([browser.status, api.status]).toEqual([200, 200]);
	expect(f.associations.associate).toHaveBeenCalledTimes(2);
	expect(f.calls.map((call) => call.entry)).toEqual([
		{ kind: "browser", userId: "owner_01" },
		{ kind: "api", material: apiMaterial },
	]);
	for (const response of [browser, api]) {
		expect(response.headers.get("cache-control")).toBe("no-store");
		const text = await response.text();
		expect(JSON.parse(text)).toEqual(state);
		expect(text).not.toContain(credential);
	}
});

it("never trusts caller identity headers or mixes a Cookie into an API entry", async () => {
	const f = fixture();
	for (const headers of <Record<string, string>[]>[
		{ authorization: `Bearer ${apiMaterial}`, cookie: "session=1" },
		{ authorization: `Bearer ${apiMaterial}`, "x-user-id": "other" },
		{ authorization: "Bearer not-a-platform-credential" },
	]) {
		const response = await f.app.request(url, put(manual, headers));
		expect(response.status).toBeGreaterThanOrEqual(400);
	}
	expect(f.associations.associate).not.toHaveBeenCalled();
});

it("rejects malformed bodies and query strings before the command", async () => {
	const f = fixture();
	for (const [target, body] of [
		[url, { ...manual, serviceCredential: "short" }],
		[url, { ...manual, connectionAgentId: "Bad_ID" }],
		[url, { ...manual, platformUserId: "owner_01" }],
		[`${url}?agentId=other`, manual],
	] as const) {
		const response = await f.app.request(target, put(body));
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(credential);
	}
	expect(f.associations.associate).not.toHaveBeenCalled();
});

it.each([
	["not_authorized", 404, "RESOURCE_UNAVAILABLE"],
	["conflict", 409, "INVALID_REQUEST"],
	["already_associated", 409, "INVALID_REQUEST"],
	["credential_rejected", 409, "PROVIDER_REJECTED"],
	["consumer_unavailable", 409, "ACTION_UNAVAILABLE"],
	["automatic_unavailable", 409, "ACTION_UNAVAILABLE"],
	["verification_unavailable", 503, "CONNECTION_UNAVAILABLE"],
	["unavailable", 503, "DEPENDENCY_UNAVAILABLE"],
] as const)(
	"maps %s to a stable error without echoing the credential",
	async (code, status, wire) => {
		const f = fixture(async () => {
			throw new AgentConnectionAssociationErrorV1(code);
		});
		const response = await f.app.request(url, put(manual));
		expect(response.status).toBe(status);
		const text = await response.text();
		expect(JSON.parse(text)).toMatchObject({ code: wire });
		expect(text).not.toContain(credential);
		expect(text).not.toContain("connection-agent-01");
	},
);

it("reads and disconnects through the same entries", async () => {
	const f = fixture();
	expect((await f.app.request(url)).status).toBe(200);
	const response = await f.app.request(url, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ schemaVersion: 1, expectedRevision: 1 }),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ status: "not_enabled" });
	expect(f.associations.disconnect).toHaveBeenCalledTimes(1);
});
