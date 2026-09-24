import {
	type BrowserSessionPrincipal,
	type BrowserSessionRecord,
	BrowserSessionService,
	LdapAuthenticationError,
	LoginThrottle,
	PrincipalIdentityResolver,
	stablePrincipalId,
} from "@agent-infra/connection-identity";
import { expect, it, vi } from "vitest";
import { createConnectionApp } from "./app";
import type { ConnectionAuthDependencies } from "./auth";

function setup() {
	const principals = new Map<string, BrowserSessionPrincipal>();
	const records = new Map<string, BrowserSessionRecord>();
	const principalStore = {
		async findByIssuerUid({ issuer, uid }: { issuer: string; uid: string }) {
			return principals.get(stablePrincipalId(issuer, uid));
		},
		async findById(id: string) {
			return principals.get(id);
		},
		async insert(input: BrowserSessionPrincipal) {
			principals.set(input.id, input);
		},
		async disable(id: string) {
			const principal = principals.get(id);
			if (principal) {
				principal.status = "disabled";
				principal.recoveryGeneration += 1;
			}
		},
	};
	const sessions = new BrowserSessionService(
		{
			async insert(record) {
				records.set(record.tokenHash, record);
			},
			async findByTokenHash(hash) {
				return records.get(hash);
			},
			async revoke(id, at) {
				for (const record of records.values())
					if (record.id === id) record.revokedAt = at;
			},
		},
		principalStore,
		{ check: async () => ({ exists: true }) },
	);
	const audit = vi.fn(async () => {});
	const ldap: ConnectionAuthDependencies["ldap"] = {
		async authenticate(username, password) {
			if (password !== "correct" || !["alice", "bob"].includes(username))
				throw new LdapAuthenticationError();
			return {
				issuer: "corp-ldap",
				uid: username,
				dn: `uid=${username},ou=people,dc=example,dc=test`,
				attributes: { uid: username },
			};
		},
	};
	const auth: ConnectionAuthDependencies = {
		ldap,
		principals: new PrincipalIdentityResolver(principalStore),
		sessions,
		throttle: new LoginThrottle(),
		publicOrigin: "https://connection.example.test",
		environment: "test",
		csrfKey: Buffer.alloc(32, 7),
		source: () => "127.0.0.1",
		audit,
	};
	return { app: createConnectionApp(auth), audit, principals, ldap };
}

async function login(
	app: ReturnType<typeof createConnectionApp>,
	username: string,
	password: string,
) {
	return app.request("/auth/login", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "https://connection.example.test",
			"sec-fetch-site": "same-origin",
		},
		body: JSON.stringify({ username, password }),
	});
}

it("logs in with an opaque cookie and requires the matching Origin, session and CSRF token for logout", async () => {
	const { app, audit } = setup();
	const aliceLogin = await login(app, "alice", "correct");
	expect(aliceLogin.status).toBe(200);
	const aliceCookie = aliceLogin.headers.get("set-cookie")?.split(";")[0];
	expect(aliceCookie).toMatch(/^__Host-connection_session=/);
	const aliceSession = await app.request("/auth/session", {
		headers: { cookie: aliceCookie ?? "" },
	});
	expect(aliceSession.status).toBe(200);
	const aliceBody = (await aliceSession.json()) as { csrfToken: string };
	const aliceCsrf = aliceBody.csrfToken;
	const bobLogin = await login(app, "bob", "correct");
	const bobCookie = bobLogin.headers.get("set-cookie")?.split(";")[0];
	const forbidden = await app.request("/auth/logout", {
		method: "POST",
		headers: {
			cookie: bobCookie ?? "",
			origin: "https://connection.example.test",
			"sec-fetch-site": "same-origin",
			"x-csrf-token": aliceCsrf,
		},
	});
	expect(forbidden.status).toBe(403);
	const crossOrigin = await app.request("/auth/logout", {
		method: "POST",
		headers: {
			cookie: aliceCookie ?? "",
			origin: "https://attacker.example.test",
			"sec-fetch-site": "cross-site",
			"x-csrf-token": aliceCsrf,
		},
	});
	expect(crossOrigin.status).toBe(403);
	const logout = await app.request("/auth/logout", {
		method: "POST",
		headers: {
			cookie: aliceCookie ?? "",
			origin: "https://connection.example.test",
			"sec-fetch-site": "same-origin",
			"x-csrf-token": aliceCsrf,
		},
	});
	expect(logout.status).toBe(204);
	expect(
		(
			await app.request("/auth/session", {
				headers: { cookie: aliceCookie ?? "" },
			})
		).status,
	).toBe(401);
	expect(
		(
			await app.request("/auth/session", {
				headers: { cookie: bobCookie ?? "" },
			})
		).status,
	).toBe(200);
	expect(audit).toHaveBeenCalledWith({
		principalId: stablePrincipalId("corp-ldap", "alice"),
		action: "auth.logout",
		outcome: "succeeded",
	});
});

it("returns a single redacted credential failure for unknown user, wrong password and disabled Principal", async () => {
	const { app, principals, audit } = setup();
	const aliceLogin = await login(app, "alice", "correct");
	expect(aliceLogin.status).toBe(200);
	const principal = principals.get(stablePrincipalId("corp-ldap", "alice"));
	if (!principal) throw new Error("principal missing");
	principal.status = "disabled";
	const responses = await Promise.all([
		login(app, "unknown", "correct"),
		login(app, "alice", "wrong-password"),
		login(app, "alice", "correct"),
	]);
	for (const response of responses) {
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Login failed" });
	}
	expect(audit).toHaveBeenCalledWith({
		action: "auth.login",
		outcome: "failed",
	});
	expect(JSON.stringify(audit.mock.calls)).not.toContain("wrong-password");
});
