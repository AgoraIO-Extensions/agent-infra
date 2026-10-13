import { SkillHubAgentBindingErrorV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
	registerSkillHubAgentBindingRoutesV1,
	type SkillHubAgentBindingRoutesDependenciesV1,
} from "./skill-hub-agent-binding-routes.ts";

const identity = {
	resolve: vi.fn(async (request: Request) =>
		request.headers.get("cookie") === "user=owner"
			? {
					schemaVersion: 1,
					userId: "owner",
					displayName: "Owner",
					accountStatus: "active",
					organizationIds: ["org"],
					roles: ["employee"],
					authorizationRevision: "auth-1",
				}
			: null,
	),
	hydrateUsers: async () => [],
};

function appWith(
	overrides: Partial<SkillHubAgentBindingRoutesDependenciesV1> = {},
) {
	const dependencies: SkillHubAgentBindingRoutesDependenciesV1 = {
		identity,
		bind: vi.fn(async () => ({
			schemaVersion: 1,
			agentId: "agent",
			revision: 3,
			changedFields: ["skills"] as const,
			replayed: false,
		})),
		read: vi.fn(async () => ({
			configurationRevision: 3,
			bindings: [],
		})),
		...overrides,
	};
	const app = new Hono();
	registerSkillHubAgentBindingRoutesV1(app, dependencies);
	return { app, dependencies };
}

const body = {
	schemaVersion: 1,
	expectedConfigurationRevision: 2,
	bindings: [
		{
			skillVersionId: "skill-version",
			grant: {
				schemaVersion: 1,
				tools: [],
				connections: [],
				fileRoots: [],
				networkOrigins: [],
				scripts: false,
			},
		},
	],
};

describe("Skill Hub Agent binding routes", () => {
	it("binds through the authenticated owner and reads status", async () => {
		const { app, dependencies } = appWith();
		const put = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{
				method: "PUT",
				headers: {
					cookie: "user=owner",
					"content-type": "application/json",
					"Idempotency-Key": "bind-1",
				},
				body: JSON.stringify(body),
			},
		);
		expect(put.status).toBe(201);
		expect(await put.json()).toMatchObject({
			agentId: "agent",
			agentVersion: "v1",
			configurationRevision: 3,
		});
		expect(dependencies.bind).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: "agent", actorId: "owner" }),
		);
		const get = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{ headers: { cookie: "user=owner" } },
		);
		expect(get.status).toBe(200);
		expect(await get.json()).toMatchObject({
			agentId: "agent",
			agentVersion: "v1",
			configurationRevision: 3,
			bindings: [],
		});
	});

	it("fails closed for anonymous, invalid grants, and stale Core decisions", async () => {
		const { app } = appWith({
			bind: vi.fn(async () => {
				throw new SkillHubAgentBindingErrorV1("stale_revision");
			}),
		});
		const anonymous = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{ headers: { "Idempotency-Key": "bind-1" } },
		);
		expect(anonymous.status).toBe(401);
		const stale = await app.request(
			"http://localhost/api/v2/agents/agent/versions/v1/skills",
			{
				method: "PUT",
				headers: {
					cookie: "user=owner",
					"content-type": "application/json",
					"Idempotency-Key": "bind-1",
				},
				body: JSON.stringify(body),
			},
		);
		expect(stale.status).toBe(409);
	});
});
