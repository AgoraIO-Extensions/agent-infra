import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerSkillHubImportRoutesV1 } from "./skill-hub-import-routes.js";

describe("Skill Hub Provider import HTTP", () => {
	it("accepts only server-selected import metadata", async () => {
		const importer = vi.fn().mockResolvedValue({
			replayed: false,
			version: {
				schemaVersion: 1,
				skillId: "skill-a",
				skillVersionId: "version-a",
				ownerId: "owner-a",
				visibility: "PRIVATE",
				provider: "github",
				version: "1.0.0",
				packageObjectVersion: "v1",
				packageDigest: "a".repeat(64),
				manifestDigest: "b".repeat(64),
				signatureDigest: "c".repeat(64),
				state: "pending_review",
				needUpgrade: false,
				reviewedBy: null,
				reviewReason: null,
				revokedAt: null,
			},
		});
		const app = new Hono();
		registerSkillHubImportRoutesV1(app, {
			identity: {
				resolve: async () => ({
					schemaVersion: 1,
					userId: "owner-a",
					displayName: "Owner",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "r1",
				}),
				hydrateUsers: async () => [],
			},
			importer: { importVersion: importer },
		});
		const response = await app.request("/api/v2/skills/imports", {
			method: "POST",
			headers: {
				cookie: "session=owner",
				"Idempotency-Key": "import-a",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				schemaVersion: 1,
				name: "hello",
				provider: "github",
				version: "1.0.0",
			}),
		});
		expect(response.status).toBe(201);
		expect(importer).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "owner-a" }),
			"import-a",
			expect.objectContaining({ provider: "github" }),
		);
	});

	it("rejects client supplied archive and trust claims", async () => {
		const app = new Hono();
		const importer = vi.fn();
		registerSkillHubImportRoutesV1(app, {
			identity: {
				resolve: async () => ({
					schemaVersion: 1,
					userId: "owner-a",
					displayName: "Owner",
					accountStatus: "active",
					organizationIds: [],
					roles: ["employee"],
					authorizationRevision: "r1",
				}),
				hydrateUsers: async () => [],
			},
			importer: { importVersion: importer },
		});
		const response = await app.request("/api/v2/skills/imports", {
			method: "POST",
			headers: {
				cookie: "session=owner",
				"Idempotency-Key": "import-a",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				schemaVersion: 1,
				name: "hello",
				provider: "github",
				version: "1.0.0",
				archiveBytes: "secret",
				trustRevision: "caller",
			}),
		});
		expect(response.status).toBe(400);
		expect(importer).not.toHaveBeenCalled();
	});
});
