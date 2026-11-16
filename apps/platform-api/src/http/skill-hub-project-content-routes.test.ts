import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import type { IdentityAdapter } from "./identity.js";
import {
	registerSkillHubProjectContentRoutesV1,
	type SkillHubProjectContentRoutesDependenciesV1,
} from "./skill-hub-project-content-routes.js";

// 网页发布（#2906）路由层：部署未装配包供应时不可用，且不信任调用方提交的包事实。
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
const version = {
	schemaVersion: 1 as const,
	skillId: "project-a",
	skillVersionId: "skill-version-a",
	ownerId: "owner-a",
	visibility: "PRIVATE" as const,
	provider: "my_library" as const,
	version: "1.0.0",
	packageObjectVersion: "object-version-a",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	state: "published" as const,
	needUpgrade: false,
	reviewedBy: null,
	reviewReason: null,
	revokedAt: null,
};
const body = JSON.stringify({
	schemaVersion: 1,
	contentRevision: 1,
	version: "1.0.0",
	visibility: "PRIVATE",
});

function app(
	overrides: Partial<SkillHubProjectContentRoutesDependenciesV1> = {},
) {
	const result = new Hono();
	const dependencies: SkillHubProjectContentRoutesDependenciesV1 = {
		identity,
		read: vi.fn(),
		save: vi.fn(),
		recordRefusal: vi.fn(async () => undefined),
		...overrides,
	};
	registerSkillHubProjectContentRoutesV1(result, dependencies);
	return { result, dependencies };
}
const post = (result: Hono, init: Partial<RequestInit> = {}) =>
	result.request("http://localhost/api/v2/skills/projects/project-a/versions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": "publish-a",
		},
		body,
		...init,
	});

it("returns unavailable for web publication when the deployment has no package supply", async () => {
	const { result, dependencies } = app();
	const response = await post(result);
	expect(response.status).toBe(503);
	expect(dependencies.recordRefusal).toHaveBeenCalledOnce();
});

it("publishes without exposing the object version or publisher", async () => {
	const publish = vi.fn(async () => ({
		replayed: false,
		version,
		artifacts: {},
	}));
	const { result } = app({ publish });
	const response = await post(result);
	expect(response.status).toBe(201);
	const payload = await response.json();
	expect(payload).toMatchObject({
		replayed: false,
		version: {
			skillVersionId: "skill-version-a",
			packageDigest: "a".repeat(64),
		},
	});
	expect(JSON.stringify(payload)).not.toMatch(/object-version-a|ownerId/);
	expect(publish).toHaveBeenCalledWith(
		expect.any(Request),
		expect.objectContaining({ userId: "owner-a" }),
		"project-a",
		"publish-a",
		{
			schemaVersion: 1,
			contentRevision: 1,
			version: "1.0.0",
			visibility: "PRIVATE",
		},
	);
	// 另一个项目的版本不能借这个项目的路径返回。
	const mismatched = app({
		publish: vi.fn(async () => ({
			replayed: false,
			version: { ...version, skillId: "project-b" },
			artifacts: {},
		})),
	});
	expect((await post(mismatched.result)).status).toBe(503);
});

it("rejects Bearer, missing keys, query strings and caller-supplied package facts", async () => {
	const publish = vi.fn();
	const { result } = app({ publish });
	expect(
		(
			await post(result, {
				headers: {
					authorization: "Bearer token",
					"content-type": "application/json",
					"idempotency-key": "publish-a",
				},
			})
		).status,
	).toBe(401);
	expect(
		(await post(result, { headers: { "content-type": "application/json" } }))
			.status,
	).toBe(400);
	expect(
		(
			await result.request(
				"http://localhost/api/v2/skills/projects/project-a/versions?owner=b",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"idempotency-key": "publish-a",
					},
					body,
				},
			)
		).status,
	).toBe(400);
	for (const extra of [
		{ packageObjectVersion: "object-a" },
		{ packageDigest: "a".repeat(64) },
		{ signatureDigest: "c".repeat(64) },
		{ organizationId: "org-a" },
		{ provider: "github" },
	])
		expect(
			(
				await post(result, {
					body: JSON.stringify({ ...JSON.parse(body), ...extra }),
				})
			).status,
		).toBe(400);
	expect(publish).not.toHaveBeenCalled();
});

it("recovers only by the owned operation path without invoking the original publication POST", async () => {
	const recover = vi.fn(async () => ({
		replayed: true,
		version,
		artifacts: {},
	}));
	const publish = vi.fn();
	const { result } = app({ recover, publish });
	const response = await result.request(
		"http://localhost/api/v2/skills/projects/project-a/publications/operation-a/recover",
		{ method: "POST" },
	);
	expect(response.status).toBe(200);
	expect(recover).toHaveBeenCalledWith(
		expect.any(Request),
		expect.objectContaining({ userId: "owner-a" }),
		"project-a",
		"operation-a",
	);
	expect(publish).not.toHaveBeenCalled();
	const body = await response.json();
	expect(body).toMatchObject({
		replayed: true,
		version: { skillVersionId: "skill-version-a" },
	});
	expect(JSON.stringify(body)).not.toMatch(
		/ownerId|object-version-a|idempotencyKey|selection/,
	);
});
it("rejects recovery bodies, query fields and Bearer before invoking recovery", async () => {
	const recover = vi.fn();
	const { result } = app({ recover });
	const path =
		"http://localhost/api/v2/skills/projects/project-a/publications/operation-a/recover";
	expect(
		(
			await result.request(path, {
				method: "POST",
				body: JSON.stringify({ key: "replacement", ownerId: "owner-b" }),
			})
		).status,
	).toBe(400);
	expect(
		(await result.request(path + "?key=replacement", { method: "POST" }))
			.status,
	).toBe(400);
	expect(
		(
			await result.request(path, {
				method: "POST",
				headers: { authorization: "Bearer synthetic" },
			})
		).status,
	).toBe(401);
	expect(recover).not.toHaveBeenCalled();
});
it("fails closed when the recovery supplier is not assembled", async () => {
	const { result } = app();
	expect(
		(
			await result.request(
				"http://localhost/api/v2/skills/projects/project-a/publications/operation-a/recover",
				{ method: "POST" },
			)
		).status,
	).toBe(503);
});
