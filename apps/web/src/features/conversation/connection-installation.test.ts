import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	beginPlatformConnectionInstallationV1: vi.fn(),
	readPlatformConnectionInstallationV1: vi.fn(),
}));
vi.mock("../../pilot/generated-v2/sdk.gen.js", () => api);

import {
	beginConnectionInstallation,
	connectionRequestHeaders,
	readConnectionInstallation,
	safeConnectionAuthorizationUrl,
} from "./connection-installation.js";

beforeEach(() => {
	vi.clearAllMocks();
});

it("accepts only safe HTTPS authorization URLs", () => {
	expect(
		safeConnectionAuthorizationUrl("https://connector.test/authorize?state=x"),
	).toBe("https://connector.test/authorize?state=x");
	expect(
		safeConnectionAuthorizationUrl("http://connector.test/authorize"),
	).toBeUndefined();
	expect(
		safeConnectionAuthorizationUrl(
			"https://user:pass@connector.test/authorize",
		),
	).toBeUndefined();
	expect(
		safeConnectionAuthorizationUrl("https://connector.test/authorize#secret"),
	).toBeUndefined();
});

it("starts an installation with the current browser CSRF headers and projects no secret", async () => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "awaiting_confirmation",
			expiresAt: Date.now() + 10_000,
			authorizationUrl: "https://connector.test/authorize?state=x",
		},
	});
	const result = await beginConnectionInstallation({
		executionId: "execution-1",
	});
	expect(result).toMatchObject({ kind: "awaiting_confirmation" });
	const request = api.beginPlatformConnectionInstallationV1.mock.calls[0]?.[0];
	expect(request).toMatchObject({
		body: { schemaVersion: 1, executionId: "execution-1" },
		headers: {
			Origin: window.location.origin,
			"X-Platform-CSRF": "1",
			"Sec-Fetch-Site": "same-origin",
		},
	});
	expect(request.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
	expect(JSON.stringify(result)).not.toContain("token");
});

it("maps status reads and fails closed on invalid responses", async () => {
	api.readPlatformConnectionInstallationV1.mockResolvedValueOnce({
		response: { status: 200 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "confirmed",
			expiresAt: Date.now() + 10_000,
		},
	});
	expect(
		await readConnectionInstallation({ authorizationId: "authorization-1" }),
	).toMatchObject({ kind: "confirmed" });
	api.readPlatformConnectionInstallationV1.mockResolvedValueOnce({
		response: { status: 200 },
		data: { schemaVersion: 1, authorizationId: "authorization-1" },
	});
	await expect(
		readConnectionInstallation({ authorizationId: "authorization-1" }),
	).rejects.toThrow("CONNECTION_INSTALLATION_INVALID_RESPONSE");
});

it("uses browser security headers for status reads without an idempotency key", () => {
	const headers = connectionRequestHeaders();
	expect(headers).toEqual({
		Origin: window.location.origin,
		"X-Platform-CSRF": "1",
		"Sec-Fetch-Site": "same-origin",
	});
});
