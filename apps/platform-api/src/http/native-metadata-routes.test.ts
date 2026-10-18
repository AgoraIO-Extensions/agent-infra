import { describe, expect, it, vi } from "vitest";
import { createPlatformHealthApp } from "../app.js";
import {
	type NativeMetadataRoutesDependenciesV1,
	registerNativeMetadataRoutes,
} from "./native-metadata-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "native-route-user",
	displayName: "Native Route User",
	accountStatus: "active" as const,
	organizationIds: ["native-route-org"],
	roles: ["employee" as const],
	authorizationRevision: "native-route-revision",
};

const projection = {
	selector: "status" as const,
	status: "active" as const,
	readAt: "2026-10-13T00:00:00.000Z",
};

function setup(
	reader: NativeMetadataRoutesDependenciesV1["reader"] = {
		read: vi.fn().mockResolvedValue(projection),
	},
) {
	const app = createPlatformHealthApp();
	registerNativeMetadataRoutes(app, {
		identity: {
			resolve: async () => identity,
			hydrateUsers: async () => [],
		},
		reader,
	});
	return { app, reader };
}

const path =
	"/api/v2/conversations/conversation-1/executions/execution-1/native-metadata";

describe("public native metadata routes", () => {
	it("returns the reader projection with the exact execution binding", async () => {
		const fixture = setup();
		const response = await fixture.app.request(`${path}?selector=status`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(projection);
		expect(fixture.reader.read).toHaveBeenCalledWith(
			identity,
			"conversation-1",
			"execution-1",
			"status",
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				readStartedAt: expect.any(Number),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it.each([
		`${path}`,
		`${path}?selector=status&selector=status`,
		`${path}?selector=status&extra=value`,
		`${path}?selector=unknown`,
	])("rejects malformed selector query: %s", async (url) => {
		const fixture = setup();
		const response = await fixture.app.request(url);
		expect(response.status).toBe(400);
		expect(fixture.reader.read).not.toHaveBeenCalled();
	});

	it("fails closed when the deployment reader cannot provide a projection", async () => {
		const fixture = setup({ read: vi.fn().mockResolvedValue(null) });
		const response = await fixture.app.request(`${path}?selector=status`);
		expect(response.status).toBe(503);
	});
});
