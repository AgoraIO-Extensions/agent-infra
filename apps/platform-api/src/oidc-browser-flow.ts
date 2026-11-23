import { createHash, randomBytes } from "node:crypto";
import type { OidcLogoutEvent } from "@agent-infra/platform-store";
import * as oidc from "openid-client";

import {
	backchannelLogoutPath,
	createBackchannelLogout,
} from "./oidc-backchannel-logout.js";

const loginPath = "/auth/oidc/login";
const callbackPath = "/auth/oidc/callback";
const browserCookie = "__Host-platform-oidc";
const transactionLifetimeSeconds = 300;
const opaqueValue = /^[A-Za-z0-9_-]{43}$/u;

export interface OidcBrowserIdentity {
	issuer: string;
	subject: string;
	email: string | null;
	emailVerified: boolean;
}

export interface OidcLoginTransaction {
	nonce: string;
	verifier: string;
}

interface OidcBrowserFlowInput {
	issuer: string;
	clientId: string;
	clientSecret: string;
	publicOrigin: string;
	transactions: {
		put(key: string, value: OidcLoginTransaction): Promise<void>;
		/** Atomically delete and return a live transaction. Store TTL is five minutes. */
		take(key: string): Promise<OidcLoginTransaction | null>;
	};
	logout(notice: OidcLogoutEvent): Promise<void>;
	login(identity: OidcBrowserIdentity): Promise<Response>;
}

function response(status: number) {
	return new Response(null, {
		status,
		headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}

function browserSecret(request: Request) {
	const header = request.headers.get("cookie") ?? "";
	if (header.length > 8192) return null;
	const cookies = header
		.split(";")
		.map((p) => p.trim())
		.filter((p) => p.startsWith(`${browserCookie}=`));
	const value = cookies[0]?.slice(browserCookie.length + 1);
	return cookies.length === 1 && value && opaqueValue.test(value)
		? value
		: null;
}

export function createOidcBrowserFlow(input: OidcBrowserFlowInput) {
	const issuerUrl = new URL(input.issuer);
	const origin = new URL(input.publicOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.origin !== input.publicOrigin ||
		issuerUrl.protocol !== "https:" ||
		issuerUrl.username ||
		issuerUrl.password ||
		issuerUrl.search ||
		issuerUrl.hash ||
		!input.clientId.trim() ||
		!input.clientSecret.trim()
	) {
		throw new Error("OIDC_BROWSER_CONFIGURATION_INVALID");
	}
	const callback = origin.origin + callbackPath;
	const transactionKey = (state: string, secret: string) =>
		createHash("sha256")
			.update(
				JSON.stringify([input.issuer, input.clientId, callback, state, secret]),
			)
			.digest("hex");
	let pending: Promise<oidc.Configuration> | undefined;
	function configuration() {
		pending ??= oidc
			.discovery(issuerUrl, input.clientId, input.clientSecret, undefined, {
				timeout: 5,
				execute: [oidc.enableNonRepudiationChecks],
			})
			.catch((error: unknown) => {
				pending = undefined;
				throw error;
			});
		return pending;
	}

	const logout = createBackchannelLogout({ ...input, configuration });

	async function start() {
		const config = await configuration();
		const state = randomBytes(32).toString("base64url");
		const secret = randomBytes(32).toString("base64url");
		const nonce = oidc.randomNonce();
		const verifier = oidc.randomPKCECodeVerifier();
		const target = oidc.buildAuthorizationUrl(config, {
			redirect_uri: callback,
			response_type: "code",
			scope: "openid email",
			state,
			nonce,
			code_challenge_method: "S256",
			code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
		});
		await input.transactions.put(transactionKey(state, secret), {
			nonce,
			verifier,
		});
		const result = response(303);
		result.headers.set("Location", target.href);
		result.headers.append(
			"Set-Cookie",
			`${browserCookie}=${secret}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${transactionLifetimeSeconds}`,
		);
		return result;
	}

	async function complete(request: Request, url: URL) {
		const states = url.searchParams.getAll("state");
		const state = states[0];
		const secret = browserSecret(request);
		if (states.length !== 1 || !state || !opaqueValue.test(state) || !secret)
			return response(400);
		const transaction = await input.transactions.take(
			transactionKey(state, secret),
		);
		if (!transaction) return response(400);
		const config = await configuration();
		let identity: OidcBrowserIdentity;
		try {
			const tokens = await oidc.authorizationCodeGrant(config, url, {
				expectedState: state,
				expectedNonce: transaction.nonce,
				pkceCodeVerifier: transaction.verifier,
				idTokenExpected: true,
			});
			const claims = tokens.claims();
			if (!claims || claims.iss !== input.issuer || !claims.sub)
				return response(401);
			let email = typeof claims.email === "string" ? claims.email : null;
			let verified = claims.email_verified === true;
			if (config.serverMetadata().userinfo_endpoint) {
				const info = await oidc.fetchUserInfo(
					config,
					tokens.access_token,
					claims.sub,
				);
				if (info.email !== undefined) {
					if (
						typeof info.email !== "string" ||
						(email !== null && email !== info.email)
					)
						return response(401);
					verified =
						info.email_verified === true && (email === null || verified);
					email = info.email;
				}
			}
			identity = {
				issuer: claims.iss,
				subject: claims.sub,
				email,
				emailVerified: email !== null && verified,
			};
		} catch {
			return response(401);
		}
		const session = await input.login(identity);
		if (!session.ok) return response(session.status);
		const cookies = session.headers.getSetCookie();
		if (!cookies.length) return response(503);
		const result = response(303);
		for (const cookie of cookies) result.headers.append("Set-Cookie", cookie);
		result.headers.append(
			"Set-Cookie",
			`${browserCookie}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
		);
		result.headers.set("Location", "/");
		return result;
	}

	return {
		async handleRequest(request: Request): Promise<Response | null> {
			const url = new URL(request.url);
			if (
				url.pathname !== loginPath &&
				url.pathname !== callbackPath &&
				url.pathname !== backchannelLogoutPath
			)
				return null;
			if (url.origin !== origin.origin || request.url.length > 8192 || url.hash)
				return response(400);
			try {
				if (url.pathname === backchannelLogoutPath)
					return response(url.search ? 400 : await logout(request));
				if (request.method !== "GET") return response(405);
				if (url.pathname === loginPath)
					return url.search ? response(400) : await start();
				return await complete(request, url);
			} catch {
				return response(503);
			}
		},
	};
}
