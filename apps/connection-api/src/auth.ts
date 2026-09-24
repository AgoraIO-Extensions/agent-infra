import { createHmac, timingSafeEqual } from "node:crypto";
import {
	browserSessionCookieName,
	type ConnectionLoginService,
	LoginRateLimitedError,
	LoginRejectedError,
	readBrowserSessionCookie,
} from "@agent-infra/connection-core";
import type { Context, Hono } from "hono";
import {
	AuthLoginRequestV1Schema,
	AuthLoginResponseV1Schema,
	AuthSessionResponseV1Schema,
	authError,
} from "./auth-schema";

export interface ConnectionAuthDependencies {
	service: Pick<ConnectionLoginService, "login" | "currentSession" | "logout">;
	publicOrigin: string;
	csrfKey: Buffer;
	source: (context: Context) => string;
}

export function sameOriginRequest(
	origin: string | undefined,
	fetchSite: string | undefined,
	publicOrigin: string,
): boolean {
	return (
		origin === publicOrigin &&
		(fetchSite === undefined || fetchSite === "same-origin")
	);
}

export function csrfToken(token: string, key: Buffer): string {
	return createHmac("sha256", key).update(token).digest("base64url");
}

export function validCsrf(
	actual: string | undefined,
	expected: string,
): boolean {
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
			return context.json(authError("Forbidden"), 403);
		let body: unknown;
		try {
			body = await context.req.json();
		} catch {
			return context.json(authError("Invalid request"), 400);
		}
		const request = AuthLoginRequestV1Schema.safeParse(body);
		if (!request.success)
			return context.json(authError("Invalid request"), 400);
		try {
			const result = await auth.service.login({
				username: request.data.username,
				password: request.data.password,
				source: auth.source(context),
			});
			return context.json(
				AuthLoginResponseV1Schema.parse({
					principal: { id: result.principal.id, uid: result.principal.uid },
				}),
				200,
				{ "Set-Cookie": result.cookie, "Cache-Control": "no-store" },
			);
		} catch (error) {
			if (error instanceof LoginRejectedError)
				return context.json(authError("Login failed"), 401);
			if (error instanceof LoginRateLimitedError)
				return context.json(authError("Login temporarily unavailable"), 429);
			return context.json(authError("Login unavailable"), 503);
		}
	});

	app.get("/auth/session", async (context) => {
		const token = readBrowserSessionCookie(context.req.header("cookie"));
		try {
			const principal = await auth.service.currentSession(token);
			if (!principal || !token)
				return context.json(authError("Unauthorized"), 401);
			return context.json(
				AuthSessionResponseV1Schema.parse({
					principal: { id: principal.id, uid: principal.uid },
					csrfToken: csrfToken(token, auth.csrfKey),
				}),
				200,
				{ "Cache-Control": "no-store" },
			);
		} catch {
			return context.json(authError("Unavailable"), 503);
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
			return context.json(authError("Forbidden"), 403);
		const token = readBrowserSessionCookie(context.req.header("cookie"));
		if (
			!token ||
			!validCsrf(
				context.req.header("x-csrf-token"),
				csrfToken(token, auth.csrfKey),
			)
		)
			return context.json(authError("Forbidden"), 403);
		try {
			const principal = await auth.service.logout(token);
			if (!principal) return context.json(authError("Unauthorized"), 401);
			return context.body(null, 204, {
				"Set-Cookie": `${browserSessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
				"Cache-Control": "no-store",
			});
		} catch {
			return context.json(authError("Unavailable"), 503);
		}
	});
}
