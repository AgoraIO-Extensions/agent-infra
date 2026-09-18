import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import type { createAuthentikDirectory } from "./directory.ts";

type Directory = ReturnType<typeof createAuthentikDirectory>;
export interface AuthentikBrowserConfiguration {
	publicOrigin: string;
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	clientId: string;
	clientSecret: string;
}
const SESSION = "__Host-platform-session";
const CHALLENGE = "__Host-platform-login";
const SESSION_MS = 15 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
const MAX_ENTRIES = 1024;
// Match the OIDC client's default tolerance, including for issued-at validation.
const CLOCK_SKEW_SECONDS = 30;
const random = () => randomBytes(32).toString("base64url");
function cookie(request: Request, name: string) {
	const raw = request.headers.get("cookie") ?? "";
	if (raw.length > 8192) return null;
	const values = raw
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`));
	if (values.length !== 1) return null;
	const value = values[0]?.slice(name.length + 1);
	return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
function setCookie(name: string, value: string, seconds: number) {
	return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
function response(status: number, location?: string) {
	return new Response(null, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			...(location ? { Location: location } : {}),
		},
	});
}
function logoutConfirmation() {
	const nonce = random();
	return new Response(
		`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>退出平台</title><body><main><h1>退出平台</h1><p>确认结束当前平台登录会话？</p><button type="button" id="confirm">确认退出</button> <a href="/agents">取消</a><p id="status" role="status"></p></main><script nonce="${nonce}">document.getElementById('confirm').addEventListener('click',async(event)=>{event.currentTarget.disabled=true;try{const result=await fetch('/auth/logout',{method:'POST',credentials:'same-origin',headers:{'x-platform-csrf':'1'}});if(!result.ok)throw new Error();location.assign('/agents');}catch{document.getElementById('status').textContent='退出失败，请重试。';document.getElementById('confirm').disabled=false;}});</script></body></html>`,
		{
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
			},
		},
	);
}

function https(value: string) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		url.search
	)
		throw new Error("Invalid identity configuration");
	return url;
}

/** Deployment-only process-local OIDC sessions; permissions are never cached. */
export function createAuthentikBrowserAdapter(
	input: AuthentikBrowserConfiguration,
	directory: Directory,
) {
	const origin = https(input.publicOrigin);
	const issuer = https(input.issuer);
	if (
		origin.origin !== input.publicOrigin ||
		!input.clientId ||
		!input.clientSecret
	)
		throw new Error("Invalid identity configuration");
	for (const endpoint of [
		input.authorizationEndpoint,
		input.tokenEndpoint,
		input.jwksUri,
	]) {
		if (https(endpoint).origin !== issuer.origin)
			throw new Error("Invalid identity configuration");
	}
	const config = new oidc.Configuration(
		{
			issuer: input.issuer,
			authorization_endpoint: input.authorizationEndpoint,
			token_endpoint: input.tokenEndpoint,
			jwks_uri: input.jwksUri,
			id_token_signing_alg_values_supported: ["RS256"],
		},
		input.clientId,
		{
			client_secret: input.clientSecret,
			id_token_signed_response_alg: "RS256",
		},
	);
	config.timeout = 10;
	oidc.enableNonRepudiationChecks(config);
	const redirectUri = `${input.publicOrigin}/auth/callback`;
	const sessions = new Map<string, { userId: string; expires: number }>();
	const challenges = new Map<
		string,
		{ state: string; nonce: string; verifier: string; expires: number }
	>();
	function prune() {
		for (const map of [sessions, challenges])
			for (const [key, value] of map)
				if (value.expires <= Date.now()) map.delete(key);
	}
	const cleanupTimer = setInterval(prune, 60_000);
	cleanupTimer.unref?.();
	const identityAdapter = {
		async resolve(request: Request) {
			prune();
			const key = cookie(request, SESSION);
			const session = key ? sessions.get(key) : undefined;
			return session ? directory.resolveIdentity(session.userId) : null;
		},
		hydrateUsers: (ids: readonly string[]) => directory.hydrateUsers(ids),
		resolveUser: (id: string) => directory.resolveUser(id),
	};
	async function handleRequest(request: Request): Promise<Response | null> {
		const url = new URL(request.url);
		if (
			!["/auth/login", "/auth/callback", "/auth/logout"].includes(url.pathname)
		)
			return null;
		prune();
		if (url.origin !== origin.origin || request.url.length > 8192)
			return response(400);
		if (url.pathname === "/auth/logout") {
			if (request.method === "GET") return logoutConfirmation();
			if (
				request.method !== "POST" ||
				request.headers.get("origin") !== input.publicOrigin ||
				request.headers.get("x-platform-csrf") !== "1"
			)
				return response(403);
			const key = cookie(request, SESSION);
			if (key) sessions.delete(key);
			const pending = cookie(request, CHALLENGE);
			if (pending) challenges.delete(pending);
			const result = response(204);
			result.headers.append("Set-Cookie", setCookie(SESSION, "", 0));
			result.headers.append("Set-Cookie", setCookie(CHALLENGE, "", 0));
			return result;
		}
		if (request.method !== "GET") return response(405);
		if (url.pathname === "/auth/login") {
			if (url.search) return response(400);
			const previous = cookie(request, CHALLENGE);
			if (previous) challenges.delete(previous);
			if (challenges.size >= MAX_ENTRIES) {
				const oldest = challenges.keys().next().value;
				if (oldest) challenges.delete(oldest);
			}
			const key = random();
			const challenge = {
				state: random(),
				nonce: random(),
				verifier: oidc.randomPKCECodeVerifier(),
				expires: Date.now() + CHALLENGE_MS,
			};
			challenges.set(key, challenge);
			const target = oidc.buildAuthorizationUrl(config, {
				redirect_uri: redirectUri,
				scope: "openid",
				state: challenge.state,
				nonce: challenge.nonce,
				code_challenge: await oidc.calculatePKCECodeChallenge(
					challenge.verifier,
				),
				code_challenge_method: "S256",
			});
			const result = response(302, target.href);
			result.headers.set(
				"Set-Cookie",
				setCookie(CHALLENGE, key, CHALLENGE_MS / 1000),
			);
			return result;
		}
		const key = cookie(request, CHALLENGE);
		const challenge = key ? challenges.get(key) : undefined;
		if (key) challenges.delete(key);
		let result = response(401);
		try {
			if (!challenge || sessions.size >= MAX_ENTRIES) return result;
			const tokens = await oidc.authorizationCodeGrant(
				config,
				new URL(`${url.pathname}${url.search}`, input.publicOrigin),
				{
					expectedState: challenge.state,
					expectedNonce: challenge.nonce,
					pkceCodeVerifier: challenge.verifier,
				},
			);
			const claims = tokens.claims();
			if (
				!claims ||
				!Number.isFinite(claims.iat) ||
				!Number.isFinite(claims.exp) ||
				claims.iat < 0 ||
				claims.iat > Date.now() / 1000 + CLOCK_SKEW_SECONDS ||
				claims.iat >= claims.exp ||
				claims.iss !== input.issuer ||
				typeof claims.sub !== "string" ||
				claims.sub.length > 1024
			)
				return result;
			const identity = await directory.resolveVerifiedSubject({
				issuer: claims.iss,
				subject: claims.sub,
			});
			if (
				!identity ||
				challenge.expires <= Date.now() ||
				sessions.size >= MAX_ENTRIES
			)
				return result;
			const old = cookie(request, SESSION);
			if (old) sessions.delete(old);
			const sessionKey = random();
			sessions.set(sessionKey, {
				userId: identity.userId,
				expires: Date.now() + SESSION_MS,
			});
			result = response(303, `${input.publicOrigin}/`);
			result.headers.append(
				"Set-Cookie",
				setCookie(SESSION, sessionKey, SESSION_MS / 1000),
			);
			return result;
		} catch {
			return result;
		} finally {
			result.headers.append("Set-Cookie", setCookie(CHALLENGE, "", 0));
		}
	}
	return {
		identityAdapter,
		handleRequest,
		close() {
			clearInterval(cleanupTimer);
			sessions.clear();
			challenges.clear();
		},
	};
}
