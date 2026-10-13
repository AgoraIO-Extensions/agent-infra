import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpProtocolError } from "./common.js";
import { registerObservabilityRoutes } from "./observability-routes.js";

const admin = {
	schemaVersion: 1 as const,
	userId: "admin-1",
	displayName: "Ada",
	accountStatus: "active" as const,
	organizationIds: ["org-1"],
	roles: ["employee" as const, "system_admin" as const],
	authorizationRevision: "rev-1",
};

function createApp(identity = admin, observability = true) {
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	const identityAdapter = {
		resolve: vi.fn().mockResolvedValue(identity),
		hydrateUsers: vi.fn().mockResolvedValue([]),
	};
	registerObservabilityRoutes(app, {
		identity: identityAdapter,
		...(observability
			? {
					observability: {
						status: () => ({
							enabled: true,
							state: "active" as const,
							captureFailures: 0,
							exportFailures: 2,
							droppedLogs: 1,
							invalidRecords: 0,
							lastExportFailureAt: "2026-10-13T00:00:00.000Z",
						}),
					},
				}
			: {}),
	});
	return { app, identityAdapter };
}

describe("observability status route", () => {
	it("returns only the redacted process status to a system administrator", async () => {
		const { app } = createApp();
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			service: "platform-api",
			enabled: true,
			state: "active",
			captureFailures: 0,
			exportFailures: 2,
			droppedLogs: 1,
			invalidRecords: 0,
			lastExportFailureAt: "2026-10-13T00:00:00.000Z",
		});
	});

	it("denies ordinary users and does not expose status fields", async () => {
		const { app } = createApp({ ...admin, roles: ["employee"] });
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(403);
		expect(JSON.stringify(await response.json())).not.toContain(
			"exportFailures",
		);
	});

	it("reports an explicit dependency error when observability is not assembled", async () => {
		const { app } = createApp(admin, false);
		const response = await app.request("/api/v1/ops/observability");
		expect(response.status).toBe(503);
		expect((await response.json()) as { code: string }).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
		});
	});
});
