import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
	createNativeMetadataCurrentAppV1,
	type NativeMetadataCurrentRouteDependenciesV1,
	registerNativeMetadataCurrentRoutesV1,
} from "./native-metadata-current-routes.js";

const request = {
	schemaVersion: 1 as const,
	readId: "read-current",
	selector: "status" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: "user-current" },
		agentId: "agent-current",
		channelId: "web",
		conversationId: "conversation-current",
		executionId: "execution-current",
		sessionGeneration: 1,
		authorizationRevision: "authorization-current",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "request-current",
	traceId: "trace-current",
	phase: "read_metadata" as const,
	originalHostScopeRef: "host-current",
};

const allowed = { outcome: "allowed" as const, request };

function fixture(
	check: NativeMetadataCurrentRouteDependenciesV1["check"] = async () =>
		allowed,
	checkerTimeoutMs?: number,
) {
	return createNativeMetadataCurrentAppV1(
		{
			serviceToken: "api-current-token",
			check,
		},
		checkerTimeoutMs === undefined ? {} : { checkerTimeoutMs },
	);
}

function requestFor(
	app: ReturnType<typeof fixture>,
	token = "api-current-token",
	body: unknown = { apiRequestSourceRef: "api-source-current", request },
) {
	return app.request("/internal/platform/v1/native-metadata/current", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("native metadata current-confirmation route", () => {
	it("checks the request with the deployment token and returns allowed", async () => {
		const check = vi.fn(async () => allowed);
		const response = await requestFor(fixture(check));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(allowed);
		expect(check).toHaveBeenCalledWith({
			request,
			apiRequestSourceRef: "api-source-current",
			signal: expect.any(AbortSignal),
		});
	});

	it("fails closed on wrong token and malformed requests", async () => {
		const app = fixture();
		expect((await requestFor(app, "wrong-token")).status).toBe(401);
		expect(
			(await requestFor(app, "api-current-token", { apiRequestSourceRef: "x" }))
				.status,
		).toBe(503);
		expect(
			(
				await requestFor(app, "api-current-token", {
					apiRequestSourceRef: "x",
					request: "a".repeat(64 * 1024),
				})
			).status,
		).toBe(400);
	});

	it("returns denied without exposing checker errors", async () => {
		const response = await requestFor(
			fixture(async () => ({ outcome: "denied" })),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ outcome: "denied" });
	});

	it("registers the fixed route on the production API app", async () => {
		const app = new Hono();
		registerNativeMetadataCurrentRoutesV1(app, {
			serviceToken: "api-current-token",
			check: async () => allowed,
		});
		const response = await app.request(
			"/internal/platform/v1/native-metadata/current",
			{
				method: "POST",
				headers: {
					authorization: "Bearer api-current-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					apiRequestSourceRef: "api-source-current",
					request,
				}),
			},
		);
		expect(response.status).toBe(200);
	});

	it("ends a stalled checker at the route deadline", async () => {
		const response = await requestFor(
			fixture(() => new Promise<never>(() => undefined), 1),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ outcome: "unavailable" });
	});
});
