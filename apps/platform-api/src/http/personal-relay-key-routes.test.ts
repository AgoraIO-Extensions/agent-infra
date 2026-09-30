import { createPersonalRelayKeyUseCaseV1 } from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerPersonalRelayKeyRoutes } from "./personal-relay-key-routes.js";

const userId = "ba281160-23f5-4358-bbf7-ff56fb167b8a";
const path = "/api/v2/me/relay-key";
const keyValue = "relay-test-key-value";
const replaceBody = JSON.stringify({
	schemaVersion: 1,
	expectedVersion: null,
	keyValue,
});

function fixture() {
	const store = {
		current: vi.fn(async () => null as number | null),
		replace: vi.fn(async () => 1 as number | null),
		revoke: vi.fn(async () => true),
		recordRejected: vi.fn(async () => {}),
	};
	const validate = vi.fn(
		async () => "valid" as "valid" | "invalid" | "unavailable",
	);
	const app = new Hono();
	registerPersonalRelayKeyRoutes(app, {
		identity: {
			async resolve() {
				return {
					schemaVersion: 1,
					userId,
					displayName: "Employee",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "directory-revision-1",
				};
			},
			async hydrateUsers() {
				return [];
			},
		},
		keys: createPersonalRelayKeyUseCaseV1({ store, validate }),
	});
	return { app, store, validate };
}

describe("personal Relay Key HTTP", () => {
	it("serves only the trusted browser user's Key status", async () => {
		const { app, store } = fixture();
		const response = await app.request(path);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			isSet: false,
			keyVersion: null,
		});
		expect(store.current).toHaveBeenCalledWith(
			expect.objectContaining({ actorUserId: userId }),
		);
	});

	it("rejects bearer and malformed requests before validation or storage, with audit", async () => {
		const { app, store, validate } = fixture();
		const bearer = await app.request(path, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer synthetic",
			},
			body: replaceBody,
		});
		expect(bearer.status).toBe(401);
		const malformed = await app.request(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 1,
				expectedVersion: null,
				keyValue: "short",
			}),
		});
		expect(malformed.status).toBe(400);
		const forgedSubject = await app.request(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 1,
				expectedVersion: null,
				keyValue,
				actorUserId: "another-user",
			}),
		});
		expect(forgedSubject.status).toBe(400);
		expect(store.recordRejected).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				actorUserId: null,
				reason: "AUTHENTICATION_REQUIRED",
			}),
		);
		expect(store.recordRejected).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				actorUserId: userId,
				reason: "INVALID_REQUEST",
			}),
		);
		expect(validate).not.toHaveBeenCalled();
		expect(store.replace).not.toHaveBeenCalled();
	});

	it("fails closed when validation or its audit dependency is unavailable", async () => {
		const { app, store, validate } = fixture();
		validate.mockResolvedValueOnce("unavailable");
		const request = () =>
			app.request(path, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: replaceBody,
			});
		const unavailable = await request();
		expect(unavailable.status).toBe(503);
		expect(store.replace).not.toHaveBeenCalled();
		store.recordRejected.mockRejectedValueOnce(new Error("audit unavailable"));
		validate.mockResolvedValueOnce("invalid");
		const auditFailure = await request();
		expect(auditFailure.status).toBe(503);
		expect(JSON.stringify(await auditFailure.json())).not.toContain(
			"audit unavailable",
		);
		validate.mockResolvedValueOnce("invalid");
		const invalid = await request();
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({
			code: "INVALID_REQUEST",
			message: "Relay Key was rejected. Check it and try again.",
			retryable: false,
		});
		expect(store.replace).not.toHaveBeenCalled();
	});

	it("returns a conflict without a second audit for a transactionally audited stale version", async () => {
		const { app, store } = fixture();
		store.replace.mockResolvedValueOnce(null);
		const response = await app.request(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: replaceBody,
		});
		expect(response.status).toBe(409);
		expect(store.recordRejected).not.toHaveBeenCalled();
		expect(JSON.stringify(await response.json())).not.toContain(keyValue);
	});
});
