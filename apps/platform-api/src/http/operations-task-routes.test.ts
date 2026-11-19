import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { HttpProtocolError } from "./common.js";
import { registerOperationsTaskRoutesV2 } from "./operations-task-routes.js";

const path =
	"/api/v2/ops/tasks?agentId=agent&sessionId=session&start=2026-11-01T00%3A00%3A00Z&end=2026-11-02T00%3A00%3A00Z";

it("enforces administrator access and validates the response before publishing it", async () => {
	const read = vi.fn(async () => ({ privatePayload: "must not leak" }));
	let accountStatus = "active";
	let roles = ["employee"];
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ error: "internal" }, 500),
	);
	registerOperationsTaskRoutesV2(app, {
		identity: {
			resolve: async () => ({
				schemaVersion: 1,
				userId: "agent-owner",
				displayName: "Owner",
				accountStatus,
				roles,
				organizationIds: [],
				authorizationRevision: "rev-1",
			}),
			hydrateUsers: async () => [],
		},
		tasks: { read },
	});
	expect((await app.request(path)).status).toBe(403);
	expect(read).not.toHaveBeenCalled();
	roles = ["system_admin"];
	accountStatus = "disabled";
	expect((await app.request(path)).status).toBe(403);
	expect(read).not.toHaveBeenCalled();
	accountStatus = "active";
	const response = await app.request(path);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).toEqual({
		schemaVersion: 2,
		source: "platform",
		state: "unavailable",
		truncated: false,
		tasks: [],
	});

	read.mockRejectedValueOnce(
		new DOMException("Database deadline exceeded", "TimeoutError"),
	);
	const timedOut = await app.request(path);
	expect(timedOut.status).toBe(200);
	expect(await timedOut.json()).toEqual({
		schemaVersion: 2,
		source: "platform",
		state: "unavailable",
		truncated: false,
		tasks: [],
	});
});
