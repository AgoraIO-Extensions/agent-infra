import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerSkillHubPublicationRoutesV1 } from "./skill-hub-publication-routes.js";

const version = {
	schemaVersion: 1 as const,
	skillId: "skill-a",
	skillVersionId: "skill-version-a",
	ownerId: "owner-a",
	visibility: "MEMBER" as const,
	provider: "my_library" as const,
	version: "1.0.0",
	packageObjectVersion: "opaque-object-version",
	packageDigest: "a".repeat(64),
	manifestDigest: "b".repeat(64),
	signatureDigest: "c".repeat(64),
	state: "pending_review" as const,
	needUpgrade: false,
	reviewedBy: null,
	reviewReason: null,
	revokedAt: null,
};

function fixture() {
	const app = new Hono();
	const publish = vi.fn().mockResolvedValue({ replayed: false, version });
	const review = vi.fn().mockResolvedValue({
		replayed: false,
		version: { ...version, state: "published", reviewedBy: "admin" },
	});
	const revoke = vi.fn().mockResolvedValue({
		replayed: false,
		version: {
			...version,
			state: "revoked",
			revokedAt: new Date().toISOString(),
		},
	});
	registerSkillHubPublicationRoutesV1(app, {
		identity: {
			resolve: vi.fn(async () => ({
				schemaVersion: 1,
				userId: "owner-a",
				displayName: "Owner",
				accountStatus: "active",
				organizationIds: [],
				roles: ["employee"],
				authorizationRevision: "r1",
			})),
			hydrateUsers: async () => [],
		},
		publish,
		review,
		revoke,
	});
	return { app, publish, review, revoke };
}

describe("Skill Hub publication HTTP", () => {
	it("publishes without returning object storage location", async () => {
		const f = fixture();
		const requestBody = {
			schemaVersion: 1,
			name: "skill-a",
			skillId: version.skillId,
			skillVersionId: version.skillVersionId,
			visibility: version.visibility,
			provider: version.provider,
			version: version.version,
			packageObjectVersion: version.packageObjectVersion,
			packageDigest: version.packageDigest,
			manifestDigest: version.manifestDigest,
			signatureDigest: version.signatureDigest,
		};
		const response = await f.app.request("/api/v2/skills/versions", {
			method: "POST",
			headers: {
				cookie: "session=owner",
				"Idempotency-Key": "publish-1",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			version: Record<string, unknown>;
		};
		expect(body.version).not.toHaveProperty("packageObjectVersion");
		expect(f.publish).toHaveBeenCalledOnce();
	});

	it("routes review and revoke with the version id and idempotency key", async () => {
		const f = fixture();
		const headers = {
			cookie: "session=admin",
			"Idempotency-Key": "review-1",
			"Content-Type": "application/json",
		};
		const reviewed = await f.app.request(
			"/api/v2/skills/versions/skill-version-a/review",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ decision: "approve" }),
			},
		);
		expect(reviewed.status).toBe(200);
		expect(f.review).toHaveBeenCalledWith(
			expect.any(Request),
			expect.objectContaining({ userId: "owner-a" }),
			"skill-version-a",
			"review-1",
			{ decision: "approve" },
		);
		const revoked = await f.app.request(
			"/api/v2/skills/versions/skill-version-a/revoke",
			{
				method: "POST",
				headers: { cookie: "session=admin", "Idempotency-Key": "revoke-1" },
			},
		);
		expect(revoked.status).toBe(200);
		expect(f.revoke).toHaveBeenCalledOnce();
	});
});
