import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerUserGovernanceRoutes } from "./user-governance-routes.js";

const administratorId = "e8c99945-5b39-4bcb-8f99-c29a7788432f";
const targetId = "3c96bbeb-50ae-4da3-8b6f-f0757d0bd8b8";
const path = `/api/v2/admin/users/${targetId}/disable`;
const body = JSON.stringify({ schemaVersion: 1, disabled: true });

function storeError(code: string): Error {
	const error = new Error("Platform user governance is unavailable");
	error.name = "PlatformUserDisableError";
	Object.assign(error, { code });
	return error;
}

function fixture(role: "system_admin" | "employee" = "system_admin") {
	const setPlatformDisabled = vi.fn(async () => true);
	const isPlatformDisabled = vi.fn(async () => false);
	const app = new Hono();
	registerUserGovernanceRoutes(app, {
		identity: {
			async resolve() {
				return {
					schemaVersion: 1,
					userId: administratorId,
					displayName: "Administrator",
					accountStatus: "active",
					organizationIds: [],
					roles:
						role === "employee" ? ["employee"] : ["employee", "system_admin"],
					authorizationRevision: "directory-revision-1",
				};
			},
			async hydrateUsers() {
				return [];
			},
		},
		users: { isPlatformDisabled, setPlatformDisabled },
	});
	return { app, isPlatformDisabled, setPlatformDisabled };
}

describe("Platform user governance HTTP", () => {
	it("submits the trusted administrator and target to the audited Store", async () => {
		const { app, setPlatformDisabled } = fixture();
		const response = await app.request(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			userId: targetId,
			disabled: true,
			changed: true,
			auditOutcome: "recorded",
		});
		expect(setPlatformDisabled).toHaveBeenCalledWith(
			expect.objectContaining({
				actorUserId: administratorId,
				targetUserId: targetId,
				disabled: true,
				traceId: expect.any(String),
			}),
		);
	});

	it("reads the durable status through the same administrator gate", async () => {
		const { app, isPlatformDisabled } = fixture();
		isPlatformDisabled.mockResolvedValueOnce(true);
		const response = await app.request(path, { method: "GET" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			schemaVersion: 1,
			userId: targetId,
			disabled: true,
		});
		expect(isPlatformDisabled).toHaveBeenCalledWith(targetId);
	});

	it("normalizes an uppercase UUID accepted by the public path contract", async () => {
		const { app, isPlatformDisabled, setPlatformDisabled } = fixture();
		const uppercaseTarget = targetId.toUpperCase();
		isPlatformDisabled.mockResolvedValueOnce(false);
		const read = await app.request(
			`/api/v2/admin/users/${uppercaseTarget}/disable`,
			{ method: "GET" },
		);
		expect(read.status).toBe(200);
		expect(isPlatformDisabled).toHaveBeenCalledWith(targetId);
		const write = await app.request(
			`/api/v2/admin/users/${uppercaseTarget}/disable`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body,
			},
		);
		expect(write.status).toBe(200);
		expect(setPlatformDisabled).toHaveBeenCalledWith(
			expect.objectContaining({ targetUserId: targetId }),
		);
	});

	it("rejects bearer, non-admin and invalid requests before a write", async () => {
		const { app, setPlatformDisabled } = fixture("employee");
		const request = (target: string, requestBody = body, bearer = false) =>
			app.request(target, {
				method: "PUT",
				headers: {
					"content-type": "application/json",
					...(bearer ? { authorization: "Bearer synthetic" } : {}),
				},
				body: requestBody,
			});
		expect((await request(path, body, true)).status).toBe(401);
		expect((await request(path)).status).toBe(403);
		expect(setPlatformDisabled).not.toHaveBeenCalled();
		const admin = fixture();
		expect(
			(
				await admin.app.request("/api/v2/admin/users/not-a-uuid/disable", {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body,
				})
			).status,
		).toBe(400);
		expect(
			(
				await admin.app.request(path, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ schemaVersion: 1, disabled: "yes" }),
				})
			).status,
		).toBe(400);
		expect(admin.setPlatformDisabled).not.toHaveBeenCalled();
		expect((await app.request(path, { method: "GET" })).status).toBe(403);
	});

	it("maps current-authority and storage failures without leaking details", async () => {
		const { app, setPlatformDisabled } = fixture();
		setPlatformDisabled.mockRejectedValueOnce(storeError("not_authorized"));
		const request = () =>
			app.request(path, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body,
			});
		expect((await request()).status).toBe(403);
		setPlatformDisabled.mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		expect((await request()).status).toBe(503);
	});
});
