import { createHmac, timingSafeEqual } from "node:crypto";
import {
	browserSessionCookieName,
	type ConnectionLoginService,
	LoginRateLimitedError,
	LoginRejectedError,
	readBrowserSessionCookie,
} from "@agent-infra/connection-core";
import type { Context, Hono } from "hono";

export interface ConnectionAuthDependencies {
	service: Pick<ConnectionLoginService, "login" | "currentSession" | "logout">;
	publicOrigin: string;
	csrfKey: Buffer;
	source: (context: Context) => string;
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

export function addConnectionAuthRoutes(
	app: Hono,
	auth: ConnectionAuthDependencies,
): void {
	app.post("/auth/login", async (context) => {
		if (
			!sameOriginRequest(
				context.req.header("origin"),
				context.req.header("sec-fetch-site"),
				auth.publicOrigin,
			)
		)
			return context.json({ error: "Forbidden" }, 403);
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json({ error: "Invalid request" }, 400);
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
			return context.json({ error: "Invalid request" }, 400);
		try {
			const result = await auth.service.login({
				username: body.username,
				password: body.password,
				source: auth.source(context),
			});
			return context.json(
				{ principal: { id: result.principal.id, uid: result.principal.uid } },
				200,
				{ "Set-Cookie": result.cookie, "Cache-Control": "no-store" },
			);
		} catch (error) {
			if (error instanceof LoginRejectedError)
				return context.json({ error: "Login failed" }, 401);
			if (error instanceof LoginRateLimitedError)
				return context.json({ error: "Login temporarily unavailable" }, 429);
			return context.json({ error: "Login unavailable" }, 503);
		}
	});

	app.get("/auth/session", async (context) => {
		const token = readBrowserSessionCookie(context.req.header("cookie"));
		try {
			const principal = await auth.service.currentSession(token);
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
			const principal = await auth.service.logout(token);
			if (!principal) return context.json({ error: "Unauthorized" }, 401);
			return context.body(null, 204, {
				"Set-Cookie": `${browserSessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
				"Cache-Control": "no-store",
			});
		} catch {
			return context.json({ error: "Unavailable" }, 503);
		}
	});
}
