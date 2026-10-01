import { once } from "node:events";
import { PersonalApiCredentialErrorV1 } from "@agent-infra/platform-core";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PersonalApiCredentialIssueRequestV1 } from "../../../web/src/pilot/generated-v2/types.gen.ts";
import { registerPersonalApiCredentialRoutes } from "./personal-api-credential-routes.ts";

const metadata = {
	credentialId: "api_credential_fixture",
	scopes: ["agent:read"] as const,
	expiresAt: null,
	revokedAt: null,
	createdAt: "2030-01-01T00:00:00.000Z",
	lastUsedAt: null,
};
const material = `papi_${"a".repeat(43)}`;
const identity = {
	schemaVersion: 1,
	userId: "user_alice",
	displayName: "Alice",
	accountStatus: "active",
	organizationIds: [],
	roles: ["employee"],
	authorizationRevision: "revision_1",
};
function setup() {
	const dependencies = {
		identity: {
			resolve: vi.fn(async () => identity),
			hydrateUsers: vi.fn(async () => []),
		},
		credentials: {
			issue: vi.fn(async () => ({
				metadata,
				credential: material as string | null,
				replayed: false,
			})),
			revoke: vi.fn(async () => ({
				metadata: { ...metadata, revokedAt: "2030-01-01T01:00:00.000Z" },
				replayed: false,
			})),
			recordRefusal: vi.fn(async () => {}),
		},
	};
	const app = new Hono();
	registerPersonalApiCredentialRoutes(app, dependencies);
	return { app, ...dependencies };
}
function issue(
	headers: Record<string, string> = {},
	body: unknown = { scopes: ["agent:read"], expiresAt: null },
) {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "issue.1",
			Cookie: "browser_fixture",
			...headers,
		},
		body: JSON.stringify(body),
	};
}

describe("personal credential HTTP protocol", () => {
	it("keeps the generated expiry request field string or null", () => {
		expectTypeOf<
			PersonalApiCredentialIssueRequestV1["expiresAt"]
		>().toEqualTypeOf<string | null>();
	});

	it("accepts generated SDK DELETE with an empty network stream and rejects actual payload", async () => {
		const { app, credentials } = setup();
		const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		try {
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Missing loopback listener");
			const baseUrl = `http://127.0.0.1:${address.port}`;
			const { createClient } = await import(
				new URL(
					"../../../web/src/pilot/generated-v2/client/index.ts",
					import.meta.url,
				).href
			);
			const { revokePersonalApiCredentialV2 } = await import(
				new URL("../../../web/src/pilot/generated-v2/index.ts", import.meta.url)
					.href
			);
			const result = await revokePersonalApiCredentialV2({
				client: createClient({ baseUrl }),
				path: { credentialId: metadata.credentialId },
				headers: { "Idempotency-Key": "revoke.1", Cookie: "browser_fixture" },
			});
			expect(result.response.status).toBe(200);
			expect(result.data.metadata.credentialId).toBe(metadata.credentialId);
			expect(credentials.revoke).toHaveBeenCalledTimes(1);
			const denied = await fetch(
				`${baseUrl}/api/v2/me/api-credentials/${metadata.credentialId}`,
				{
					method: "DELETE",
					headers: { "Idempotency-Key": "revoke.2" },
					body: " ",
				},
			);
			expect(denied.status).toBe(400);
			expect(credentials.revoke).toHaveBeenCalledTimes(1);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("keeps a verified browser actor in protocol refusal audits", async () => {
		const { app, credentials } = setup();
		const response = await app.request(
			"/api/v2/me/api-credentials",
			issue({}, { scopes: [], expiresAt: null }),
		);
		expect(response.status).toBe(400);
		expect(credentials.recordRefusal).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: expect.any(String),
				traceId: expect.any(String),
			}),
			"api.credential.issued",
			"invalid_input",
			identity.userId,
		);
	});
	it("delivers material once and marks both delivery and replay as no-store", async () => {
		const { app, credentials } = setup();
		const first = await app.request("/api/v2/me/api-credentials", issue());
		expect(first.status).toBe(201);
		expect(first.headers.get("Cache-Control")).toBe("no-store");
		expect(await first.json()).toEqual({
			metadata,
			credential: material,
			replayed: false,
		});
		expect(credentials.issue).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: identity.userId,
				idempotencyKey: "issue.1",
			}),
			{ scopes: ["agent:read"], expiresAt: null },
		);
		credentials.issue.mockResolvedValue({
			metadata,
			credential: null,
			replayed: true,
		});
		const replay = await app.request("/api/v2/me/api-credentials", issue());
		expect(replay.status).toBe(200);
		expect(replay.headers.get("Cache-Control")).toBe("no-store");
		expect(await replay.json()).toEqual({
			metadata,
			credential: null,
			replayed: true,
		});
	});

	it.each(["", "Bearer RAW_SENTINEL", "Basic RAW_SENTINEL"])(
		"rejects any Authorization header before resolving browser identity",
		async (authorization) => {
			const { app, identity: adapter, credentials } = setup();
			for (const [path, init] of [
				["/api/v2/me/api-credentials", issue({ Authorization: authorization })],
				[
					"/api/v2/me/api-credentials/api_credential_fixture",
					{
						method: "DELETE",
						headers: {
							Cookie: "browser_fixture",
							Authorization: authorization,
							"Idempotency-Key": "revoke.1",
						},
					},
				],
			] as const) {
				const response = await app.request(path, init);
				expect(response.status).toBe(401);
				expect(await response.text()).not.toContain("RAW_SENTINEL");
				expect(response.headers.get("Cache-Control")).toBe("no-store");
			}
			expect(adapter.resolve).not.toHaveBeenCalled();
			expect(credentials.issue).not.toHaveBeenCalled();
			expect(credentials.revoke).not.toHaveBeenCalled();
			expect(credentials.recordRefusal).toHaveBeenCalledTimes(2);
			expect(
				JSON.stringify(credentials.recordRefusal.mock.calls),
			).not.toContain("RAW_SENTINEL");
		},
	);

	it.each(["principal", "userId", "applicationId", "recipient", "role"])(
		"rejects body and query override %s",
		async (field) => {
			const { app, credentials } = setup();
			expect(
				(
					await app.request(
						"/api/v2/me/api-credentials",
						issue(
							{},
							{
								scopes: ["agent:read"],
								expiresAt: null,
								[field]: "SELF_REPORTED_SENTINEL",
							},
						),
					)
				).status,
			).toBe(400);
			expect(
				(
					await app.request(
						`/api/v2/me/api-credentials?${field}=SELF_REPORTED_SENTINEL`,
						issue(),
					)
				).status,
			).toBe(400);
			expect(credentials.issue).not.toHaveBeenCalled();
			expect(
				JSON.stringify(credentials.recordRefusal.mock.calls),
			).not.toContain("SELF_REPORTED_SENTINEL");
		},
	);

	it("maps current governance refusal and dependency failure to sanitized protocol errors", async () => {
		for (const [code, status, wireCode] of [
			["not_found", 404, "RESOURCE_UNAVAILABLE"],
			["forbidden", 403, "AUTHORIZATION_REVOKED"],
			["idempotency_conflict", 409, "INVALID_REQUEST"],
			["unavailable", 503, "DEPENDENCY_UNAVAILABLE"],
		] as const) {
			const { app, credentials } = setup();
			credentials.revoke.mockRejectedValue(
				new PersonalApiCredentialErrorV1(code),
			);
			const response = await app.request(
				"/api/v2/me/api-credentials/api_credential_fixture",
				{ method: "DELETE", headers: { "Idempotency-Key": "revoke.1" } },
			);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ code: wireCode });
			expect(credentials.recordRefusal).not.toHaveBeenCalled();
		}
	});

	it("keeps a pre-authentication refusal denied when its audit writer fails", async () => {
		const { app, credentials } = setup();
		credentials.recordRefusal.mockRejectedValue(
			new Error("SECRET_AUDIT_SENTINEL"),
		);
		const response = await app.request(
			"/api/v2/me/api-credentials",
			issue({ Authorization: "Bearer RAW_SENTINEL" }),
		);
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain("SECRET_AUDIT_SENTINEL");
	});
});
