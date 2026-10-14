import {
	CompanyOAuthEntry,
	companyEntryCheckPath,
	companyEntryPath,
	companyIdentityCallbackPath,
} from "@agent-infra/connection-core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
	companyEntryRequired,
	createCompanyOAuthEntryApp,
} from "./company-oauth-entry-routes";
import { createIdentityProbeApp } from "./identity-probe-routes";

const issuer = "https://connection.example";
function setup(enabled = true) {
	const taken = new Set<string>();
	const readIdentity = vi.fn(async () => ({
		email: "different-entrance-user@agora.io",
		permissions: ["CONNECTION_ADMIN"],
	}));
	const entry = new CompanyOAuthEntry({
		clientId: "test-client",
		publicBaseUrl: issuer,
		identityRealm: "urn:test:entry",
		identityKey: Buffer.alloc(32, 23),
		readIdentity,
		commands: {
			execute: async (input, command) => {
				if (taken.has(input.idempotencyKey)) throw new Error("Taken");
				taken.add(input.idempotencyKey);
				return command();
			},
		},
	});
	const ldapLogin = vi.fn(async () => Response.json({ ldapReached: true }));
	const app = new Hono();
	app.route(
		"/",
		createCompanyOAuthEntryApp(enabled ? entry : undefined, issuer),
	);
	app.route("/", createIdentityProbeApp(undefined, issuer));
	app.post("/api/v1/connection/session", ldapLogin);
	app.get("/api/v1/connection/session", () =>
		Response.json({ error: "LDAP session required" }, { status: 401 }),
	);
	app.post("/mcp", () =>
		Response.json(
			{ error: "Connection token required" },
			{ status: 401, headers: { "www-authenticate": "Bearer" } },
		),
	);
	app.post("/oauth/token", () =>
		Response.json({ error: "invalid_grant" }, { status: 400 }),
	);
	app.get("/.well-known/oauth-authorization-server", () =>
		Response.json({ issuer }),
	);
	return { app, entry, readIdentity, ldapLogin };
}

describe("company entrance HTTP boundary", () => {
	it("gates only browser interactions, never MCP, metadata or service credentials", async () => {
		for (const path of [
			"/mcp",
			"/oauth/token",
			"/oauth/register",
			"/oauth/revoke",
			"/oauth/callback",
			"/connection/internal/v1/action-calls",
			"/connection/v1/consumer-instances/a/session",
			"/api/v1/connection/pat-bindings",
			"/api/v1/connection/pat-bindings/a/claim",
			"/api/v1/connection/openapi.json",
			companyEntryCheckPath,
			companyEntryPath,
			companyIdentityCallbackPath,
		])
			expect(companyEntryRequired(path), path).toBe(false);
		for (const path of [
			"/oauth/authorize",
			"/oauth/login",
			"/api/v1/connection/session",
			"/api/v1/connection/connections",
			"/api/v1/connection/new-browser-api",
			"/api/v1/connection/pat-bindings/a/claim/extra",
			"/connection/pat-bindings/a",
		])
			expect(companyEntryRequired(path), path).toBe(true);
		const { app, ldapLogin, readIdentity } = setup();
		expect((await app.request(companyEntryCheckPath)).status).toBe(401);
		const login = await app.request("/api/v1/connection/session", {
			method: "POST",
			headers: {
				"x-oauth-email": "forged@agora.io",
				"x-iam-permissions": "CONNECTION_ADMIN",
			},
			body: "not-forwarded-password",
		});
		expect(login.status).toBe(401);
		expect(login.headers.get("location")).toBeNull();
		expect(await login.json()).toMatchObject({
			error: { code: "AUTHENTICATION_REQUIRED" },
		});
		expect(ldapLogin).not.toHaveBeenCalled();
		const interruptedPost = await app.request(companyEntryPath, {
			headers: {
				"x-connection-original-method": "POST",
				"x-connection-return-to": "/connection/pat-bindings/confirm",
			},
		});
		expect(interruptedPost.status).toBe(401);
		expect(interruptedPost.headers.get("location")).toBeNull();
		expect(readIdentity).not.toHaveBeenCalled();
		const mcp = await app.request("/mcp", { method: "POST" });
		expect(mcp.status).toBe(401);
		expect(mcp.headers.get("www-authenticate")).toBe("Bearer");
		expect(
			(await app.request("/.well-known/oauth-authorization-server")).status,
		).toBe(200);
		expect((await app.request("/oauth/token", { method: "POST" })).status).toBe(
			400,
		);
	});

	it("requires an explicit same-origin callback POST, issues only entrance proof and blocks replay", async () => {
		const { app, readIdentity, ldapLogin } = setup();
		const start = await app.request(
			`${companyEntryPath}?returnTo=${encodeURIComponent("/connection/login")}`,
		);
		const cookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		expect(start.headers.get("set-cookie")).toContain("__Host-");
		expect(start.headers.get("set-cookie")).toContain("HttpOnly");
		expect(start.headers.get("set-cookie")).toContain("Secure");
		expect(start.headers.get("set-cookie")).toContain("SameSite=Lax");
		const state =
			new URL(start.headers.get("location") ?? "").searchParams.get("state") ??
			"";
		const query = new URLSearchParams({ state, code: "synthetic-code" });
		const callback = await app.request(
			`${companyIdentityCallbackPath}?${query}`,
			{ headers: { cookie } },
		);
		expect(callback.status).toBe(200);
		expect(callback.headers.get("cache-control")).toBe("no-store");
		expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
		expect(readIdentity).not.toHaveBeenCalled();
		const body = new URLSearchParams({
			flow: "entry",
			state,
			code: "synthetic-code",
		}).toString();
		const complete = (origin: string, c = cookie) =>
			app.request(`${issuer}${companyIdentityCallbackPath}`, {
				method: "POST",
				headers: {
					cookie: c,
					origin,
					"content-type": "application/x-www-form-urlencoded",
				},
				body,
			});
		expect((await complete("https://attacker.invalid")).status).toBe(400);
		expect((await complete(issuer, "other-browser=1")).status).toBe(400);
		expect(readIdentity).not.toHaveBeenCalled();
		const accepted = await complete(issuer);
		expect(accepted.status).toBe(303);
		expect(accepted.headers.get("location")).toBe("/connection/login");
		const ticket =
			accepted.headers
				.getSetCookie()
				.find((v) => v.startsWith("__Host-connection_company_oauth_entry=")) ??
			"";
		expect(ticket).toContain("Secure");
		expect(ticket).toContain("HttpOnly");
		expect(ticket).toContain("SameSite=Strict");
		expect(
			(
				await app.request(companyEntryCheckPath, {
					headers: { cookie: ticket.split(";")[0] ?? "" },
				})
			).status,
		).toBe(204);
		const ldap = await app.request("/api/v1/connection/session", {
			method: "POST",
			headers: { cookie: ticket.split(";")[0] ?? "" },
		});
		expect(ldap.status).toBe(200);
		expect(ldapLogin).toHaveBeenCalledTimes(1);
		expect(
			(
				await app.request("/api/v1/connection/session", {
					headers: { cookie: ticket.split(";")[0] ?? "" },
				})
			).status,
		).toBe(401);
		expect((await complete(issuer)).status).toBe(400);
		expect(readIdentity).toHaveBeenCalledTimes(1);
	});

	it("keeps unconfigured entrance separate from legacy LDAP and disabled probes", async () => {
		const { app } = setup(false);
		expect((await app.request(companyEntryCheckPath)).status).toBe(204);
		expect((await app.request(companyEntryPath)).status).toBe(503);
		expect((await app.request(companyIdentityCallbackPath)).status).toBe(503);
		expect(
			(await app.request("/api/v1/connection/session", { method: "POST" }))
				.status,
		).toBe(200);
	});
});
