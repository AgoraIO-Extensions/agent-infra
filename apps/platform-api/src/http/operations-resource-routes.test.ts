import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HttpProtocolError } from "./common.js";
import { registerOperationsResourceRoutesV2 } from "./operations-resource-routes.js";

describe("administrator resource observations", () => {
	it("rejects history ranges longer than thirty days before contacting the source", async () => {
		const app = new Hono();
		app.onError((error, context) =>
			error instanceof HttpProtocolError
				? context.json(error.body, error.status)
				: context.json({ error: "internal" }, 500),
		);
		registerOperationsResourceRoutesV2(app, {
			identity: {
				resolve: async () => ({
					schemaVersion: 1,
					userId: "admin",
					displayName: "Admin",
					accountStatus: "active",
					organizationIds: [],
					roles: ["system_admin"],
					authorizationRevision: "revision-1",
				}),
				hydrateUsers: async () => [],
			},
		});
		const response = await app.request(
			"/api/v2/ops/history?metric=cpu&start=2026-01-01T00%3A00%3A00Z&end=2026-03-01T00%3A00%3A00Z",
		);
		expect(response.status).toBe(400);
	});
	it("denies employees before exposing resource availability", async () => {
		const app = new Hono();
		app.onError((error, context) =>
			error instanceof HttpProtocolError
				? context.json(error.body, error.status)
				: context.json({ error: "internal" }, 500),
		);
		registerOperationsResourceRoutesV2(app, {
			identity: {
				resolve: async () => ({
					schemaVersion: 1,
					userId: "resource-employee",
					displayName: "Employee",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "resource-revision",
				}),
				hydrateUsers: async () => [],
			},
		});
		const response = await app.request("/api/v2/ops/resources");
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "RESOURCE_UNAVAILABLE",
			retryable: false,
		});
	});

	it("serves available resource data without requiring an OTLP provider", async () => {
		const app = new Hono();
		app.onError((error, context) =>
			error instanceof HttpProtocolError
				? context.json(error.body, error.status)
				: context.json({ error: "internal" }, 500),
		);
		registerOperationsResourceRoutesV2(app, {
			identity: {
				resolve: async () => ({
					schemaVersion: 1,
					userId: "resource-admin",
					displayName: "Administrator",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee", "system_admin"],
					authorizationRevision: "resource-revision",
				}),
				hydrateUsers: async () => [],
			},
			operations: {
				read: async () => ({
					schemaVersion: 2,
					scope: { clusterId: "cluster-1", namespace: "platform-1" },
					generatedAt: "2026-11-17T08:00:00.000Z",
					refreshSeconds: 30,
					sources: [
						{
							kind: "platform",
							state: "available",
							observedAt: "2026-11-17T08:00:00.000Z",
							windowSeconds: null,
							reason: null,
						},
					],
					nodes: [],
					resources: [],
					agents: [],
					quotas: [],
					budget: null,
					imageCaches: [],
					cacheEvidence: [],
					events: [],
					alerts: [],
					queue: { waiting: 0, outboxPending: 0 },
					retention: {
						target: {
							detailDays: 7,
							aggregateDays: 30,
							aggregateStepSeconds: 300,
							logDays: 7,
							traceDays: 7,
						},
						effective: null,
					},
					links: [],
					truncated: false,
				}),
			},
		});
		const response = await app.request("/api/v2/ops/resources");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			schemaVersion: 2,
			queue: { waiting: 0, outboxPending: 0 },
			sources: [{ kind: "platform", state: "available" }],
			retention: { effective: null },
		});
	});
});
