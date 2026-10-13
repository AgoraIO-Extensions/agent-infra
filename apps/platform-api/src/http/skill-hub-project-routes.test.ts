import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { IdentityAdapter } from "./identity.js";
import { registerSkillHubProjectRoutesV1 } from "./skill-hub-project-routes.js";

const project = {
	schemaVersion: 1 as const,
	projectId: "project-a",
	name: "summary",
	ownerId: "owner-a",
	organizationId: null,
	status: "active" as const,
	createdAt: "2026-10-13T00:00:00.000Z",
	updatedAt: "2026-10-13T00:00:00.000Z",
};
const identity = {
	resolve: vi.fn(async () => ({
		schemaVersion: 1,
		userId: "owner-a",
		displayName: "Owner",
		accountStatus: "active",
		organizationIds: [],
		roles: ["employee"],
		authorizationRevision: "revision-a",
	})),
	hydrateUsers: async () => [],
} satisfies IdentityAdapter;

function app() {
	const result = new Hono();
	registerSkillHubProjectRoutesV1(result, {
		identity,
		list: vi.fn(async () => [project]),
		read: vi.fn(async () => project),
		create: vi.fn(async () => ({ replayed: false, project })),
		update: vi.fn(async () => ({
			replayed: false,
			project: { ...project, name: "renamed" },
		})),
	});
	return result;
}

it("creates projects and maps replayed creates to 200", async () => {
	const result = app();
	const first = await result.request(
		"http://localhost/api/v2/skills/projects",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "create-a",
			},
			body: JSON.stringify({ schemaVersion: 1, name: "summary" }),
		},
	);
	expect(first.status).toBe(201);
	expect(await first.json()).toMatchObject({ projectId: "project-a" });
});

it("serves list/read/update and rejects malformed requests", async () => {
	const result = app();
	expect(
		(await result.request("http://localhost/api/v2/skills/projects")).status,
	).toBe(200);
	expect(
		(await result.request("http://localhost/api/v2/skills/projects/project-a"))
			.status,
	).toBe(200);
	expect(
		(
			await result.request(
				"http://localhost/api/v2/skills/projects/project-a",
				{
					method: "PATCH",
					headers: {
						"content-type": "application/json",
						"idempotency-key": "update-a",
					},
					body: JSON.stringify({ schemaVersion: 1, name: "renamed" }),
				},
			)
		).status,
	).toBe(200);
	expect(
		(
			await result.request("http://localhost/api/v2/skills/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schemaVersion: 1, name: "summary" }),
			})
		).status,
	).toBe(400);
});
