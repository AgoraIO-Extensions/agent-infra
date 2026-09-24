import { createHmac, timingSafeEqual } from "node:crypto";
import {
	type BrowserSessionPrincipal,
	type BrowserSessionService,
	browserSessionCookieName,
	LdapAuthenticationError,
	type LdapAuthenticator,
	LoginRateLimitedError,
	type LoginThrottle,
	type PrincipalIdentityResolver,
	readBrowserSessionCookie,
} from "@agent-infra/connection-identity";
import type { Context, Hono } from "hono";

export interface ConnectionAuthDependencies {
	ldap: Pick<LdapAuthenticator, "authenticate">;
	principals: Pick<PrincipalIdentityResolver, "resolve">;
	sessions: Pick<BrowserSessionService, "create" | "resolve" | "revoke">;
	throttle: LoginThrottle;
	publicOrigin: string;
	environment: string;
	csrfKey: Buffer;
	source: (context: Context) => string;
	audit: (input: {
		principalId?: string;
		action: string;
		outcome: "succeeded" | "rejected" | "failed";
	}) => Promise<void>;
}

function sameOriginRequest(
	origin: string | undefined,
	fetchSite: string | undefined,
	publicOrigin: string,
): boolean {
	return (
		origin === publicOrigin &&
		(fetchSite === undefined || fetchSite === "same-origin")
	);
}

function csrfToken(token: string, key: Buffer): string {
	return createHmac("sha256", key).update(token).digest("base64url");
}

function validCsrf(actual: string | undefined, expected: string): boolean {
	if (!actual || actual.length !== expected.length) return false;
	return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function genericLoginFailure(startedAt: number): Promise<Response> {
	const remaining = 250 - (Date.now() - startedAt);
	if (remaining > 0)
		await new Promise((resolve) => setTimeout(resolve, remaining));
	return Response.json({ error: "Login failed" }, { status: 401 });
}

export function addConnectionAuthRoutes(
	app: Hono,
	auth: ConnectionAuthDependencies,
): void {
	app.post("/auth/login", async (context) => {
		const startedAt = Date.now();
		if (
			!sameOriginRequest(
				context.req.header("origin"),
				context.req.header("sec-fetch-site"),
				auth.publicOrigin,
			)
		)
			return context.json({ error: "Login failed" }, 403);
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return genericLoginFailure(startedAt);
		}
		if (
			!body ||
			typeof body !== "object" ||
			!("username" in body) ||
			!("password" in body) ||
			typeof body.username !== "string" ||
			typeof body.password !== "string" ||
			body.username.length > 256 ||
			body.password.length > 1024
		)
			return genericLoginFailure(startedAt);
		let finish: ((succeeded: boolean) => void) | undefined;
		try {
			finish = auth.throttle.begin({
				environment: auth.environment,
				source: auth.source(context),
				username: body.username,
			});
		} catch (error) {
			if (error instanceof LoginRateLimitedError) {
				try {
					await auth.audit({ action: "auth.login", outcome: "rejected" });
				} catch {
					return context.json({ error: "Login unavailable" }, 503);
				}
				return context.json({ error: "Login temporarily unavailable" }, 429);
			}
			return context.json({ error: "Login unavailable" }, 503);
		}
		if (!finish) return context.json({ error: "Login unavailable" }, 503);
		let created:
			| Awaited<ReturnType<BrowserSessionService["create"]>>
			| undefined;
		try {
			const directoryPrincipal = await auth.ldap.authenticate(
				body.username,
				body.password,
			);
			const principal = await auth.principals.resolve(directoryPrincipal);
			if (principal.status !== "active") throw new LdapAuthenticationError();
			created = await auth.sessions.create(principal);
			await auth.audit({
				principalId: principal.id,
				action: "auth.login",
				outcome: "succeeded",
			});
			finish(true);
			return context.json(
				{ principal: { id: principal.id, uid: principal.uid } },
				200,
				{ "Set-Cookie": created.cookie, "Cache-Control": "no-store" },
			);
		} catch (error) {
			finish(false);
			if (created) await auth.sessions.revoke(created.token).catch(() => {});
			try {
				await auth.audit({ action: "auth.login", outcome: "failed" });
			} catch {
				return context.json({ error: "Login unavailable" }, 503);
			}
			if (error instanceof LdapAuthenticationError)
				return genericLoginFailure(startedAt);
			return context.json({ error: "Login unavailable" }, 503);
		}
	});

	app.get("/auth/session", async (context) => {
		const token = readBrowserSessionCookie(context.req.header("cookie"));
		try {
			const principal = await auth.sessions.resolve(token);
			if (!principal || !token)
				return context.json({ error: "Unauthorized" }, 401);
			return context.json(
				{
					principal: { id: principal.id, uid: principal.uid },
					csrfToken: csrfToken(token, auth.csrfKey),
				},
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch {
			return context.json({ error: "Unavailable" }, 503);
		}
	});

	app.post("/auth/logout", async (context) => {
		if (
			!sameOriginRequest(
				context.req.header("origin"),
				context.req.header("sec-fetch-site"),
				auth.publicOrigin,
			)
		)
			return context.json({ error: "Forbidden" }, 403);
		const token = readBrowserSessionCookie(context.req.header("cookie"));
		if (
			!token ||
			!validCsrf(
				context.req.header("x-csrf-token"),
				csrfToken(token, auth.csrfKey),
			)
		)
			return context.json({ error: "Forbidden" }, 403);
		try {
			const principal: BrowserSessionPrincipal | undefined =
				await auth.sessions.resolve(token);
			if (!principal) return context.json({ error: "Unauthorized" }, 401);
			await auth.sessions.revoke(token);
			await auth.audit({
				principalId: principal.id,
				action: "auth.logout",
				outcome: "succeeded",
			});
			return context.body(null, 204, {
				"Set-Cookie": `${browserSessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
				"Cache-Control": "no-store",
			});
		} catch {
			return context.json({ error: "Unavailable" }, 503);
		}
	});
}
