import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerUnknownStopOperationsRoutes } from "./unknown-stop-operations-routes.js";

const target =
	"/internal/platform/v1/conversations/conversation/executions/execution/stops/stop/resolve-unknown";

const identity = {
	resolve: vi.fn(async () => ({
		schemaVersion: 1,
		userId: "operator",
		displayName: "Operator",
		accountStatus: "active",
		organizationIds: [],
		roles: ["system_admin"],
		authorizationRevision: "identity-1",
	})),
	hydrateUsers: vi.fn(async () => []),
};

function app(resolveTimedOutUnknownStop = vi.fn(async () => ({
	schemaVersion: 1 as const,
	status: "resolved" as const,
	conversationId: "conversation",
	executionId: "execution",
	stopRequestId: "stop",
	controlRecordId: "control",
	replayed: false,
}))) {
	const application = new Hono();
	registerUnknownStopOperationsRoutes(application, {
		identity,
		resolveTimedOutUnknownStop,
	});
	return { application, resolveTimedOutUnknownStop };
}

function request(body: unknown, headers: Record<string, string> = {}) {
	return new Request(`http://localhost${target}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "resolve-1",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

describe("unknown stop operations route", () => {
	it("derives the operator and target bindings, then returns the stable result", async () => {
		const { application, resolveTimedOutUnknownStop } = app();
		const response = await application.request(
			request({ schemaVersion: 1, sessionGeneration: 3 }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "resolved",
			conversationId: "conversation",
			executionId: "execution",
			replayed: false,
		});
		expect(resolveTimedOutUnknownStop).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation",
				executionId: "execution",
				stopRequestId: "stop",
				sessionGeneration: 3,
				operatorId: "operator",
				idempotencyKey: "resolve-1",
			}),
		);
	});

	it("requires an active system administrator", async () => {
		identity.resolve.mockResolvedValueOnce({
			schemaVersion: 1,
			userId: "operator",
			displayName: "Operator",
			accountStatus: "active",
			organizationIds: [],
			roles: ["employee"],
			authorizationRevision: "identity-1",
		});
		const { application, resolveTimedOutUnknownStop } = app();
		const response = await application.request(
			request({ schemaVersion: 1, sessionGeneration: 1 }),
		);
		expect(response.status).toBe(403);
		expect(resolveTimedOutUnknownStop).not.toHaveBeenCalled();
	});

	it("rejects extra body fields and a missing idempotency key", async () => {
		const extra = await app().application.request(
			request({ schemaVersion: 1, sessionGeneration: 1, executionId: "body" }),
		);
		expect(extra.status).toBe(400);
		const missingKey = await app().application.request(
			request({ schemaVersion: 1, sessionGeneration: 1 }, {
				"Idempotency-Key": "",
			}),
		);
		expect(missingKey.status).toBe(400);
	});
});
