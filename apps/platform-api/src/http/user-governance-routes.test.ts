import {
	ApiIdentityError,
	createPlatformUserGovernanceUseCaseV1,
} from "@agent-infra/platform-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { registerUserGovernanceRoutes } from "./user-governance-routes.js";

const administratorId = "e8c99945-5b39-4bcb-8f99-c29a7788432f";
const targetId = "3c96bbeb-50ae-4da3-8b6f-f0757d0bd8b8";
const path = `/api/v2/admin/users/${targetId}/disable`;
const body = JSON.stringify({ schemaVersion: 1, disabled: true });

function fixture(role: "system_admin" | "employee" = "system_admin") {
	const setPlatformDisabled = vi.fn(async () => true);
	const recordRejected = vi.fn(async () => {});
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
		governance: createPlatformUserGovernanceUseCaseV1({
			setPlatformDisabled,
			recordRejected,
		}),
	});
	return { app, setPlatformDisabled, recordRejected };
}

describe("Platform user governance HTTP", () => {
	it("submits the trusted administrator and target to the audited Store", async () => {
		const { app, setPlatformDisabled } = fixture();
		const response = await app.request(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(response.status).toBe(204);
		expect(setPlatformDisabled).toHaveBeenCalledWith(
			expect.objectContaining({
				actorUserId: administratorId,
				targetUserId: targetId,
				disabled: true,
				traceId: expect.any(String),
			}),
		);
	});

	it("rejects bearer, non-admin and invalid requests before a write", async () => {
		const { app, setPlatformDisabled, recordRejected } = fixture("employee");
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
		expect(recordRejected).toHaveBeenCalledTimes(2);
		expect(recordRejected).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				actorUserId: null,
				targetUserId: null,
				reason: "AUTHENTICATION_REQUIRED",
			}),
		);
		expect(recordRejected).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				actorUserId: administratorId,
				targetUserId: targetId,
				reason: "RESOURCE_UNAVAILABLE",
				outcome: "rejected",
			}),
		);
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
		expect(admin.recordRejected).toHaveBeenCalledTimes(2);
		expect(admin.recordRejected).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				actorUserId: administratorId,
				targetUserId: targetId,
				reason: "INVALID_REQUEST",
			}),
		);
	});

	it("fails closed on a stale administrator or unavailable Store", async () => {
		const { app, setPlatformDisabled, recordRejected } = fixture();
		setPlatformDisabled.mockRejectedValueOnce(
			new ApiIdentityError("not_authorized"),
		);
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
		expect(recordRejected).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				actorUserId: administratorId,
				targetUserId: targetId,
				outcome: "rejected",
			}),
		);
		expect(recordRejected).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ outcome: "failed" }),
		);
	});

	it("returns 503 if a rejected governance request cannot be audited", async () => {
		const { app, recordRejected } = fixture("employee");
		recordRejected.mockRejectedValueOnce(new Error("audit unavailable"));
		const response = await app.request(path, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(response.status).toBe(503);
		expect(JSON.stringify(await response.json())).not.toContain(
			"audit unavailable",
		);
	});
});
