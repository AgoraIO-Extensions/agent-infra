import { randomBytes, randomUUID } from "node:crypto";
import {
	type AuditEventStore,
	type AuthenticatedConnectionContext,
	type CatalogEntry,
	type CatalogReader,
	type ConnectionInstallationService,
	type ConnectionTokenService,
	catalogEtag,
	type InstallationProofVerifier,
	type InstallationStore,
	type OAuthAuthorizationService,
	validateActionArguments,
} from "@agent-infra/connection-core";
import {
	type BrowserSessionPrincipal,
	type BrowserSessionService,
	readBrowserSessionCookie,
} from "@agent-infra/connection-identity";
import { Hono } from "hono";

export const connectionApiService = "connection-api";

export interface ConnectionApiDependencies {
	readonly installations?: ConnectionInstallationService;
	readonly browserSession?: {
		readonly service: BrowserSessionService;
		readonly authenticate: (
			username: string,
			password: string,
		) => Promise<BrowserSessionPrincipal | undefined>;
	};
	readonly catalog?: CatalogReader;
	readonly audience?: string;
	readonly publicOrigin?: string;
	readonly authenticate?: (input: {
		request: Request;
		token: string;
		proof: string;
		audience: string;
	}) => Promise<AuthenticatedConnectionContext | undefined>;
	readonly mcp?: {
		readonly validateArguments?: (input: {
			context: AuthenticatedConnectionContext;
			actionVersionId: string;
			arguments: unknown;
		}) => Promise<boolean> | boolean;
		readonly execute: (input: {
			context: AuthenticatedConnectionContext;
			actionVersionId: string;
			arguments: unknown;
			idempotencyKey: string;
			requestId: string;
			traceId: string;
		}) => Promise<Response | unknown>;
	};
	readonly audit?: AuditEventStore;
	readonly oauth?: {
		readonly authorization: OAuthAuthorizationService;
		readonly tokens: ConnectionTokenService;
		readonly installations: InstallationStore;
		readonly proofVerifier: InstallationProofVerifier;
	};
}

function bearerToken(request: Request): string | undefined {
	const value = request.headers.get("authorization");
	if (!value?.startsWith("Bearer ")) return undefined;
	const token = value.slice("Bearer ".length).trim();
	return token && !/\s/.test(token) ? token : undefined;
}

const authoritySelectors = new Set([
	"principalId",
	"consumerId",
	"consumerInstanceId",
	"actorId",
	"connectionId",
	"grantId",
	"credentialVersionId",
	"providerId",
]);

function hasAuthoritySelector(request: Request): boolean {
	const url = new URL(request.url);
	for (const key of url.searchParams.keys())
		if (authoritySelectors.has(key)) return true;
	return false;
}

function cookieValue(request: Request, name: string): string | undefined {
	const cookie = request.headers.get("Cookie");
	if (!cookie) return undefined;
	for (const part of cookie.split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return undefined;
}

function browserMutationAllowed(
	request: Request,
	publicOrigin: string | undefined,
): boolean {
	if (!publicOrigin || request.headers.get("Origin") !== publicOrigin)
		return false;
	const fetchSite = request.headers.get("Sec-Fetch-Site");
	if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site")
		return false;
	const csrf = request.headers.get("X-CSRF-Token");
	return Boolean(
		csrf && csrf === cookieValue(request, "__Host-connection_csrf"),
	);
}

async function oauthForm(
	request: Request,
): Promise<URLSearchParams | undefined> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0];
	if (contentType !== "application/x-www-form-urlencoded") return undefined;
	return new URLSearchParams(await request.text());
}

function accessTokenLifetime(record: { issuedAt: number; expiresAt: number }) {
	return Math.max(0, Math.floor((record.expiresAt - record.issuedAt) / 1000));
}

function proofRequest(request: Request, publicOrigin: string | undefined) {
	const url = new URL(request.url);
	if (publicOrigin) {
		const origin = new URL(publicOrigin);
		url.protocol = origin.protocol;
		url.host = origin.host;
	}
	return { method: request.method, url: url.toString() };
}

export function createConnectionApp(
	dependencies: ConnectionApiDependencies = {},
) {
	const app = new Hono();

	app.get("/healthz", (context) =>
		context.json({
			service: connectionApiService,
			status: "ok",
		}),
	);

	app.post("/v1/browser-session/login", async (context) => {
		const browserSession = dependencies.browserSession;
		if (!browserSession)
			return context.json({ error: "identity_unavailable" }, 503);
		let input: { username?: unknown; password?: unknown };
		try {
			input = await context.req.json();
		} catch {
			return context.json({ error: "invalid_credentials" }, 401);
		}
		if (
			typeof input.username !== "string" ||
			typeof input.password !== "string"
		)
			return context.json({ error: "invalid_credentials" }, 401);
		const principal = await browserSession.authenticate(
			input.username,
			input.password,
		);
		if (!principal) return context.json({ error: "invalid_credentials" }, 401);
		const created = await browserSession.service.create(principal);
		const response = context.json(
			{
				principal: {
					id: principal.id,
					issuer: principal.issuer,
					uid: principal.uid,
				},
				activeState: "directory_entry_exists",
			},
			200,
			{ "Set-Cookie": created.cookie, "Cache-Control": "no-store" },
		);
		response.headers.append(
			"Set-Cookie",
			`__Host-connection_csrf=${randomBytes(32).toString("base64url")}; Path=/; Secure; SameSite=Strict`,
		);
		return response;
	});

	app.post("/v1/installations", async (context) => {
		if (!browserMutationAllowed(context.req.raw, dependencies.publicOrigin))
			return context.json({ error: "csrf_failed" }, 403);
		const browserSession = dependencies.browserSession;
		const installations = dependencies.installations;
		if (!browserSession || !installations)
			return context.json({ error: "installation_unavailable" }, 503);
		const principal = await browserSession.service.resolve(
			readBrowserSessionCookie(context.req.header("Cookie") ?? null),
		);
		if (!principal) return context.json({ error: "unauthenticated" }, 401);
		let input: {
			consumerId?: unknown;
			publicKey?: unknown;
			principalId?: unknown;
			actorId?: unknown;
			consumerInstanceId?: unknown;
		};
		try {
			input = await context.req.json();
		} catch {
			return context.json({ error: "invalid_installation" }, 400);
		}
		if (
			typeof input.consumerId !== "string" ||
			typeof input.publicKey !== "string" ||
			input.principalId !== undefined ||
			input.actorId !== undefined ||
			input.consumerInstanceId !== undefined
		)
			return context.json({ error: "invalid_installation" }, 400);
		try {
			const installation = await installations.register({
				principalId: principal.id,
				consumerId: input.consumerId,
				publicKey: input.publicKey,
			});
			return context.json({
				installation: {
					id: installation.id,
					consumerId: installation.consumerId,
					status: installation.status,
					recoveryGeneration: installation.recoveryGeneration,
				},
			});
		} catch {
			return context.json({ error: "invalid_installation" }, 400);
		}
	});

	app.get("/v1/browser-session", async (context) => {
		const service = dependencies.browserSession?.service;
		if (!service) return context.json({ error: "identity_unavailable" }, 503);
		const principal = await service.resolve(
			readBrowserSessionCookie(context.req.header("Cookie") ?? null),
		);
		if (!principal) return context.json({ error: "unauthenticated" }, 401);
		return context.json({
			principal: {
				id: principal.id,
				issuer: principal.issuer,
				uid: principal.uid,
			},
			activeState: "directory_entry_exists",
		});
	});

	app.post("/v1/oauth/token", async (context) => {
		const oauth = dependencies.oauth;
		if (!oauth) return context.json({ error: "oauth_unavailable" }, 503);
		const form = await oauthForm(context.req.raw);
		const proof = context.req.header("DPoP") ?? "";
		if (!form || !proof || !oauth.proofVerifier.verifyInstallation)
			return context.json({ error: "invalid_request" }, 400);
		const request = proofRequest(context.req.raw, dependencies.publicOrigin);
		try {
			if (form.get("grant_type") === "authorization_code") {
				const code = form.get("code");
				const clientId = form.get("client_id");
				const redirectUri = form.get("redirect_uri");
				const codeVerifier = form.get("code_verifier");
				if (!code || !clientId || !redirectUri || !codeVerifier)
					return context.json({ error: "invalid_request" }, 400);
				const inspected = await oauth.authorization.inspectAuthorizationCode({
					secret: code,
					clientId,
					redirectUri,
					codeVerifier,
				});
				if (!inspected) return context.json({ error: "invalid_grant" }, 400);
				const installation = await oauth.installations.findById(
					inspected.consumerInstanceId,
				);
				if (
					!installation ||
					!(await oauth.proofVerifier.verifyInstallation({
						installation,
						proof,
						request,
					}))
				)
					return context.json({ error: "invalid_grant" }, 400);
				const codeContext = await oauth.authorization.redeemAuthorizationCode({
					secret: code,
					clientId,
					redirectUri,
					codeVerifier,
				});
				if (!codeContext) return context.json({ error: "invalid_grant" }, 400);
				const access = await oauth.tokens.issue({
					kind: "oauth_access",
					installation,
					audience: codeContext.audience,
					scopes: codeContext.scopes,
					recoveryGeneration: codeContext.recoveryGeneration,
				});
				const refresh =
					await oauth.authorization.issueRefreshToken(codeContext);
				return context.json({
					access_token: access.secret,
					refresh_token: refresh.secret,
					token_type: "DPoP",
					expires_in: accessTokenLifetime(access.record),
				});
			}
			if (form.get("grant_type") === "refresh_token") {
				const secret = form.get("refresh_token");
				if (!secret) return context.json({ error: "invalid_request" }, 400);
				const current = await oauth.authorization.inspectRefreshToken(secret);
				if (!current) return context.json({ error: "invalid_grant" }, 400);
				const installation = await oauth.installations.findById(
					current.consumerInstanceId,
				);
				if (
					!installation ||
					!(await oauth.proofVerifier.verifyInstallation({
						installation,
						proof,
						request,
					}))
				)
					return context.json({ error: "invalid_grant" }, 400);
				const rotated = await oauth.authorization.rotateRefreshToken({
					secret,
					context: current,
				});
				if (!rotated) return context.json({ error: "invalid_grant" }, 400);
				const access = await oauth.tokens.issue({
					kind: "oauth_access",
					installation,
					audience: current.audience,
					scopes: current.scopes,
					recoveryGeneration: current.recoveryGeneration,
				});
				return context.json({
					access_token: access.secret,
					refresh_token: rotated.secret,
					token_type: "DPoP",
					expires_in: accessTokenLifetime(access.record),
				});
			}
		} catch {
			return context.json({ error: "invalid_grant" }, 400);
		}
		return context.json({ error: "unsupported_grant_type" }, 400);
	});

	app.delete("/v1/browser-session", async (context) => {
		if (!browserMutationAllowed(context.req.raw, dependencies.publicOrigin))
			return context.json({ error: "csrf_failed" }, 403);
		const service = dependencies.browserSession?.service;
		if (!service) return context.json({ error: "identity_unavailable" }, 503);
		await service.revoke(
			readBrowserSessionCookie(context.req.header("Cookie") ?? null),
		);
		return new Response(null, {
			status: 204,
			headers: {
				"Set-Cookie":
					"__Host-connection_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
				"Cache-Control": "no-store",
			},
		});
	});

	app.get("/v1/catalog", async (context) => {
		if (!dependencies.catalog || !dependencies.authenticate)
			return context.json({ error: "catalog_unavailable" }, 503);
		if (hasAuthoritySelector(context.req.raw))
			return context.json({ error: "authority_selectors_not_allowed" }, 400);
		const token = bearerToken(context.req.raw);
		const authentication = token
			? await dependencies.authenticate({
					request: context.req.raw,
					token,
					proof: context.req.header("DPoP") ?? "",
					audience: dependencies.audience ?? "connection-api",
				})
			: undefined;
		if (!authentication)
			return context.json({ error: "invalid_token" }, 401, {
				"WWW-Authenticate": 'Bearer realm="connection", error="invalid_token"',
			});
		const entries = await dependencies.catalog.list(authentication);
		const body = {
			version: 1,
			entries: entries.map((entry) => ({
				provider: {
					id: entry.provider.id,
					name: entry.provider.name,
					status: entry.provider.status,
				},
				actionVersion: {
					id: entry.actionVersion.id,
					actionId: entry.actionVersion.actionId,
					version: entry.actionVersion.version,
					effect: entry.actionVersion.effect,
					inputSchema: entry.actionVersion.inputSchema,
					outputSchema: entry.actionVersion.outputSchema,
					requiredScopes: entry.actionVersion.requiredScopes,
					status: entry.actionVersion.status,
				},
			})),
		};
		const etag = catalogEtag(body.entries);
		if (context.req.header("If-None-Match") === etag)
			return new Response(null, { status: 304, headers: { ETag: etag } });
		return context.json(body, 200, {
			ETag: etag,
			"Cache-Control": "private, no-store",
		});
	});

	app.post("/v1/mcp", async (context) => {
		if (
			!dependencies.mcp ||
			!dependencies.authenticate ||
			!dependencies.audit ||
			(!dependencies.catalog && !dependencies.mcp.validateArguments)
		)
			return context.json({ error: "mcp_unavailable" }, 503);
		const token = bearerToken(context.req.raw);
		const authentication = token
			? await dependencies.authenticate({
					request: context.req.raw,
					token,
					proof: context.req.header("DPoP") ?? "",
					audience: dependencies.audience ?? "connection-api",
				})
			: undefined;
		if (!authentication) return context.json({ error: "invalid_token" }, 401);
		let input: Record<string, unknown>;
		try {
			const parsed: unknown = await context.req.json();
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			)
				return context.json({ error: "invalid_request" }, 400);
			input = parsed as Record<string, unknown>;
		} catch {
			return context.json({ error: "invalid_request" }, 400);
		}
		for (const key of authoritySelectors)
			if (key in input)
				return context.json({ error: "authority_selectors_not_allowed" }, 400);
		if (
			typeof input.actionVersionId !== "string" ||
			typeof input.idempotencyKey !== "string" ||
			input.idempotencyKey.length === 0
		)
			return context.json({ error: "invalid_request" }, 400);
		if (dependencies.catalog) {
			let entries: readonly CatalogEntry[];
			try {
				entries = await dependencies.catalog.list(authentication);
			} catch {
				return context.json({ error: "mcp_unavailable" }, 503);
			}
			const entry = entries.find(
				(candidate) => candidate.actionVersion.id === input.actionVersionId,
			);
			if (
				!entry ||
				!validateActionArguments(
					entry.actionVersion.inputSchema,
					input.arguments,
				)
			)
				return context.json({ error: "invalid_arguments" }, 400);
		}
		if (
			dependencies.mcp.validateArguments &&
			!(await dependencies.mcp.validateArguments({
				context: authentication,
				actionVersionId: input.actionVersionId,
				arguments: input.arguments,
			}))
		)
			return context.json({ error: "invalid_arguments" }, 400);
		const requestId = randomUUID();
		// Ignore caller-supplied traceparent values. Connection owns the
		// authoritative correlation identifier.
		const traceId = randomUUID();
		await dependencies.audit.insert({
			id: randomUUID(),
			traceId,
			principalId: authentication.principalId,
			consumerInstanceId: authentication.consumerInstanceId,
			actorId: authentication.actorId ?? undefined,
			action: "mcp.admission",
			targetType: "action_version",
			targetId: input.actionVersionId,
			outcome: "succeeded",
			metadata: {
				phase: "admitted",
				requestId,
				tokenId: authentication.tokenId,
			},
		});
		const result = await dependencies.mcp.execute({
			context: authentication,
			actionVersionId: input.actionVersionId,
			arguments: input.arguments,
			idempotencyKey: input.idempotencyKey,
			requestId,
			traceId,
		});
		return result instanceof Response ? result : context.json(result);
	});

	return app;
}
