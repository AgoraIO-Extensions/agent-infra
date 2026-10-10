import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerConnectionInstallationCallbackRoutesV1 } from "./connection-installation-callback-routes.js";

function fixture(expired = false) {
	const claim = vi.fn(async () => ({
		authorizationId: "authorization-a",
		runtimeOrigin: "https://runtime.test:3443/",
		callbackPath: "/internal/runtime/oauth/v1/callback",
		attemptId: "attempt-a",
		expiresAt: expired ? Date.now() - 1 : Date.now() + 60_000,
		issuer: "https://connection.test/",
	}));
	const settle = vi.fn(async () => true);
	const forward = vi.fn(async () => undefined);
	const app = new Hono();
	registerConnectionInstallationCallbackRoutesV1(app, {
		publicOrigin: "https://platform.test",
		callbackUrl: "https://platform.test/connection/callback",
		issuer: "https://connection.test/",
		installation: { callback: { claim, settle } } as never,
		forward,
	});
	return { app, claim, settle, forward };
}

const valid =
	"https://platform.test/connection/callback?code=code-a&iss=https%3A%2F%2Fconnection.test%2F&state=" +
	"a".repeat(64);

it("claims a mapped state, forwards only the callback payload, and settles once", async () => {
	const f = fixture();
	const response = await f.app.request(valid);
	expect(response.status).toBe(204);
	expect(f.claim).toHaveBeenCalledWith({
		stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		now: expect.any(Number),
	});
	expect(f.forward).toHaveBeenCalledWith(
		expect.objectContaining({
			target: expect.objectContaining({
				runtimeOrigin: "https://runtime.test:3443/",
			}),
			request: {
				schemaVersion: 1,
				code: "code-a",
				issuer: "https://connection.test/",
				state: "a".repeat(64),
			},
		}),
	);
	expect(f.settle).toHaveBeenCalledWith({
		stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		attemptId: "attempt-a",
		now: expect.any(Number),
		status: "delivered",
	});
});

it.each([
	"https://platform.test/connection/callback?code=code-a&state=" +
		"a".repeat(64),
	"https://platform.test/connection/callback?code=code-a&iss=https%3A%2F%2Fforeign.test%2F&state=" +
		"a".repeat(64),
	"https://platform.test/connection/callback?code=code-a&iss=https%3A%2F%2Fconnection.test%2F&state=" +
		"a".repeat(64) +
		"&access_token=secret",
])("rejects malformed or extra callback parameters (%s)", async (url) => {
	const f = fixture();
	const response = await f.app.request(url);
	expect(response.status).toBe(400);
	expect(f.forward).not.toHaveBeenCalled();
});

it("rejects a callback received on an alternate origin", async () => {
	const f = fixture();
	const response = await f.app.request(
		"https://alias.platform.test/connection/callback?code=code-a&iss=https%3A%2F%2Fconnection.test%2F&state=" +
			"a".repeat(64),
	);
	expect(response.status).toBe(400);
	expect(f.claim).not.toHaveBeenCalled();
});

it("marks a failed forward unknown and never retries it", async () => {
	const f = fixture();
	f.forward.mockRejectedValueOnce(new Error("transport lost"));
	const response = await f.app.request(valid);
	expect(response.status).toBe(503);
	expect(f.settle).toHaveBeenCalledWith({
		stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		attemptId: "attempt-a",
		now: expect.any(Number),
		status: "unknown",
	});
});

it("accepts an OAuth denial without treating it as a credential", async () => {
	const f = fixture();
	const response = await f.app.request(
		"https://platform.test/connection/callback?error=access_denied&iss=https%3A%2F%2Fconnection.test%2F&state=" +
			"a".repeat(64),
	);
	expect(response.status).toBe(204);
	expect(f.forward).toHaveBeenCalledWith(
		expect.objectContaining({
			request: {
				schemaVersion: 1,
				error: "access_denied",
				issuer: "https://connection.test/",
				state: "a".repeat(64),
			},
		}),
	);
});

it("does not forward a state that expires after claim", async () => {
	const f = fixture(true);
	const response = await f.app.request(valid);
	expect(response.status).toBe(404);
	expect(f.forward).not.toHaveBeenCalled();
	expect(f.settle).toHaveBeenCalledWith(
		expect.objectContaining({ attemptId: "attempt-a", status: "unknown" }),
	);
});
