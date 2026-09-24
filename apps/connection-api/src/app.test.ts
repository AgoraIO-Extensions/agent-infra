import type {
	CatalogEntry,
	ConnectionTokenService,
	InstallationStore,
	OAuthAuthorizationService,
} from "@agent-infra/connection-core";
import type { BrowserSessionService } from "@agent-infra/connection-identity";
import { describe, expect, it, vi } from "vitest";

import { createConnectionApp } from "./app";

describe("Connection API health", () => {
	it("reports the independent service as ready", async () => {
		const response = await createConnectionApp().request("/healthz");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			service: "connection-api",
			status: "ok",
		});
	});
});

const catalogEntries: readonly CatalogEntry[] = [
	{
		provider: { id: "github", name: "GitHub", status: "active" },
		actionVersion: {
			id: "github.get_current_user@1",
			actionId: "github.get_current_user",
			version: "1",
			effect: "read",
			inputSchema: { type: "object", additionalProperties: false },
			outputSchema: { type: "object" },
			requiredScopes: ["github:read"],
			status: "published",
		},
	},
];

describe("authenticated catalog", () => {
	it("resolves identity server-side and exposes only the read-only contract", async () => {
		let received: unknown;
		const app = createConnectionApp({
			audience: "connection-mcp",
			authenticate: async (input) => {
				received = input;
				return {
					principalId: "principal-alice",
					consumerId: "consumer-mcp",
					consumerInstanceId: "instance-alice",
					actorId: null,
					audience: "connection-mcp",
					scopes: ["catalog:read"],
					recoveryGeneration: 1,
					tokenId: "token-1",
				};
			},
			catalog: { list: async () => catalogEntries },
		});
		const response = await app.request("/v1/catalog", {
			headers: { authorization: "Bearer opaque-token", DPoP: "proof" },
		});
		expect(response.status).toBe(200);
		expect(received).toMatchObject({
			token: "opaque-token",
			proof: "proof",
			audience: "connection-mcp",
		});
		expect(await response.json()).toEqual({
			version: 1,
			entries: catalogEntries,
		});
		expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
	});

	it("rejects missing proof/authentication and caller authority selectors", async () => {
		const app = createConnectionApp({
			authenticate: async () => undefined,
			catalog: { list: async () => catalogEntries },
		});
		expect((await app.request("/v1/catalog")).status).toBe(401);
		expect(
			(
				await app.request("/v1/catalog?principalId=other", {
					headers: { authorization: "Bearer token" },
				})
			).status,
		).toBe(400);
	});

	it("supports deterministic ETag revalidation", async () => {
		const app = createConnectionApp({
			authenticate: async () => ({
				principalId: "p",
				consumerId: "c",
				consumerInstanceId: "i",
				actorId: null,
				audience: "connection-api",
				scopes: [],
				recoveryGeneration: 1,
				tokenId: "t",
			}),
			catalog: { list: async () => catalogEntries },
		});
		const first = await app.request("/v1/catalog", {
			headers: { authorization: "Bearer token" },
		});
		const second = await app.request("/v1/catalog", {
			headers: {
				authorization: "Bearer token",
				"If-None-Match": first.headers.get("etag") ?? "",
			},
		});
		expect(second.status).toBe(304);
	});
});

describe("BrowserSession API", () => {
	it("never returns the password and sets a host-only session cookie", async () => {
		const principal = {
			id: "p",
			issuer: "corp-ldap",
			uid: "alice",
			status: "active" as const,
			recoveryGeneration: 1,
		};
		const service = {
			create: vi.fn(async () => ({
				token: "a".repeat(43),
				cookie:
					"__Host-connection_session=" +
					"a".repeat(43) +
					"; Path=/; HttpOnly; Secure; SameSite=Strict",
				record: {},
			})),
			resolve: vi.fn(async () => principal),
			revoke: vi.fn(async () => {}),
		} as unknown as BrowserSessionService;
		const app = createConnectionApp({
			browserSession: {
				service,
				authenticate: vi.fn(async () => principal),
			},
		});
		const response = await app.request("/v1/browser-session/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ username: "alice", password: "secret" }),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain(
			"__Host-connection_session=",
		);
		const body = await response.json();
		expect(body).toEqual({
			principal: { id: "p", issuer: "corp-ldap", uid: "alice" },
			activeState: "directory_entry_exists",
		});
		expect(JSON.stringify(body)).not.toContain("secret");
	});

	it("returns a uniform failure for malformed credentials", async () => {
		const app = createConnectionApp({
			browserSession: {
				service: {} as BrowserSessionService,
				authenticate: vi.fn(async () => undefined),
			},
		});
		const response = await app.request("/v1/browser-session/login", {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "invalid_credentials" });
	});

	it("fails closed on state changes without exact Origin and CSRF proof", async () => {
		const app = createConnectionApp({
			publicOrigin: "https://connection.example.test",
		});
		const response = await app.request("/v1/installations", {
			method: "POST",
			body: "{}",
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "csrf_failed" });
	});
});

describe("Direct MCP boundary", () => {
	it("passes only server-resolved authority to the executor", async () => {
		let received: unknown;
		const app = createConnectionApp({
			authenticate: async () => ({
				principalId: "p",
				consumerId: "c",
				consumerInstanceId: "i",
				actorId: null,
				audience: "connection-api",
				scopes: [],
				recoveryGeneration: 1,
				tokenId: "t",
			}),
			mcp: {
				execute: async (input) => {
					received = input;
					return { callId: "call-1", status: "created" };
				},
			},
		});
		const response = await app.request("/v1/mcp", {
			method: "POST",
			headers: {
				authorization: "Bearer token",
				DPoP: "proof",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				actionVersionId: "github.get_current_user@1",
				arguments: {},
				idempotencyKey: "idem-1",
			}),
		});
		expect(response.status).toBe(200);
		expect(received).toMatchObject({
			actionVersionId: "github.get_current_user@1",
			idempotencyKey: "idem-1",
			context: { principalId: "p", consumerInstanceId: "i" },
		});
	});

	it("rejects caller-selected authority fields before execution", async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const app = createConnectionApp({
			authenticate: async () => ({
				principalId: "p",
				consumerId: "c",
				consumerInstanceId: "i",
				actorId: null,
				audience: "connection-api",
				scopes: [],
				recoveryGeneration: 1,
				tokenId: "t",
			}),
			mcp: { execute },
		});
		const response = await app.request("/v1/mcp", {
			method: "POST",
			headers: { authorization: "Bearer token" },
			body: JSON.stringify({
				actionVersionId: "a",
				idempotencyKey: "i",
				principalId: "other",
			}),
		});
		expect(response.status).toBe(400);
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("OAuth token exchange", () => {
	it("requires an installation proof before redeeming a PKCE code", async () => {
		const authorization = {
			inspectAuthorizationCode: vi.fn(async () => ({
				principalId: "p",
				consumerId: "c",
				consumerInstanceId: "i",
				actorId: null,
				audience: "connection-mcp",
				scopes: ["action:read"],
				recoveryGeneration: 1,
				tokenId: "code",
				clientId: "client",
				redirectUri: "https://client.example/callback",
			})),
			redeemAuthorizationCode: vi.fn(async () => undefined),
		} as unknown as OAuthAuthorizationService;
		const app = createConnectionApp({
			oauth: {
				authorization,
				tokens: {} as ConnectionTokenService,
				installations: {
					findById: vi.fn(async () => ({
						id: "i",
						principalId: "p",
						consumerId: "c",
						actorId: null,
						status: "active" as const,
						recoveryGeneration: 1,
						keyFingerprint: "key",
					})),
				} as InstallationStore,
				proofVerifier: {
					verify: vi.fn(async () => false),
					verifyInstallation: vi.fn(async () => false),
				},
			},
		});
		const response = await app.request("/v1/oauth/token", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				DPoP: "proof",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: "code-secret",
				client_id: "client",
				redirect_uri: "https://client.example/callback",
				code_verifier: "a".repeat(43),
			}).toString(),
		});
		expect(response.status).toBe(400);
		expect(authorization.redeemAuthorizationCode).not.toHaveBeenCalled();
	});
});
