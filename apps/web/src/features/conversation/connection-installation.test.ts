import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	beginPlatformConnectionInstallationV1: vi.fn(),
	confirmPlatformConnectionInstallationV1: vi.fn(),
	readPlatformConnectionInstallationV1: vi.fn(),
}));
vi.mock("../../pilot/generated-v2/sdk.gen.js", () => api);

import {
	beginConnectionInstallation,
	confirmConnectionInstallation,
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
			"X-Platform-CSRF": "1",
		},
	});
	expect(request.headers.Origin).toBeUndefined();
	expect(request.headers["Sec-Fetch-Site"]).toBeUndefined();
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

it("confirms an installation with an explicit idempotent command", async () => {
	api.confirmPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 202 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "confirmed",
			expiresAt: Date.now() + 10_000,
		},
	});
	await expect(
		confirmConnectionInstallation({
			authorizationId: "authorization-1",
			idempotencyKey: "confirm-retry-key",
		}),
	).resolves.toMatchObject({ kind: "confirmed" });
	expect(api.confirmPlatformConnectionInstallationV1).toHaveBeenCalledWith(
		expect.objectContaining({
			body: { schemaVersion: 1 },
			path: { authorizationId: "authorization-1" },
			headers: {
				"X-Platform-CSRF": "1",
				"Idempotency-Key": "confirm-retry-key",
			},
		}),
	);
});

it.each(["confirm", "read"] as const)(
	"rejects another installation or credential material in a %s response",
	async (command) => {
		const request =
			command === "confirm"
				? confirmConnectionInstallation
				: readConnectionInstallation;
		const mock =
			command === "confirm"
				? api.confirmPlatformConnectionInstallationV1
				: api.readPlatformConnectionInstallationV1;
		for (const fields of [
			{ authorizationId: "other-authorization" },
			{ token: "secret-material" },
		]) {
			mock.mockResolvedValue({
				response: { status: command === "confirm" ? 202 : 200 },
				data: {
					schemaVersion: 1,
					authorizationId: "authorization-1",
					status: "confirmed",
					expiresAt: Date.now() + 10_000,
					...fields,
				},
			});
			await expect(
				request({
					authorizationId: "authorization-1",
					idempotencyKey: "confirm-key",
				}),
			).rejects.toThrow("CONNECTION_INSTALLATION_INVALID_RESPONSE");
		}
	},
);

it("rejects response fields that could contain credential material", async () => {
	api.readPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 200 },
		data: {
			schemaVersion: 1,
			authorizationId: "authorization-1",
			status: "confirmed",
			expiresAt: Date.now() + 10_000,
			token: "secret-material",
		},
	});
	await expect(
		readConnectionInstallation({ authorizationId: "authorization-1" }),
	).rejects.toThrow("CONNECTION_INSTALLATION_INVALID_RESPONSE");
});

it("uses browser security headers for status reads without an idempotency key", () => {
	const headers = connectionRequestHeaders();
	expect(headers).toEqual({
		"X-Platform-CSRF": "1",
	});
});

it("allows an ambiguous begin retry to reuse its idempotency key", async () => {
	api.beginPlatformConnectionInstallationV1.mockResolvedValue({
		response: { status: 500 },
		data: undefined,
	});
	await beginConnectionInstallation({
		executionId: "execution-1",
		idempotencyKey: "begin-retry-key",
	});
	await beginConnectionInstallation({
		executionId: "execution-1",
		idempotencyKey: "begin-retry-key",
	});
	expect(api.beginPlatformConnectionInstallationV1).toHaveBeenNthCalledWith(
		1,
		expect.objectContaining({
			headers: expect.objectContaining({
				"Idempotency-Key": "begin-retry-key",
			}),
		}),
	);
	expect(api.beginPlatformConnectionInstallationV1).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			headers: expect.objectContaining({
				"Idempotency-Key": "begin-retry-key",
			}),
		}),
	);
});
