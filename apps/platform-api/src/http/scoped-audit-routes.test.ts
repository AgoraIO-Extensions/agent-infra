import {
	PersonalApiCredentialErrorV1,
	PlatformAuditScopeErrorV1,
	parsePlatformAuditQueryInputV1,
} from "@agent-infra/platform-core";
import type { PostgresScopedPlatformAuditQueryV1 } from "@agent-infra/platform-store";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { HttpProtocolError } from "./common.js";
import { registerScopedAuditRoutes } from "./scoped-audit-routes.js";

type QueryIdentity = Parameters<
	PostgresScopedPlatformAuditQueryV1["listAudit"]
>[0];

const currentUser = {
	schemaVersion: 1 as const,
	userId: "subject-a",
	accountStatus: "active" as const,
	organizationIds: ["org-a"],
	authorizationRevision: "directory-current",
};
const browser = {
	...currentUser,
	displayName: "User A",
	roles: ["employee" as const],
};
const api = {
	schemaVersion: 1,
	principal: { kind: "application", id: currentUser.userId },
	accountStatus: "active",
	organizationIds: [],
	authorizationRevision: "application-current",
	ownerId: "responsible-user",
	credential: {
		schemaVersion: 1,
		credentialId: "credential-a",
		principal: { kind: "application", id: currentUser.userId },
		scopes: ["agent:use"],
		expiresAt: null,
		revokedAt: null,
		createdAt: new Date("2026-09-01T00:00:00Z"),
	},
};
const item = {
	schemaVersion: 1 as const,
	auditId: "audit-a",
	action: "task.status.changed" as const,
	actor: { kind: "system" as const, actorId: "worker-a" },
	subject: { kind: "execution" as const, subjectId: "execution-a" },
	result: "unknown" as const,
	summary: "task.status.changed",
	taskApi: null,
	occurredAt: new Date("2026-09-26T00:00:00Z"),
	traceId: "original-trace-a",
	requestId: "original-request-a",
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	authorizationRecordId: "authorization-a",
	originalPrincipal: { kind: "user" as const, id: currentUser.userId },
	executor: "platform_worker" as const,
	operation: null,
};

function fixture() {
	const identity = {
		resolve: vi.fn().mockResolvedValue(browser),
		hydrateUsers: vi.fn(),
		resolveUser: vi.fn().mockResolvedValue(currentUser),
		resolveApiCredential: vi.fn().mockResolvedValue(api),
	};
	const audit = {
		recordDeniedQuery: vi.fn(async (_input: unknown, _metadata: unknown) => {}),
		listAudit: vi.fn(
			async (
				scope: QueryIdentity,
				input: unknown,
				_metadata: unknown,
			): Promise<
				Awaited<ReturnType<PostgresScopedPlatformAuditQueryV1["listAudit"]>>
			> => {
				if (scope.kind === "api-credential")
					throw new PersonalApiCredentialErrorV1("authentication_required");
				parsePlatformAuditQueryInputV1(input, scope);
				return { items: [item], nextCursor: "next-cursor" };
			},
		),
		getAudit: vi.fn(
			async (
				_scope: QueryIdentity,
				_id: string,
				_input: unknown,
				_metadata: unknown,
			) => item,
		),
	};
	const app = new Hono();
	app.onError((error, context) =>
		error instanceof HttpProtocolError
			? context.json(error.body, error.status)
			: context.json({ code: "unexpected" }, 500),
	);
	registerScopedAuditRoutes(app, { identity, audit });
	return { app, identity, audit };
}

describe("scoped audit HTTP adapter", () => {
	it("passes one own-audit Bearer to the Store without resolving a browser or trusting filters", async () => {
		const { app, identity, audit } = fixture();
		const material = `papi_${"a".repeat(43)}`;
		audit.listAudit.mockResolvedValueOnce({ items: [], nextCursor: null });
		const response = await app.request(
			"/api/v1/audit?principalKind=user&principalId=forged",
			{
				headers: { authorization: `Bearer ${material}` },
			},
		);
		expect(response.status).toBe(200);
		const source = audit.listAudit.mock.calls[0]?.[0];
		expect(source).toMatchObject({ kind: "api-credential", material });
		expect(source).not.toHaveProperty("principal");
		if (source?.kind !== "api-credential")
			throw new Error("Missing transient source");
		await source.userDirectory?.resolveUser("resolved-subject");
		expect(identity.resolveUser).toHaveBeenCalledExactlyOnceWith(
			"resolved-subject",
		);
		expect(identity.resolve).not.toHaveBeenCalled();
		expect(identity.resolveApiCredential).not.toHaveBeenCalled();
		expect(JSON.stringify(await response.json())).not.toContain(material);
	});

	it("rejects a valid-format Bearer on the administrator route without browser fallback", async () => {
		const { app, identity, audit } = fixture();
		const response = await app.request("/api/v3/admin/audit", {
			headers: { authorization: `Bearer papi_${"a".repeat(43)}` },
		});
		expect(response.status).toBe(401);
		expect(identity.resolve).not.toHaveBeenCalled();
		expect(audit.listAudit).not.toHaveBeenCalled();
	});

	it("maps Store credential rejection without accepting a browser identity", async () => {
		const { app, identity, audit } = fixture();
		audit.listAudit.mockRejectedValueOnce(
			new PersonalApiCredentialErrorV1("forbidden"),
		);
		const response = await app.request("/api/v1/audit", {
			headers: { authorization: `Bearer papi_${"a".repeat(43)}` },
		});
		expect(response.status).toBe(404);
		expect(identity.resolve).not.toHaveBeenCalled();
	});
	it("audits a trusted non-administrator rejection without recording request fields", async () => {
		const { app, audit } = fixture();
		const response = await app.request(
			"/api/v3/admin/audit?principalId=PRIVATE_FILTER_SENTINEL",
		);
		expect(response.status).toBe(404);
		expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
			{
				principal: { kind: "user", id: currentUser.userId },
				requestedScope: "administrator",
				operation: "list",
				result: "rejected",
				reason: "RESOURCE_UNAVAILABLE",
			},
			expect.objectContaining({
				requestId: expect.any(String),
				traceId: expect.any(String),
			}),
		);
		expect(JSON.stringify(audit.recordDeniedQuery.mock.calls)).not.toContain(
			"PRIVATE_FILTER_SENTINEL",
		);
		expect(audit.listAudit).not.toHaveBeenCalled();
	});

	it("resolves current browser facts and forwards six filters and request metadata", async () => {
		const { app, identity, audit } = fixture();
		const response = await app.request(
			"/api/v1/audit?limit=5&from=2026-09-25T00%3A00%3A00Z&until=2026-09-26T00%3A00%3A00Z&principalKind=user&principalId=subject-a&agentId=agent-a&action=task.status.changed&result=unknown&executionId=execution-a",
			{
				headers: { "x-user-id": "forged-user" },
			},
		);
		expect(response.status).toBe(200);
		expect(identity.resolveUser).toHaveBeenCalledWith(currentUser.userId);
		expect(audit.listAudit).toHaveBeenCalledWith(
			{
				kind: "execution",
				principal: { kind: "user", id: currentUser.userId },
				user: currentUser,
			},
			expect.objectContaining({
				limit: 5,
				filters: expect.objectContaining({
					principal: { kind: "user", id: currentUser.userId },
					result: "unknown",
				}),
			}),
			expect.objectContaining({
				requestId: expect.any(String),
				traceId: expect.any(String),
			}),
		);
		expect(await response.json()).toMatchObject({
			items: [
				{
					result: "unknown",
					executor: "platform_worker",
					occurredAt: "2026-09-26T00:00:00.000Z",
					actor: { actorId: "worker-a" },
					originalPrincipal: item.originalPrincipal,
				},
			],
			nextCursor: "next-cursor",
		});
		expect(identity.hydrateUsers).not.toHaveBeenCalled();
	});

	it.skip("application credential identity awaits #481 owner contract", async () => {
		const { app, identity, audit } = fixture();
		const response = await app.request("/api/v1/audit", {
			headers: { authorization: "Bearer synthetic-credential" },
		});
		expect(response.status).toBe(200);
		expect(audit.listAudit.mock.calls[0]?.[0]).toMatchObject({
			kind: "execution",
			principal: api.principal,
			credential: api.credential,
		});
		expect(identity.resolve).not.toHaveBeenCalled();
		expect(identity.resolveUser).not.toHaveBeenCalled();
	});

	it("does not fall back to a browser session after a rejected bearer", async () => {
		const { app, identity, audit } = fixture();
		identity.resolveApiCredential.mockResolvedValue(null);
		const response = await app.request("/api/v1/audit", {
			headers: { authorization: "Bearer invalid-credential" },
		});
		expect(response.status).toBe(401);
		expect(identity.resolve).not.toHaveBeenCalled();
		expect(audit.listAudit).not.toHaveBeenCalled();
		expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
			{
				principal: null,
				requestedScope: "execution",
				operation: "list",
				result: "rejected",
				reason: "AUTHENTICATION_REQUIRED",
			},
			expect.objectContaining({ requestId: expect.any(String) }),
		);
		expect(JSON.stringify(audit.recordDeniedQuery.mock.calls)).not.toContain(
			"invalid-credential",
		);
	});

	it.skip.each([
		{ ...api, accountStatus: "disabled" },
		{
			...api,
			credential: {
				...api.credential,
				revokedAt: new Date("2026-09-01T00:00:00Z"),
			},
		},
		{
			...api,
			credential: {
				...api.credential,
				expiresAt: new Date("2026-09-01T00:00:00Z"),
			},
		},
	])(
		"audits the existing revoked authorization code without guessing its underlying cause",
		async (subject) => {
			const { app, identity, audit } = fixture();
			identity.resolveApiCredential.mockResolvedValue(subject);
			const response = await app.request("/api/v1/audit", {
				headers: { authorization: "Bearer PRIVATE_CREDENTIAL" },
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "AUTHORIZATION_REVOKED",
			});
			expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
				{
					principal: null,
					requestedScope: "execution",
					operation: "list",
					result: "rejected",
					reason: "AUTHORIZATION_REVOKED",
				},
				expect.any(Object),
			);
			expect(JSON.stringify(audit.recordDeniedQuery.mock.calls)).not.toContain(
				"PRIVATE",
			);
			expect(audit.listAudit).not.toHaveBeenCalled();
		},
	);

	it.skip("application credential scope awaits #481 owner contract", async () => {
		const { app, identity, audit } = fixture();
		identity.resolveApiCredential.mockResolvedValue({
			...api,
			credential: { ...api.credential, scopes: ["agent:manage"] },
		});
		const response = await app.request(
			"/api/v1/audit/PRIVATE_AUDIT_ID?agentId=PRIVATE_FILTER",
			{ headers: { authorization: "Bearer PRIVATE_CREDENTIAL" } },
		);
		expect(response.status).toBe(404);
		expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
			{
				principal: api.principal,
				requestedScope: "execution",
				operation: "detail",
				result: "rejected",
				reason: "access_denied",
			},
			expect.objectContaining({ traceId: expect.any(String) }),
		);
		expect(JSON.stringify(audit.recordDeniedQuery.mock.calls)).not.toContain(
			"PRIVATE_",
		);
		expect(audit.getAudit).not.toHaveBeenCalled();
	});

	it("audits directory failure after trusted browser identity resolution", async () => {
		const { app, identity, audit } = fixture();
		identity.resolveUser.mockRejectedValue(new Error("PRIVATE_DIRECTORY"));
		const response = await app.request("/api/v1/audit");
		expect(response.status).toBe(503);
		expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
			{
				principal: { kind: "user", id: currentUser.userId },
				requestedScope: "execution",
				operation: "list",
				result: "failed",
				reason: "DEPENDENCY_UNAVAILABLE",
			},
			expect.objectContaining({ traceId: expect.any(String) }),
		);
		expect(await response.text()).not.toContain("PRIVATE_DIRECTORY");
		expect(audit.listAudit).not.toHaveBeenCalled();
	});

	it("does not trust an identity from a malformed adapter response", async () => {
		const { app, identity, audit } = fixture();
		identity.resolve.mockResolvedValue({ userId: "PRIVATE_UNVERIFIED_USER" });
		const response = await app.request("/api/v3/admin/audit");
		expect(response.status).toBe(503);
		expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
			{
				principal: null,
				requestedScope: "administrator",
				operation: "list",
				result: "failed",
				reason: "DEPENDENCY_UNAVAILABLE",
			},
			expect.any(Object),
		);
		expect(JSON.stringify(audit.recordDeniedQuery.mock.calls)).not.toContain(
			"PRIVATE_UNVERIFIED_USER",
		);
	});

	it("keeps access denied with a sanitized 503 when denial audit cannot persist", async () => {
		const { app, identity, audit } = fixture();
		identity.resolveApiCredential.mockResolvedValue(null);
		audit.recordDeniedQuery.mockRejectedValue(new Error("PRIVATE_AUDIT_ERROR"));
		const response = await app.request("/api/v1/audit", {
			headers: { authorization: "Bearer PRIVATE_CREDENTIAL" },
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "DEPENDENCY_UNAVAILABLE",
		});
		expect(audit.recordDeniedQuery).toHaveBeenCalledOnce();
		expect(audit.listAudit).not.toHaveBeenCalled();
		expect(identity.resolve).not.toHaveBeenCalled();
	});

	it("requires a trusted administrator role", async () => {
		const { app, identity, audit } = fixture();
		expect((await app.request("/api/v3/admin/audit")).status).toBe(404);
		expect(audit.listAudit).not.toHaveBeenCalled();
		identity.resolve.mockResolvedValue({
			...browser,
			roles: ["employee", "system_admin"],
		});
		expect((await app.request("/api/v3/admin/audit")).status).toBe(200);
		expect(audit.listAudit.mock.calls[0]?.[0]).toEqual({
			kind: "administrator",
			administratorId: currentUser.userId,
		});
	});

	it("does not fall through to a browser session for an administrator bearer", async () => {
		const { app, identity, audit } = fixture();
		const response = await app.request("/api/v3/admin/audit", {
			headers: { authorization: "Bearer invalid-credential" },
		});
		expect(response.status).toBe(401);
		expect(identity.resolve).not.toHaveBeenCalled();
		expect(audit.listAudit).not.toHaveBeenCalled();
		expect(audit.recordDeniedQuery).toHaveBeenCalledExactlyOnceWith(
			{
				principal: null,
				requestedScope: "administrator",
				operation: "list",
				result: "rejected",
				reason: "AUTHENTICATION_REQUIRED",
			},
			expect.objectContaining({ traceId: expect.any(String) }),
		);
		expect(JSON.stringify(audit.recordDeniedQuery.mock.calls)).not.toContain(
			"invalid-credential",
		);
	});

	it.each([
		"?ownerId=other-user",
		"?principalKind=user",
		"?limit=10&limit=20",
		"?action=caller-invented-action",
	])(
		"forwards malformed transport for domain rejection and query auditing: %s",
		async (query) => {
			const { app, audit } = fixture();
			const response = await app.request(`/api/v1/audit${query}`);
			expect(response.status).toBe(400);
			expect(audit.listAudit).toHaveBeenCalledOnce();
		},
	);

	it("uses the same filter and scope path for detail", async () => {
		const { app, audit } = fixture();
		expect(
			(await app.request("/api/v1/audit/audit-a?agentId=agent-a")).status,
		).toBe(200);
		expect(audit.getAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: { kind: "user", id: currentUser.userId },
			}),
			"audit-a",
			{ limit: 1, filters: { agentId: "agent-a" } },
			expect.objectContaining({ traceId: expect.any(String) }),
		);
	});

	it("maps absent and inaccessible detail to the same sanitized error", async () => {
		const { app, audit } = fixture();
		audit.getAudit.mockRejectedValue(
			new PlatformAuditScopeErrorV1("access_denied"),
		);
		const response = await app.request("/api/v1/audit/other-audit");
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({
			code: "RESOURCE_UNAVAILABLE",
		});
		expect(audit.recordDeniedQuery).not.toHaveBeenCalled();
	});

	it("reports persistence failure without an empty successful page or private diagnostics", async () => {
		const { app, audit } = fixture();
		audit.listAudit.mockRejectedValue(
			new Error("private database SENSITIVE_SENTINEL"),
		);
		const response = await app.request("/api/v1/audit");
		expect(response.status).toBe(503);
		expect(await response.text()).not.toMatch(
			/SENSITIVE_SENTINEL|items|nextCursor/,
		);
		expect(audit.recordDeniedQuery).not.toHaveBeenCalled();
	});
});
