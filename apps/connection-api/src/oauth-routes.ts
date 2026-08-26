import { randomUUID } from "node:crypto";
import {
	authorizationConsentRequestSchema,
	authorizationPreviewRequestSchema,
	connectionBrowserOpenApi,
	idempotencyKeySchema,
	issueTokenRequestSchema,
	loginRequestSchema,
	oauthTransactionRequestSchema,
	sharedScopeNameSchema,
} from "@agent-infra/connection-contracts";
import {
	type ConnectionApplicationService,
	ConnectionError,
	type ConnectionOAuthService,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export type ConnectionOAuthServerOptions = {
	browserCommands?: {
		execute: <T>(
			input: {
				idempotencyKey: string;
				operation: string;
				replayable?: boolean;
				request: unknown;
				subject: string;
			},
			command: () => Promise<T>,
		) => Promise<T>;
	};
	dynamicClientRegistration?: { clientName: string };
	issuer: string;
	management?: {
		githubRedirectUri: string;
		service: ConnectionApplicationService;
	};
	resource: string;
	service: ConnectionOAuthService;
};

const browserSessionCookie = "connection_session";
const browserSessionCookiePath = "/";

const dynamicRegistrationFields = new Set([
	"application_type",
	"client_name",
	"grant_types",
	"redirect_uris",
	"response_types",
	"scope",
	"token_endpoint_auth_method",
]);

function exactStringArray(value: unknown, expected: string[]) {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((item, index) => item === expected[index])
	);
}

function isCodexLoopbackRedirect(value: unknown) {
	if (typeof value !== "string") return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const port = Number(url.port);
	return (
		url.protocol === "http:" &&
		url.hostname === "127.0.0.1" &&
		Number.isInteger(port) &&
		port >= 1_024 &&
		port <= 65_535 &&
		/^\/callback\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname) &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash
	);
}

function isApprovedDynamicRegistration(
	body: Record<string, unknown>,
	clientName: string,
) {
	return (
		Object.keys(body).every((field) => dynamicRegistrationFields.has(field)) &&
		body.application_type === "native" &&
		body.client_name === clientName &&
		exactStringArray(body.grant_types, [
			"authorization_code",
			"refresh_token",
		]) &&
		exactStringArray(body.response_types, ["code"]) &&
		body.scope === "mcp" &&
		body.token_endpoint_auth_method === "none" &&
		Array.isArray(body.redirect_uris) &&
		body.redirect_uris.length === 1 &&
		isCodexLoopbackRedirect(body.redirect_uris[0])
	);
}

function oauthError(error: OAuthProtocolError) {
	return { error: error.error, error_description: error.message };
}

function html(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function loginPage(input: {
	clientName: string;
	error?: string;
	requestId?: string;
}) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 Connection</title>
<style>
:root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; color: #171717; background: #f5f5f4; }
* { box-sizing: border-box; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; }
main { width: min(100%, 360px); }
h1 { margin: 0 0 8px; font-size: 24px; font-weight: 650; letter-spacing: 0; }
p { margin: 0 0 24px; color: #57534e; font-size: 14px; line-height: 1.5; }
label { display: block; margin: 0 0 6px; font-size: 13px; font-weight: 600; }
input { width: 100%; height: 42px; margin: 0 0 16px; padding: 0 12px; border: 1px solid #a8a29e; border-radius: 6px; background: white; font: inherit; }
input:focus { outline: 3px solid #bfdbfe; border-color: #2563eb; }
button { width: 100%; height: 42px; border: 0; border-radius: 6px; background: #166534; color: white; font: inherit; font-weight: 650; cursor: pointer; }
button:hover { background: #14532d; }
.error { margin-bottom: 16px; color: #b91c1c; }
</style>
</head>
<body>
<main>
<h1>登录 Connection</h1>
<p>继续访问 ${html(input.clientName)}</p>
${input.error ? `<p class="error" role="alert">${html(input.error)}</p>` : ""}
${
	input.requestId
		? `
<form method="post" action="/oauth/login">
<input type="hidden" name="request_id" value="${html(input.requestId)}">
<label for="username">公司账号</label>
<input id="username" name="username" type="text" autocomplete="username" required maxlength="256" autofocus>
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<button type="submit">登录并继续</button>
</form>
		`
		: ""
}
</main>
</body>
</html>`;
}

function browserAccountProjection(account: {
	displayName: string;
	email: string | null;
}) {
	return { displayName: account.displayName, email: account.email };
}

function secureHtmlHeaders(
	context: { header(name: string, value: string): void },
	options: { allowLoopbackFormRedirect?: boolean } = {},
) {
	context.header("cache-control", "no-store");
	const formAction = options.allowLoopbackFormRedirect
		? "'self' http://127.0.0.1:*"
		: "'self'";
	context.header(
		"content-security-policy",
		`default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
	);
	context.header("referrer-policy", "no-referrer");
	context.header("x-content-type-options", "nosniff");
	context.header("x-frame-options", "DENY");
}

function browserApiError(
	context: Context,
	input: {
		code: string;
		messageKey: string;
		retryable?: boolean;
		status: 400 | 401 | 403 | 404 | 409 | 500;
	},
) {
	context.header("cache-control", "no-store");
	return context.json(
		{
			error: {
				code: input.code,
				messageKey: input.messageKey,
				retryable: input.retryable ?? false,
				traceId: randomUUID(),
			},
		},
		input.status,
	);
}

function browserConnectionError(context: Context, error: ConnectionError) {
	return browserApiError(context, {
		code: error.code,
		messageKey:
			error.code === "FORBIDDEN" || error.code === "RESOURCE_NOT_FOUND"
				? "connection.error.resource_not_found"
				: error.code === "IDEMPOTENCY_CONFLICT"
					? "connection.error.idempotency_conflict"
					: error.code === "RESULT_UNCERTAIN"
						? "connection.error.result_uncertain"
						: "connection.error.request_failed",
		status:
			error.code === "FORBIDDEN" || error.code === "RESOURCE_NOT_FOUND"
				? 404
				: error.code === "INVALID_REQUEST"
					? 400
					: 409,
	});
}

async function browserApiOperation<T>(
	context: Context,
	operation: () => Promise<T>,
): Promise<Response | T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof ConnectionError) {
			return browserConnectionError(context, error);
		}
		if (error instanceof OAuthProtocolError) {
			return browserApiError(context, {
				code:
					error.error === "invalid_token"
						? "AUTHENTICATION_REQUIRED"
						: "INVALID_REQUEST",
				messageKey:
					error.error === "invalid_token"
						? "connection.error.authentication_required"
						: "connection.error.request_failed",
				status: error.error === "invalid_token" ? 401 : 400,
			});
		}
		throw error;
	}
}

function parseJsonBody<T>(
	schema: {
		safeParse: (
			value: unknown,
		) => { data: T; success: true } | { error: unknown; success: false };
	},
	body: unknown,
) {
	const result = schema.safeParse(body);
	if (!result.success) {
		throw new OAuthProtocolError("invalid_request", "Invalid JSON body");
	}
	return result.data;
}

function requireIdempotencyKey(context: Context) {
	const result = idempotencyKeySchema.safeParse(
		context.req.header("idempotency-key") ?? "",
	);
	if (!result.success) {
		throw new OAuthProtocolError("invalid_request", "Invalid Idempotency-Key");
	}
	return result.data;
}

function browserCommand<T>(
	options: ConnectionOAuthServerOptions,
	context: Context,
	input: {
		operation: string;
		replayable?: boolean;
		request: unknown;
		subject: string;
	},
	command: () => Promise<T>,
) {
	const idempotencyKey = requireIdempotencyKey(context);
	return options.browserCommands
		? options.browserCommands.execute({ ...input, idempotencyKey }, command)
		: command();
}

function formValue(form: FormData, name: string) {
	const value = form.get(name);
	return typeof value === "string" ? value : "";
}

function endpoint(path: string, issuer: string) {
	return new URL(path, issuer).toString();
}

function browserCookieOptions(issuer: string) {
	const issuerUrl = new URL(issuer);
	const loopbackHttp =
		issuerUrl.protocol === "http:" &&
		(issuerUrl.hostname === "127.0.0.1" || issuerUrl.hostname === "[::1]");
	if (issuerUrl.protocol !== "https:" && !loopbackHttp) {
		throw new Error(
			"Connection browser sessions require HTTPS or exact loopback",
		);
	}
	return {
		httpOnly: true,
		path: browserSessionCookiePath,
		sameSite: "Strict" as const,
		secure: issuerUrl.protocol === "https:",
	};
}

function requireSameOrigin(headers: Headers, issuer: string) {
	const issuerUrl = new URL(issuer);
	const origin = headers.get("origin");
	if (origin === issuerUrl.origin) return;
	if (
		origin === "null" &&
		headers.get("sec-fetch-site") === "same-origin" &&
		headers.get("host") === issuerUrl.host
	) {
		return;
	}
	throw new OAuthProtocolError("invalid_request", "Invalid form origin");
}

export function createConnectionOAuthApp(
	options: ConnectionOAuthServerOptions,
) {
	const app = new Hono();
	const cookieOptions = browserCookieOptions(options.issuer);

	const currentBrowserAccount = async (context: Context) => {
		const sessionToken = getCookie(context, browserSessionCookie);
		try {
			return {
				account: await options.service.getBrowserAccount(sessionToken),
				sessionToken,
			};
		} catch (error) {
			if (
				!(error instanceof OAuthProtocolError) ||
				error.error !== "invalid_token"
			) {
				throw error;
			}
			deleteCookie(context, browserSessionCookie, cookieOptions);
			return undefined;
		}
	};

	app.onError((error, context) => {
		if (context.req.path.startsWith("/api/v1/connection/")) {
			if (error instanceof ConnectionError) {
				return browserConnectionError(context, error);
			}
			if (error instanceof OAuthProtocolError) {
				return browserApiError(context, {
					code:
						error.error === "invalid_token"
							? "AUTHENTICATION_REQUIRED"
							: "INVALID_REQUEST",
					messageKey:
						error.error === "invalid_token"
							? "connection.error.authentication_required"
							: "connection.error.invalid_request",
					status: error.error === "invalid_token" ? 401 : 400,
				});
			}
			console.error(
				JSON.stringify({
					errorType: error instanceof Error ? error.name : typeof error,
					event: "connection_browser_api_request_failure",
				}),
			);
			return browserApiError(context, {
				code: "INTERNAL_ERROR",
				messageKey: "connection.error.server_error",
				retryable: true,
				status: 500,
			});
		}
		if (error instanceof OAuthProtocolError) {
			context.header("cache-control", "no-store");
			return context.json(oauthError(error), error.status === 401 ? 401 : 400);
		}
		console.error(
			JSON.stringify({
				errorType: error instanceof Error ? error.name : typeof error,
				event: "connection_oauth_request_failure",
			}),
		);
		context.header("cache-control", "no-store");
		return context.json(
			{ error: "server_error", error_description: "OAuth request failed" },
			500,
		);
	});

	app.get("/.well-known/oauth-authorization-server", (context) => {
		const metadata: Record<string, unknown> = {
			authorization_endpoint: endpoint("/oauth/authorize", options.issuer),
			authorization_response_iss_parameter_supported: true,
			code_challenge_methods_supported: ["S256"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			issuer: options.issuer,
			response_types_supported: ["code"],
			revocation_endpoint: endpoint("/oauth/revoke", options.issuer),
			scopes_supported: ["mcp"],
			token_endpoint: endpoint("/oauth/token", options.issuer),
			token_endpoint_auth_methods_supported: ["none"],
		};
		if (options.dynamicClientRegistration) {
			metadata.registration_endpoint = endpoint(
				"/oauth/register",
				options.issuer,
			);
		}
		return context.json(metadata);
	});

	const dynamicClientRegistration = options.dynamicClientRegistration;
	if (dynamicClientRegistration) {
		app.post("/oauth/register", async (context) => {
			const body = (await context.req.json().catch(() => undefined)) as
				| Record<string, unknown>
				| undefined;
			if (
				!body ||
				!isApprovedDynamicRegistration(
					body,
					dynamicClientRegistration.clientName,
				)
			) {
				throw new OAuthProtocolError(
					"invalid_request",
					"Invalid client metadata",
				);
			}
			const client = await options.service.registerClient({
				clientName: body.client_name as string,
				redirectUris: body.redirect_uris as string[],
			});
			return context.json(
				{
					application_type: "native",
					client_id: client.clientId,
					client_id_issued_at: Math.floor(Date.now() / 1_000),
					client_name: client.clientName,
					grant_types: ["authorization_code", "refresh_token"],
					redirect_uris: client.redirectUris,
					response_types: ["code"],
					scope: "mcp",
					token_endpoint_auth_method: "none",
				},
				201,
			);
		});
	}

	app.get("/api/v1/connection/openapi.json", (context) => {
		context.header("cache-control", "no-store");
		return context.json(connectionBrowserOpenApi);
	});

	app.get("/api/v1/connection/session", async (context) => {
		const session = await currentBrowserAccount(context);
		if (!session) {
			return browserApiError(context, {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.authentication_required",
				status: 401,
			});
		}
		context.header("cache-control", "no-store");
		return context.json({
			account: browserAccountProjection(session.account),
			isAdministrator: options.management
				? await options.management.service.isConnectionAdministrator(
						session.account.principalId,
					)
				: false,
		});
	});

	app.post("/api/v1/connection/session", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const body = parseJsonBody(
			loginRequestSchema,
			await context.req.json().catch(() => undefined),
		);
		requireIdempotencyKey(context);
		try {
			const login = await browserCommand(
				options,
				context,
				{
					operation: "connection.session.login",
					replayable: false,
					request: body,
					subject: `login:${body.username.trim().toLowerCase()}`,
				},
				() => options.service.loginBrowserSession(body),
			);
			setCookie(context, browserSessionCookie, login.sessionToken, {
				...cookieOptions,
				expires: login.expiresAt,
				maxAge: Math.max(
					0,
					Math.floor((login.expiresAt.getTime() - Date.now()) / 1_000),
				),
			});
			context.header("cache-control", "no-store");
			return context.json({
				account: browserAccountProjection(login.account),
				isAdministrator: options.management
					? await options.management.service.isConnectionAdministrator(
							login.account.principalId,
						)
					: false,
			});
		} catch (error) {
			if (
				!(error instanceof OAuthProtocolError) ||
				(error.error !== "access_denied" && error.error !== "invalid_request")
			) {
				throw error;
			}
			return browserApiError(context, {
				code: "AUTHENTICATION_FAILED",
				messageKey: "connection.error.authentication_failed",
				status: 401,
			});
		}
	});

	app.delete("/api/v1/connection/session", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const sessionToken = getCookie(context, browserSessionCookie);
		await browserCommand(
			options,
			context,
			{
				operation: "connection.session.logout",
				request: {},
				subject: `session:${sessionToken ?? "missing"}`,
			},
			() => options.service.logoutBrowserSession(sessionToken),
		);
		deleteCookie(context, browserSessionCookie, cookieOptions);
		context.header("cache-control", "no-store");
		return context.body(null, 204);
	});

	app.get("/api/v1/connection/tokens", async (context) => {
		const session = await currentBrowserAccount(context);
		if (!session) {
			return browserApiError(context, {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.authentication_required",
				status: 401,
			});
		}
		context.header("cache-control", "no-store");
		return context.json({
			tokens: await options.service.listPersonalAccessTokens(
				session.sessionToken,
			),
		});
	});

	app.post("/api/v1/connection/tokens", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const session = await currentBrowserAccount(context);
		if (!session) {
			return browserApiError(context, {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.authentication_required",
				status: 401,
			});
		}
		const body = parseJsonBody(
			issueTokenRequestSchema,
			await context.req.json().catch(() => undefined),
		);
		try {
			const issued = await browserCommand(
				options,
				context,
				{
					operation: "connection.token.issue",
					replayable: false,
					request: body,
					subject: session.account.principalId,
				},
				() =>
					options.service.issuePersonalAccessToken({
						name: body.name,
						sessionToken: session.sessionToken,
					}),
			);
			context.header("cache-control", "no-store");
			return context.json({ issued }, 201);
		} catch (error) {
			if (
				!(error instanceof OAuthProtocolError) ||
				error.error !== "invalid_request"
			) {
				throw error;
			}
			return browserApiError(context, {
				code: "INVALID_REQUEST",
				messageKey: "connection.error.invalid_token_name",
				status: 400,
			});
		}
	});

	app.delete("/api/v1/connection/tokens/:tokenId", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const session = await currentBrowserAccount(context);
		if (!session) {
			return browserApiError(context, {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.authentication_required",
				status: 401,
			});
		}
		const tokenId = context.req.param("tokenId");
		await browserCommand(
			options,
			context,
			{
				operation: "connection.token.revoke",
				request: { tokenId },
				subject: session.account.principalId,
			},
			() =>
				options.service.revokePersonalAccessToken({
					sessionToken: session.sessionToken,
					tokenId,
				}),
		);
		context.header("cache-control", "no-store");
		return context.body(null, 204);
	});

	if (options.management) {
		const management = options.management;
		const currentBrowserApiAccount = async (context: Context) => {
			const session = await currentBrowserAccount(context);
			if (session) return session;
			return browserApiError(context, {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.authentication_required",
				status: 401,
			});
		};
		const currentBrowserApiAdministrator = async (context: Context) => {
			const session = await currentBrowserApiAccount(context);
			if (session instanceof Response) return session;
			if (
				!(await management.service.authorizeConnectionAdministration(
					session.account.principalId,
				))
			) {
				return browserApiError(context, {
					code: "RESOURCE_NOT_FOUND",
					messageKey: "connection.error.resource_not_found",
					status: 404,
				});
			}
			return session;
		};

		app.get("/api/v1/connection/connections", async (context) => {
			const session = await currentBrowserApiAccount(context);
			if (session instanceof Response) return session;
			const { principal: _principal, ...overview } =
				await management.service.overview(session.account.principalId);
			context.header("cache-control", "no-store");
			return context.json({
				account: browserAccountProjection(session.account),
				isAdministrator: await management.service.isConnectionAdministrator(
					session.account.principalId,
				),
				overview,
			});
		});

		app.post("/api/v1/connection/oauth-transactions", async (context) => {
			requireSameOrigin(context.req.raw.headers, options.issuer);
			const body = parseJsonBody(
				oauthTransactionRequestSchema,
				await context.req.json().catch(() => ({})),
			);
			const sharedScopeId = body.sharedScopeId;
			const session = sharedScopeId
				? await currentBrowserApiAdministrator(context)
				: await currentBrowserApiAccount(context);
			if (session instanceof Response) return session;
			const authorization = await browserApiOperation(context, () =>
				browserCommand(
					options,
					context,
					{
						operation: "connection.github-oauth.start",
						replayable: false,
						request: body,
						subject: session.account.principalId,
					},
					() =>
						sharedScopeId
							? management.service.startSharedGithubOAuth(
									session.account.principalId,
									sharedScopeId,
									management.githubRedirectUri,
								)
							: management.service.startGithubOAuth(
									session.account.principalId,
									management.githubRedirectUri,
								),
				),
			);
			if (authorization instanceof Response) return authorization;
			context.header("cache-control", "no-store");
			return context.json({ authorizationUrl: authorization.authorizationUrl });
		});

		app.post("/api/v1/connection/authorization-previews", async (context) => {
			requireSameOrigin(context.req.raw.headers, options.issuer);
			const session = await currentBrowserApiAccount(context);
			if (session instanceof Response) return session;
			const body = parseJsonBody(
				authorizationPreviewRequestSchema,
				await context.req.json().catch(() => undefined),
			);
			const previewResponse = await browserApiOperation(context, () =>
				browserCommand(
					options,
					context,
					{
						operation: "connection.authorization-preview.create",
						replayable: false,
						request: body,
						subject: session.account.principalId,
					},
					async () => ({
						idempotencyKey: randomUUID(),
						preview:
							await management.service.createCurrentConsumerAuthorizationPreview(
								{
									connectionId: body.connectionId,
									consumerId: body.consumerId,
									principalId: session.account.principalId,
								},
							),
					}),
				),
			);
			if (previewResponse instanceof Response) return previewResponse;
			context.header("cache-control", "no-store");
			return context.json(previewResponse, 201);
		});

		app.post("/api/v1/connection/authorization-consents", async (context) => {
			requireSameOrigin(context.req.raw.headers, options.issuer);
			const session = await currentBrowserApiAccount(context);
			if (session instanceof Response) return session;
			const body = parseJsonBody(
				authorizationConsentRequestSchema,
				await context.req.json().catch(() => undefined),
			);
			const idempotencyKey = requireIdempotencyKey(context);
			const confirmed = await browserApiOperation(context, () =>
				browserCommand(
					options,
					context,
					{
						operation: "connection.authorization-consent.confirm",
						request: body,
						subject: session.account.principalId,
					},
					() =>
						management.service.confirmCurrentConsumerAuthorization({
							confirmationToken: body.confirmationToken,
							idempotencyKey,
							previewId: body.previewId,
							principalId: session.account.principalId,
						}),
				),
			);
			if (confirmed instanceof Response) return confirmed;
			context.header("cache-control", "no-store");
			return context.json(confirmed, 201);
		});

		app.delete("/api/v1/connection/grants/:grantId", async (context) => {
			requireSameOrigin(context.req.raw.headers, options.issuer);
			const session = await currentBrowserApiAccount(context);
			if (session instanceof Response) return session;
			const grantId = context.req.param("grantId");
			const revoked = await browserApiOperation(context, () =>
				browserCommand(
					options,
					context,
					{
						operation: "connection.grant.revoke",
						request: { grantId },
						subject: session.account.principalId,
					},
					() =>
						management.service.revokeGrant(
							session.account.principalId,
							grantId,
						),
				),
			);
			if (revoked instanceof Response) return revoked;
			context.header("cache-control", "no-store");
			return context.body(null, 204);
		});

		app.delete(
			"/api/v1/connection/connections/:connectionId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAccount(context);
				if (session instanceof Response) return session;
				const connectionId = context.req.param("connectionId");
				const disconnected = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.account.disconnect",
							request: { connectionId },
							subject: session.account.principalId,
						},
						() =>
							management.service.disconnectConnection(
								session.account.principalId,
								connectionId,
							),
					),
				);
				if (disconnected instanceof Response) return disconnected;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);

		app.get("/api/v1/connection/admin/administrators", async (context) => {
			const session = await currentBrowserApiAdministrator(context);
			if (session instanceof Response) return session;
			const administrators = await browserApiOperation(context, () =>
				management.service.listConnectionAdministratorCandidates(
					session.account.principalId,
				),
			);
			if (administrators instanceof Response) return administrators;
			context.header("cache-control", "no-store");
			return context.json({ administrators });
		});

		app.put(
			"/api/v1/connection/admin/administrators/:principalId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAdministrator(context);
				if (session instanceof Response) return session;
				const principalId = context.req.param("principalId");
				const granted = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.administrator.grant",
							request: { principalId },
							subject: session.account.principalId,
						},
						() =>
							management.service.grantConnectionAdministrator({
								actorPrincipalId: session.account.principalId,
								targetPrincipalId: principalId,
							}),
					),
				);
				if (granted instanceof Response) return granted;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);

		app.delete(
			"/api/v1/connection/admin/administrators/:principalId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAdministrator(context);
				if (session instanceof Response) return session;
				const principalId = context.req.param("principalId");
				const revoked = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.administrator.revoke",
							request: { principalId },
							subject: session.account.principalId,
						},
						() =>
							management.service.revokeConnectionAdministrator({
								actorPrincipalId: session.account.principalId,
								targetPrincipalId: principalId,
							}),
					),
				);
				if (revoked instanceof Response) return revoked;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);

		app.get("/api/v1/connection/admin/shared-connections", async (context) => {
			const session = await currentBrowserApiAdministrator(context);
			if (session instanceof Response) return session;
			const overview = await browserApiOperation(context, () =>
				management.service.sharedGithubAdministration(
					session.account.principalId,
				),
			);
			if (overview instanceof Response) return overview;
			context.header("cache-control", "no-store");
			return context.json({ overview });
		});

		app.post("/api/v1/connection/admin/shared-scopes", async (context) => {
			requireSameOrigin(context.req.raw.headers, options.issuer);
			const session = await currentBrowserApiAdministrator(context);
			if (session instanceof Response) return session;
			const body = parseJsonBody(
				sharedScopeNameSchema,
				await context.req.json().catch(() => undefined),
			);
			const scope = await browserApiOperation(context, () =>
				browserCommand(
					options,
					context,
					{
						operation: "connection.shared-scope.create",
						request: body,
						subject: session.account.principalId,
					},
					() =>
						management.service.createSharedScope({
							actorPrincipalId: session.account.principalId,
							displayName: body.displayName,
						}),
				),
			);
			if (scope instanceof Response) return scope;
			context.header("cache-control", "no-store");
			return context.json(scope, 201);
		});

		app.patch(
			"/api/v1/connection/admin/shared-scopes/:sharedScopeId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAdministrator(context);
				if (session instanceof Response) return session;
				const body = parseJsonBody(
					sharedScopeNameSchema,
					await context.req.json().catch(() => undefined),
				);
				const sharedScopeId = context.req.param("sharedScopeId");
				const renamed = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.shared-scope.rename",
							request: { ...body, sharedScopeId },
							subject: session.account.principalId,
						},
						() =>
							management.service.renameSharedScope({
								actorPrincipalId: session.account.principalId,
								displayName: body.displayName,
								sharedScopeId,
							}),
					),
				);
				if (renamed instanceof Response) return renamed;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);

		app.put(
			"/api/v1/connection/admin/shared-scopes/:sharedScopeId/principals/:principalId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAdministrator(context);
				if (session instanceof Response) return session;
				const sharedScopeId = context.req.param("sharedScopeId");
				const principalId = context.req.param("principalId");
				const granted = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.shared-scope-principal.grant",
							request: { principalId, sharedScopeId },
							subject: session.account.principalId,
						},
						() =>
							management.service.grantSharedScopePrincipal({
								actorPrincipalId: session.account.principalId,
								sharedScopeId,
								targetPrincipalId: principalId,
							}),
					),
				);
				if (granted instanceof Response) return granted;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);

		app.delete(
			"/api/v1/connection/admin/shared-scopes/:sharedScopeId/principals/:principalId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAdministrator(context);
				if (session instanceof Response) return session;
				const sharedScopeId = context.req.param("sharedScopeId");
				const principalId = context.req.param("principalId");
				const revoked = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.shared-scope-principal.revoke",
							request: { principalId, sharedScopeId },
							subject: session.account.principalId,
						},
						() =>
							management.service.revokeSharedScopePrincipal({
								actorPrincipalId: session.account.principalId,
								sharedScopeId,
								targetPrincipalId: principalId,
							}),
					),
				);
				if (revoked instanceof Response) return revoked;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);

		app.delete(
			"/api/v1/connection/admin/shared-connections/:connectionId",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserApiAdministrator(context);
				if (session instanceof Response) return session;
				const connectionId = context.req.param("connectionId");
				const disconnected = await browserApiOperation(context, () =>
					browserCommand(
						options,
						context,
						{
							operation: "connection.shared-account.disconnect",
							request: { connectionId },
							subject: session.account.principalId,
						},
						() =>
							management.service.disconnectSharedConnection({
								actorPrincipalId: session.account.principalId,
								connectionId,
							}),
					),
				);
				if (disconnected instanceof Response) return disconnected;
				context.header("cache-control", "no-store");
				return context.body(null, 204);
			},
		);
		app.get("/oauth/callback", async (context) => {
			await management.service.completeGithubOAuth(
				context.req.query("code") ?? "",
				context.req.query("state") ?? "",
			);
			return context.redirect("/connection/connections", 303);
		});
	}

	app.get("/oauth/authorize", async (context) => {
		const authorization = await options.service.beginAuthorization({
			clientId: context.req.query("client_id") ?? "",
			codeChallenge: context.req.query("code_challenge") ?? "",
			codeChallengeMethod: context.req.query("code_challenge_method") ?? "",
			redirectUri: context.req.query("redirect_uri") ?? "",
			resource: context.req.query("resource") ?? "",
			responseType: context.req.query("response_type") ?? "",
			scope: context.req.query("scope") ?? "",
			state: context.req.query("state") ?? "",
		});
		secureHtmlHeaders(context, { allowLoopbackFormRedirect: true });
		return context.html(loginPage(authorization));
	});

	app.post("/oauth/login", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const form = await context.req.raw.formData();
		const requestId = formValue(form, "request_id");
		try {
			const approved = await options.service.approveAuthorization({
				password: formValue(form, "password"),
				requestId,
				username: formValue(form, "username"),
			});
			const redirect = new URL(approved.redirectUri);
			redirect.searchParams.set("code", approved.code);
			redirect.searchParams.set("iss", options.issuer);
			redirect.searchParams.set("state", approved.state);
			return context.redirect(redirect.toString(), 302);
		} catch (error) {
			if (
				error instanceof OAuthProtocolError &&
				error.error === "invalid_request"
			) {
				secureHtmlHeaders(context);
				return context.html(
					loginPage({ clientName: "当前客户端", error: "授权请求已失效" }),
					400,
				);
			}
			if (
				!(error instanceof OAuthProtocolError) ||
				error.error !== "access_denied"
			) {
				throw error;
			}
			secureHtmlHeaders(context, { allowLoopbackFormRedirect: true });
			return context.html(
				loginPage({
					clientName: "当前客户端",
					error: "账号或密码错误",
					requestId,
				}),
				401,
			);
		}
	});

	app.post("/oauth/token", async (context) => {
		const form = await context.req.raw.formData();
		const grantType = formValue(form, "grant_type");
		context.header("cache-control", "no-store");
		if (grantType === "authorization_code") {
			return context.json(
				await options.service.exchangeAuthorizationCode({
					clientId: formValue(form, "client_id"),
					code: formValue(form, "code"),
					codeVerifier: formValue(form, "code_verifier"),
					redirectUri: formValue(form, "redirect_uri"),
					resource: formValue(form, "resource"),
				}),
			);
		}
		if (grantType === "refresh_token") {
			return context.json(
				await options.service.refresh({
					clientId: formValue(form, "client_id"),
					refreshToken: formValue(form, "refresh_token"),
					resource: formValue(form, "resource"),
				}),
			);
		}
		throw new OAuthProtocolError(
			"unsupported_grant_type",
			"Unsupported grant_type",
		);
	});

	app.post("/oauth/revoke", async (context) => {
		const form = await context.req.raw.formData();
		await options.service.revokeToken(formValue(form, "token"));
		context.header("cache-control", "no-store");
		return context.body(null, 200);
	});

	app.delete(
		"/connection/v1/consumer-instances/:instanceId/session",
		async (context) => {
			const authorization = context.req.header("authorization");
			const instanceId = context.req.param("instanceId");
			await browserCommand(
				options,
				context,
				{
					operation: "connection.consumer-instance.revoke",
					request: { instanceId },
					subject: `bearer:${authorization ?? "missing"}`,
				},
				() => options.service.revokeInstance(authorization, instanceId),
			);
			return context.body(null, 204);
		},
	);

	return app;
}
