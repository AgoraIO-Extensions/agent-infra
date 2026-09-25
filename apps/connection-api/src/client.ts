import { randomUUID } from "node:crypto";
import {
	ClientAuthorizationDenied,
	hashClientSecret,
	InvalidDpopProof,
	opaqueClientSecret,
	readBrowserSessionCookie,
	verifyDpopProof,
} from "@agent-infra/connection-core";
import type {
	createConnectionAuthorityRepository,
	createConnectionClientRepository,
} from "@agent-infra/connection-store";
import {
	DirectConsentRequestV1Schema,
	DirectInstallRequestV1Schema,
	DirectTokenRequestV1Schema,
} from "@agent-infra/contracts/pilot";
import type { Context, Hono } from "hono";
import {
	type ConnectionAuthDependencies,
	csrfToken,
	sameOriginRequest,
	validCsrf,
} from "./auth.js";

export interface ConnectionClientDependencies {
	repository: ReturnType<typeof createConnectionClientRepository>;
	authority?: ReturnType<typeof createConnectionAuthorityRepository>;
	auth: ConnectionAuthDependencies;
	audience: string;
	recheckPrincipal: (principalId: string) => Promise<void>;
}

const noStore = { "Cache-Control": "no-store" };

class InvalidClientRequest extends Error {}
class ClientForbidden extends Error {}

async function readLimitedBody(context: Context, contentType?: string) {
	const actualType = context.req.header("content-type");
	if (
		contentType &&
		actualType !== contentType &&
		!actualType?.startsWith(`${contentType};`)
	)
		throw new InvalidClientRequest();
	const declaredLength = context.req.header("content-length");
	if (declaredLength && Number(declaredLength) > 8192)
		throw new InvalidClientRequest();
	const reader = context.req.raw.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 8192) {
			await reader.cancel();
			throw new InvalidClientRequest();
		}
		chunks.push(value);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks),
		);
	} catch {
		throw new InvalidClientRequest();
	}
}

async function browserPrincipal(
	context: Context,
	auth: ConnectionAuthDependencies,
	mutation: boolean,
) {
	const token = readBrowserSessionCookie(context.req.header("cookie"));
	if (!token) throw new ClientAuthorizationDenied();
	if (
		mutation &&
		(!sameOriginRequest(
			context.req.header("origin"),
			context.req.header("sec-fetch-site"),
			auth.publicOrigin,
		) ||
			!validCsrf(
				context.req.header("x-csrf-token"),
				csrfToken(token, auth.csrfKey),
			))
	)
		throw new ClientForbidden();
	const principal = await auth.service.currentSession(token);
	if (!principal) throw new ClientAuthorizationDenied();
	return { principal, sessionHash: hashClientSecret(token) };
}

function proofFor(
	context: Context,
	publicOrigin: string,
	expectedThumbprint?: string,
	accessToken?: string,
) {
	return verifyDpopProof({
		proof: context.req.header("dpop"),
		method: context.req.method,
		url: new URL(context.req.path, publicOrigin).href,
		expectedThumbprint,
		accessToken,
	});
}

function directBearerToken(context: Context): string {
	const token = /^DPoP ([A-Za-z0-9_-]{43})$/.exec(
		context.req.header("authorization") ?? "",
	)?.[1];
	if (!token) throw new ClientAuthorizationDenied();
	return token;
}

const oauthMessages = {
	invalid_request: "Invalid request",
	invalid_grant: "Authorization denied",
	forbidden: "Request forbidden",
	unsupported_grant_type: "Unsupported grant type",
	temporarily_unavailable: "Service temporarily unavailable",
} as const;

function clientError(
	context: Context,
	code: keyof typeof oauthMessages,
	status: 400 | 401 | 403 | 503,
) {
	return context.json(
		{
			error: code,
			message: oauthMessages[code],
			traceId: randomUUID(),
			retryable: status === 503,
		},
		status,
		noStore,
	);
}

function oauthError(context: Context, error: unknown) {
	if (error instanceof InvalidClientRequest || error instanceof SyntaxError)
		return clientError(context, "invalid_request", 400);
	if (error instanceof ClientForbidden)
		return clientError(context, "forbidden", 403);
	if (
		error instanceof ClientAuthorizationDenied ||
		error instanceof InvalidDpopProof
	)
		return clientError(context, "invalid_grant", 401);
	return clientError(context, "temporarily_unavailable", 503);
}

function tokenResponse(
	context: Context,
	accessToken: string,
	refreshToken: string,
	scopes: readonly string[],
) {
	return context.json(
		{
			access_token: accessToken,
			refresh_token: refreshToken,
			token_type: "DPoP",
			expires_in: 900,
			scope: scopes.join(" "),
		},
		200,
		noStore,
	);
}

export async function authenticateDirectClient(
	context: Context,
	client: ConnectionClientDependencies,
	requiredScope?: string,
) {
	const token = directBearerToken(context);
	const credential = await client.repository.credentialByToken(token);
	if (
		!credential ||
		(credential.kind !== "access" && credential.kind !== "pat")
	)
		throw new ClientAuthorizationDenied();
	const proof = proofFor(
		context,
		client.auth.publicOrigin,
		credential.keyThumbprint,
		token,
	);
	await client.recheckPrincipal(credential.principalId);
	return client.repository.useCredential({
		token,
		proof,
		kind: credential.kind,
		audience: client.audience,
		requiredScope,
	});
}

export function addConnectionClientRoutes(
	app: Hono,
	client: ConnectionClientDependencies,
) {
	app.post("/oauth/install", async (context) => {
		let body: ReturnType<typeof DirectInstallRequestV1Schema.parse>;
		try {
			body = DirectInstallRequestV1Schema.parse(
				JSON.parse(await readLimitedBody(context, "application/json")),
			);
		} catch {
			return clientError(context, "invalid_request", 400);
		}
		try {
			const proof = proofFor(context, client.auth.publicOrigin);
			const id = await client.repository.beginInstallation(
				{
					consumerId: body.client_id,
					redirectUri: body.redirect_uri,
					state: body.state,
					codeChallenge: body.code_challenge,
					codeChallengeMethod: body.code_challenge_method,
					scope: body.scope,
				},
				proof,
				client.audience,
			);
			return context.json(
				{
					authorization_uri: new URL(
						`/oauth/authorize/${id}`,
						client.auth.publicOrigin,
					).href,
				},
				201,
				noStore,
			);
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.get("/oauth/authorize/:id", async (context) => {
		try {
			const browser = await browserPrincipal(context, client.auth, true);
			const request = await client.repository.installationForConsent(
				context.req.param("id"),
				browser.principal.id,
				browser.sessionHash,
			);
			return context.json(request, 200, noStore);
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.post("/oauth/authorize/:id", async (context) => {
		try {
			const browser = await browserPrincipal(context, client.auth, true);
			const body = DirectConsentRequestV1Schema.safeParse(
				JSON.parse(await readLimitedBody(context, "application/json")),
			);
			if (!body.success) return clientError(context, "invalid_request", 400);
			const redirect = await client.repository.approveInstallation(
				context.req.param("id"),
				browser.principal.id,
				browser.sessionHash,
				opaqueClientSecret(),
			);
			const response = context.redirect(redirect, 303);
			response.headers.set("Cache-Control", "no-store");
			return response;
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.post("/oauth/token", async (context) => {
		let form: ReturnType<typeof DirectTokenRequestV1Schema.parse>;
		try {
			const values = new URLSearchParams(
				await readLimitedBody(context, "application/x-www-form-urlencoded"),
			);
			if ([...values.keys()].some((key) => values.getAll(key).length !== 1))
				throw new InvalidClientRequest();
			const grantType = values.get("grant_type");
			if (grantType !== "authorization_code" && grantType !== "refresh_token")
				return clientError(context, "unsupported_grant_type", 400);
			const parsed = DirectTokenRequestV1Schema.safeParse(
				Object.fromEntries(values),
			);
			if (!parsed.success) throw new InvalidClientRequest();
			form = parsed.data;
		} catch {
			return clientError(context, "invalid_request", 400);
		}
		try {
			const grantType = form.grant_type;
			if (grantType === "authorization_code") {
				const code = form.code;
				const stored = await client.repository.authorizationCode(code);
				if (!stored) throw new ClientAuthorizationDenied();
				const proof = proofFor(
					context,
					client.auth.publicOrigin,
					stored.keyThumbprint,
				);
				await client.recheckPrincipal(stored.principalId);
				const accessToken = opaqueClientSecret();
				const refreshToken = opaqueClientSecret();
				const result = await client.repository.redeemCode({
					code,
					verifier: form.code_verifier,
					consumerId: form.client_id,
					redirectUri: form.redirect_uri,
					proof,
					accessToken,
					refreshToken,
				});
				return tokenResponse(context, accessToken, refreshToken, result.scopes);
			}
			if (grantType === "refresh_token") {
				const refreshToken = form.refresh_token;
				const stored = await client.repository.credentialByToken(refreshToken);
				if (stored?.kind !== "refresh") throw new ClientAuthorizationDenied();
				const proof = proofFor(
					context,
					client.auth.publicOrigin,
					stored.keyThumbprint,
				);
				await client.recheckPrincipal(stored.principalId);
				const accessToken = opaqueClientSecret();
				const nextRefreshToken = opaqueClientSecret();
				const result = await client.repository.rotateRefresh({
					refreshToken,
					proof,
					audience: client.audience,
					consumerId: form.client_id,
					accessToken,
					nextRefreshToken,
				});
				if (!result) throw new ClientAuthorizationDenied();
				return tokenResponse(
					context,
					accessToken,
					nextRefreshToken,
					result.scopes,
				);
			}
			return clientError(context, "unsupported_grant_type", 400);
		} catch (error) {
			return error instanceof InvalidClientRequest
				? clientError(context, "invalid_request", 400)
				: oauthError(context, error);
		}
	});

	app.post("/oauth/pat", async (context) => {
		try {
			if (await readLimitedBody(context))
				return clientError(context, "invalid_request", 400);
			const token = directBearerToken(context);
			await authenticateDirectClient(context, client, "pat:issue");
			const pat = opaqueClientSecret();
			const id = await client.repository.issuePat({
				accessToken: token,
				pat,
				audience: client.audience,
			});
			return context.json({ token: pat, token_type: "DPoP", id }, 201, noStore);
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.post("/oauth/pat/rotate", async (context) => {
		try {
			if (await readLimitedBody(context))
				return clientError(context, "invalid_request", 400);
			const token = directBearerToken(context);
			const stored = await client.repository.credentialByToken(token);
			if (stored?.kind !== "pat") throw new ClientAuthorizationDenied();
			await authenticateDirectClient(context, client);
			const nextPat = opaqueClientSecret();
			const id = await client.repository.rotatePat({
				currentPat: token,
				nextPat,
				audience: client.audience,
			});
			return context.json(
				{ token: nextPat, token_type: "DPoP", id },
				200,
				noStore,
			);
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.post("/oauth/revoke", async (context) => {
		try {
			if (await readLimitedBody(context))
				return clientError(context, "invalid_request", 400);
			const token = directBearerToken(context);
			const stored = await client.repository.credentialByToken(token);
			if (stored?.kind !== "access") throw new ClientAuthorizationDenied();
			await authenticateDirectClient(context, client);
			await client.repository.revokeFamily(token, client.audience);
			return context.body(null, 204, noStore);
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.post("/oauth/instances/:id/revoke", async (context) => {
		try {
			if (await readLimitedBody(context))
				return clientError(context, "invalid_request", 400);
			const browser = await browserPrincipal(context, client.auth, true);
			await client.repository.revokeInstance(
				browser.principal.id,
				context.req.param("id"),
			);
			return context.body(null, 204, noStore);
		} catch (error) {
			return oauthError(context, error);
		}
	});

	app.post("/oauth/pats/:id/revoke", async (context) => {
		try {
			if (await readLimitedBody(context))
				return clientError(context, "invalid_request", 400);
			const browser = await browserPrincipal(context, client.auth, true);
			await client.repository.revokePat(
				browser.principal.id,
				context.req.param("id"),
			);
			return context.body(null, 204, noStore);
		} catch (error) {
			return oauthError(context, error);
		}
	});
}
