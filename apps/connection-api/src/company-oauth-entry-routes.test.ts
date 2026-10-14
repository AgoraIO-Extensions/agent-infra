import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
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
	it("recovers interrupted submissions to safe GET pages without replay or reflecting credentials", async () => {
		const { app, ldapLogin, readIdentity } = setup();
		const id = "A".repeat(43);
		for (const [path, recovery] of [
			[
				`/connection/pat-bindings/confirm?flow=conn_pat_binding_${id}`,
				`/connection/pat-bindings/conn_pat_binding_${id}`,
			],
			[`/oauth/login?request_id=${id}`, `/oauth/authorization-requests/${id}`],
		] as const) {
			const response = await app.request(path, {
				method: "POST",
				body: "password=must-not-reflect&csrfToken=must-not-reflect",
			});
			expect(response.status).toBe(401);
			const page = await response.text();
			expect(page).toContain(encodeURIComponent(recovery ?? ""));
			expect(page).not.toContain("must-not-reflect");
			expect(page).toContain("不会重放");
		}
		expect(ldapLogin).not.toHaveBeenCalled();
		expect(readIdentity).not.toHaveBeenCalled();
	});
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
			"/api/v1/connection/browser-confirmation",
			companyEntryCheckPath,
			companyEntryPath,
			companyIdentityCallbackPath,
		])
			expect(companyEntryRequired(path), path).toBe(false);
		for (const path of [
			"/oauth/authorize",
			"/oauth/login",
			"/api/v1/connection/session",
			"/api/v1/connection/openapi.json",
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

	it("automatically submits a hash-authorized same-origin POST, issues only entrance proof and blocks replay", async () => {
		const { app, readIdentity, ldapLogin } = setup();
		const start = await app.request(
			`${companyEntryPath}?returnTo=${encodeURIComponent("/connection/login")}`,
		);
		const cookie = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		expect(start.headers.get("content-security-policy")).not.toContain(
			"script-src",
		);
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
		const page = await callback.text();
		const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
		expect(script).not.toBe("");
		expect(script).not.toContain(state);
		expect(script).not.toContain("synthetic-code");
		const scriptPolicy = callback.headers
			.get("content-security-policy")
			?.split(";")
			.find((directive) => directive.trim().startsWith("script-src"));
		expect(scriptPolicy?.trim()).toBe(
			`script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`,
		);
		expect(callback.headers.get("content-security-policy")).toContain(
			"form-action 'self';",
		);
		const requestSubmit = vi.fn();
		const getElementById = vi.fn((id: string) => {
			expect(id).toBe("company-oauth-complete");
			return { requestSubmit };
		});
		runInNewContext(script, { document: { getElementById } });
		expect(requestSubmit).toHaveBeenCalledExactlyOnceWith();
		expect(page).toContain(
			`<form id="company-oauth-complete" method="post" action="${companyIdentityCallbackPath}">`,
		);
		expect(page).toContain('<button type="submit">完成公司登录</button>');
		expect(page).toContain('<div id="company-oauth-recovery">');
		expect(page).toContain(
			"#company-oauth-recovery{visibility:hidden;animation:show-recovery 0s 2s forwards}",
		);
		expect(page).toContain("@keyframes show-recovery{to{visibility:visible}}");
		expect(page.indexOf("<style>")).toBeLessThan(page.indexOf("<form"));
		expect(readIdentity).not.toHaveBeenCalled();
		const body = new URLSearchParams({
			csrfToken: /name="csrfToken" value="([^"]+)"/.exec(page)?.[1] ?? "",
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
		const browserPost = (fetchSite: string, host: string, requestBody = body) =>
			app.request(`${issuer}${companyIdentityCallbackPath}`, {
				method: "POST",
				headers: {
					cookie,
					origin: "null",
					"sec-fetch-site": fetchSite,
					host,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: requestBody,
			});
		expect(
			(
				await browserPost(
					"cross-site",
					new URL(issuer).host,
					new URLSearchParams({
						flow: "entry",
						state,
						code: "synthetic-code",
					}).toString(),
				)
			).status,
		).toBe(400);
		expect((await browserPost("same-origin", "attacker.invalid")).status).toBe(
			400,
		);
		const accepted = await browserPost("cross-site", new URL(issuer).host);
		expect(accepted.status).toBe(303);
		expect(accepted.headers.get("content-security-policy")).not.toContain(
			"script-src",
		);
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

	it("keeps untrusted callback fields out of the script and denies scripts on errors", async () => {
		const { app, entry, readIdentity } = setup();
		const { state } = entry.start();
		const code = "</script><script>alert(1)</script>";
		const url = `${companyIdentityCallbackPath}?${new URLSearchParams({ state, code })}`;
		const valid = await app.request(url, {
			headers: { cookie: `__Host-connection_company_oauth_state=${state}` },
		});
		const page = await valid.text();
		expect(valid.status).toBe(200);
		expect(page.match(/<script>/g)).toHaveLength(1);
		expect(page).not.toContain(code);
		expect(page).toContain(
			"&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
		);
		const rejected = await app.request(url);
		expect(rejected.status).toBe(400);
		expect(rejected.headers.get("content-security-policy")).not.toContain(
			"script-src",
		);
		expect(await rejected.text()).not.toContain("<script>");
		expect(readIdentity).not.toHaveBeenCalled();
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
