import { randomUUID } from "node:crypto";
import {
	type ConnectionApplicationService,
	ConnectionError,
	type ConnectionOAuthService,
	type ConnectionOverview,
	type CurrentConsumerAuthorizationPreview,
	OAuthProtocolError,
	type PersonalAccessTokenRecord,
} from "@agent-infra/connection-core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export type ConnectionOAuthServerOptions = {
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
const browserSessionCookiePath = "/connection";

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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Connection</title>
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
<h1>Sign in to Connection</h1>
<p>Continue to ${html(input.clientName)}</p>
${input.error ? `<p class="error" role="alert">${html(input.error)}</p>` : ""}
${
	input.requestId
		? `
<form method="post" action="/oauth/login">
<input type="hidden" name="request_id" value="${html(input.requestId)}">
<label for="username">Company username</label>
<input id="username" name="username" type="text" autocomplete="username" required maxlength="256" autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<button type="submit">Continue</button>
</form>
		`
		: ""
}
</main>
</body>
</html>`;
}

const consoleStyles = `
:root { color-scheme: light; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202522; background: #f4f6f4; }
* { box-sizing: border-box; }
body { min-height: 100vh; min-height: 100dvh; margin: 0; background: #f4f6f4; }
button, input { font: inherit; }
button { cursor: pointer; }
a { color: inherit; }
:focus-visible { outline: 3px solid #a8c7b0; outline-offset: 2px; }
.brand { display: flex; align-items: center; gap: 10px; min-height: 40px; color: #f7faf7; font-size: 15px; font-weight: 700; }
.brand-mark { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 6px; background: #dce9df; color: #173e25; font-size: 14px; }
.login-shell { display: grid; min-height: 100vh; min-height: 100dvh; grid-template-columns: minmax(280px, 0.9fr) minmax(420px, 1.1fr); }
.login-brand { display: flex; flex-direction: column; justify-content: space-between; padding: 36px; background: #173e25; color: #dce9df; }
.login-brand p { max-width: 380px; margin: 0; color: #bad0c0; font-size: 14px; line-height: 1.6; }
.login-main { display: grid; place-items: center; padding: 32px; }
.login-panel { width: min(100%, 390px); }
h1 { margin: 0; color: #202522; font-size: 26px; line-height: 1.25; letter-spacing: 0; }
.lead { margin: 9px 0 26px; color: #5b655e; font-size: 14px; line-height: 1.55; }
label { display: block; margin: 0 0 7px; color: #323a35; font-size: 13px; font-weight: 650; }
input[type="text"], input[type="password"] { width: 100%; height: 44px; margin: 0 0 18px; padding: 0 12px; border: 1px solid #aab3ad; border-radius: 6px; background: #ffffff; color: #202522; }
input::placeholder { color: #68736c; }
.primary-button { display: inline-flex; min-width: 128px; height: 42px; align-items: center; justify-content: center; padding: 0 18px; border: 1px solid #173e25; border-radius: 6px; background: #173e25; color: #f7faf7; font-weight: 680; text-decoration: none; }
.primary-button:hover { background: #0f321c; }
.primary-button:active, .text-button:active, .danger-button:active { transform: translateY(1px); }
.error { margin: 0 0 18px; padding: 10px 12px; border-left: 3px solid #a63e3e; background: #fbecec; color: #7d2525; font-size: 13px; line-height: 1.45; }
.app-shell { display: grid; min-height: 100vh; min-height: 100dvh; grid-template-columns: 238px minmax(0, 1fr); }
.sidebar { display: flex; position: sticky; top: 0; height: 100vh; height: 100dvh; flex-direction: column; padding: 22px 16px 16px; background: #173e25; color: #dce9df; }
.sidebar nav { margin-top: 32px; }
.nav-link { display: flex; min-height: 40px; align-items: center; padding: 0 12px; border-radius: 6px; color: #c7d9cc; font-size: 14px; font-weight: 600; text-decoration: none; }
.nav-link[aria-current="page"] { background: #2a5437; color: #ffffff; }
.account { margin-top: auto; padding: 14px 10px 0; border-top: 1px solid #3a6345; }
.account-name { overflow: hidden; margin: 0; color: #ffffff; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.account-email { overflow: hidden; margin: 4px 0 10px; color: #a9c2b0; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.text-button { padding: 0; border: 0; background: transparent; color: #dce9df; font-size: 12px; font-weight: 650; }
.content { width: min(100%, 1120px); padding: 42px clamp(24px, 5vw, 64px) 64px; }
.page-header { margin-bottom: 30px; }
.page-header p { max-width: 620px; margin: 9px 0 0; color: #5b655e; font-size: 14px; line-height: 1.55; }
.panel { margin-bottom: 28px; border: 1px solid #d2d8d4; border-radius: 7px; background: #ffffff; }
.panel-header { padding: 20px 22px 0; }
.panel-header h2 { margin: 0; color: #252b27; font-size: 16px; letter-spacing: 0; }
.panel-header p { margin: 7px 0 0; color: #68716b; font-size: 13px; line-height: 1.5; }
.issue-form { display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 12px; align-items: end; padding: 18px 22px 22px; }
.issue-form input { margin: 0; }
.issued { margin: 0 22px 22px; padding: 16px; border: 1px solid #94b39c; border-radius: 6px; background: #edf6ef; }
.issued h3 { margin: 0 0 7px; color: #173e25; font-size: 14px; }
.issued p { margin: 0 0 12px; color: #425048; font-size: 13px; line-height: 1.5; }
.token-value { display: block; width: 100%; min-height: 46px; padding: 12px; border: 1px solid #9eaaa2; border-radius: 5px; background: #ffffff; color: #202522; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.45; overflow-wrap: anywhere; user-select: all; }
.table-wrap { overflow-x: auto; padding: 8px 22px 18px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { padding: 11px 10px; border-bottom: 1px solid #dfe4e0; color: #68716b; font-size: 11px; font-weight: 700; text-align: left; }
td { height: 62px; padding: 10px; border-bottom: 1px solid #edf0ee; color: #343b36; font-size: 12px; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
.token-name { overflow: hidden; color: #252b27; font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.status { display: inline-flex; min-height: 24px; align-items: center; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
.status-active { background: #e5f1e8; color: #215a31; }
.status-revoked, .status-expired { background: #ecefed; color: #5f6762; }
.danger-button { min-height: 32px; padding: 0 10px; border: 1px solid #c9a3a3; border-radius: 5px; background: #ffffff; color: #8b3030; font-size: 12px; font-weight: 650; }
.danger-button:hover { background: #fff3f3; }
.empty { padding: 34px 22px 38px; color: #68716b; font-size: 13px; text-align: center; }
.connection-list { display: grid; gap: 0; padding: 8px 22px 22px; }
.connection-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; padding: 18px 0; border-bottom: 1px solid #edf0ee; }
.connection-item:last-child { border-bottom: 0; }
.connection-title { margin: 0 0 5px; color: #252b27; font-size: 14px; }
.connection-meta { margin: 0; color: #68716b; font-size: 12px; }
.connection-actions { display: flex; gap: 8px; align-items: start; }
.consumer-list { grid-column: 1 / -1; display: grid; gap: 8px; }
.consumer-row { display: flex; min-height: 42px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 11px; border: 1px solid #e1e5e2; border-radius: 5px; background: #f8faf8; }
.consumer-name { margin: 0; color: #343b36; font-size: 13px; font-weight: 650; }
.secondary-button { min-height: 32px; padding: 0 11px; border: 1px solid #8ca394; border-radius: 5px; background: #ffffff; color: #245434; font-size: 12px; font-weight: 650; }
.secondary-button:hover { background: #f0f6f1; }
.action-list { max-height: 180px; margin: 12px 0 0; overflow-y: auto; padding-right: 8px; padding-left: 18px; color: #5b655e; font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) {
  .login-shell { grid-template-columns: 1fr; }
  .login-brand { min-height: 132px; padding: 22px; }
  .login-brand p { display: none; }
  .login-main { align-items: start; padding: 40px 22px; }
  .app-shell { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; padding: 14px 16px; }
  .sidebar nav { margin-top: 12px; }
  .account { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 16px; align-items: center; margin-top: 12px; padding: 12px 10px 0; }
  .account-email { margin-bottom: 0; }
  .account form { grid-column: 2; grid-row: 1 / span 2; }
  .content { padding: 28px 16px 48px; }
  .issue-form { grid-template-columns: 1fr; }
	.connection-item { grid-template-columns: 1fr; }
	.connection-actions { justify-content: start; }
	.consumer-list { grid-column: 1; }
	.consumer-row { align-items: start; flex-direction: column; }
  .primary-button { width: 100%; }
  .issued { margin-right: 14px; margin-left: 14px; }
  .panel-header, .issue-form { padding-right: 14px; padding-left: 14px; }
  .table-wrap { padding-right: 8px; padding-left: 8px; }
  th:nth-child(3), td:nth-child(3), th:nth-child(4), td:nth-child(4) { display: none; }
  th:nth-child(1) { width: 36%; }
  th:nth-child(2) { width: 24%; }
  th:nth-child(5) { width: 20%; }
  th:nth-child(6) { width: 20%; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; }
}`;

function consoleLoginPage(error?: string) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in | Connection</title>
<style>${consoleStyles}</style>
</head>
<body>
<div class="login-shell">
<aside class="login-brand">
<div class="brand"><span class="brand-mark" aria-hidden="true">C</span>Connection</div>
<p>Manage the credentials your approved clients use to access Connection.</p>
</aside>
<main class="login-main">
<section class="login-panel" aria-labelledby="login-title">
<h1 id="login-title">Sign in to Connection</h1>
<p class="lead">Use your company account to continue.</p>
${error ? `<p class="error" role="alert">${html(error)}</p>` : ""}
<form method="post" action="/connection/login">
<label for="username">Company username</label>
<input id="username" name="username" type="text" autocomplete="username" required maxlength="256" autofocus>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<button class="primary-button" type="submit">Sign in</button>
</form>
</section>
</main>
</div>
</body>
</html>`;
}

function timestamp(value: Date | null) {
	if (!value) return "Never";
	const iso = value.toISOString();
	return `<time datetime="${iso}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`;
}

function consoleNavigation(current: "connections" | "tokens") {
	return `<nav aria-label="Connection navigation">
<a class="nav-link" href="/connection/connections"${current === "connections" ? ' aria-current="page"' : ""}>Connections</a>
<a class="nav-link" href="/connection/tokens"${current === "tokens" ? ' aria-current="page"' : ""}>Access tokens</a>
</nav>`;
}

function tokenRows(tokens: PersonalAccessTokenRecord[]) {
	if (tokens.length === 0) {
		return '<p class="empty">No access tokens have been issued.</p>';
	}
	return `<div class="table-wrap"><table>
<thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Expires</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
<tbody>${tokens
		.map(
			(token) => `<tr>
<td><div class="token-name" title="${html(token.name)}">${html(token.name)}</div></td>
<td><span class="status status-${token.status.toLowerCase()}">${html(token.status[0] + token.status.slice(1).toLowerCase())}</span></td>
<td>${timestamp(token.createdAt)}</td>
<td>${timestamp(token.expiresAt)}</td>
<td>${timestamp(token.lastUsedAt)}</td>
<td>${
				token.status === "ACTIVE"
					? `<form method="post" action="/connection/tokens/${encodeURIComponent(token.tokenId)}/revoke"><button class="danger-button" type="submit">Revoke</button></form>`
					: ""
			}</td>
</tr>`,
		)
		.join("")}</tbody>
</table></div>`;
}

function tokenConsolePage(input: {
	account: { displayName: string; email: string | null };
	error?: string;
	issued?: { expiresAt: Date; name: string; token: string };
	tokens: PersonalAccessTokenRecord[];
}) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access tokens | Connection</title>
<style>${consoleStyles}.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }</style>
</head>
<body>
<div class="app-shell">
<aside class="sidebar">
<div class="brand"><span class="brand-mark" aria-hidden="true">C</span>Connection</div>
${consoleNavigation("tokens")}
<div class="account">
<p class="account-name" title="${html(input.account.displayName)}">${html(input.account.displayName)}</p>
<p class="account-email" title="${html(input.account.email ?? "Company account")}">${html(input.account.email ?? "Company account")}</p>
<form method="post" action="/connection/logout"><button class="text-button" type="submit">Sign out</button></form>
</div>
</aside>
<main class="content">
<header class="page-header">
<h1>Access tokens</h1>
<p>Issue a token for clients that cannot complete the Connection OAuth login.</p>
</header>
<section class="panel" aria-labelledby="issue-token-title">
<div class="panel-header">
<h2 id="issue-token-title">Issue a token</h2>
<p>Use a separate token when a client needs its own revocation and audit boundary.</p>
</div>
${input.error ? `<p class="error" role="alert">${html(input.error)}</p>` : ""}
<form class="issue-form" method="post" action="/connection/tokens">
<div><label for="name">Token name</label><input id="name" name="name" type="text" autocomplete="off" placeholder="For example, Codex on MacBook" required maxlength="100"></div>
<button class="primary-button" type="submit">Issue token</button>
</form>
${
	input.issued
		? `<div class="issued" role="status"><h3>Token issued</h3><p>${html(input.issued.name)} expires ${timestamp(input.issued.expiresAt)}. Copy it now. It will not be shown again.</p><code class="token-value">${html(input.issued.token)}</code></div>`
		: ""
}
</section>
<section class="panel" aria-labelledby="issued-tokens-title">
<div class="panel-header"><h2 id="issued-tokens-title">Issued tokens</h2><p>Revoking a token stops every client currently sharing it.</p></div>
${tokenRows(input.tokens)}
</section>
</main>
</div>
</body>
</html>`;
}

function connectionConsolePage(input: {
	account: { displayName: string; email: string | null };
	overview: ConnectionOverview;
}) {
	const actionList = input.overview.actions
		.map(
			(action) =>
				`<li>${html(action.description)} <span class="status status-${action.effect === "READ" ? "active" : "expired"}">${html(action.effect)}</span></li>`,
		)
		.join("");
	const connections = input.overview.connections.length
		? `<div class="connection-list">${input.overview.connections
				.map((connection) => {
					const canAuthorize =
						connection.status === "ACTIVE" && !connection.requiresReconnect;
					const activeGrants = input.overview.grants.filter(
						(grant) =>
							grant.connectionId === connection.id && grant.status === "ACTIVE",
					);
					const consumers = input.overview.consumers.length
						? input.overview.consumers
								.map((consumer) => {
									const grant = activeGrants.find(
										(entry) =>
											entry.consumerId === consumer.id &&
											entry.actionVersionIds.length ===
												connection.actionVersionIds.length &&
											entry.actionVersionIds.every((actionVersionId) =>
												connection.actionVersionIds.includes(actionVersionId),
											),
									);
									return `<div class="consumer-row"><p class="consumer-name">${html(consumer.name)}</p>${
										grant
											? `<form method="post" action="/connection/grants/${encodeURIComponent(grant.id)}/revoke"><button class="danger-button" type="submit">Revoke access</button></form>`
											: canAuthorize
												? `<form method="post" action="/connection/connections/${encodeURIComponent(connection.id)}/authorize"><input type="hidden" name="consumer_id" value="${html(consumer.id)}"><button class="secondary-button" type="submit">Use with ${html(consumer.name)}</button></form>`
												: `<span class="status status-revoked">${connection.requiresReconnect ? "Reconnect required" : "Unavailable"}</span>`
									}</div>`;
								})
								.join("")
						: '<p class="connection-meta">Issue an access token or sign in from a Direct MCP client before authorizing it.</p>';
					return `<article class="connection-item">
<div><h3 class="connection-title">${html(connection.displayName)}</h3><p class="connection-meta">GitHub account ${html(connection.externalAccount)}</p></div>
<div class="connection-actions"><span class="status status-${connection.requiresReconnect ? "expired" : connection.status.toLowerCase()}">${connection.requiresReconnect ? "RECONNECT REQUIRED" : html(connection.status)}</span>${
						connection.requiresReconnect
							? '<a class="secondary-button" href="/connection/connections/github">Reconnect GitHub</a>'
							: connection.status === "ACTIVE"
								? `<form method="post" action="/connection/connections/${encodeURIComponent(connection.id)}/disconnect"><button class="danger-button" type="submit">Disconnect</button></form>`
								: ""
					}</div>
<div class="consumer-list">${consumers}</div>
</article>`;
				})
				.join("")}</div>`
		: '<p class="empty">No GitHub account is connected.</p>';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connections | Connection</title>
<style>${consoleStyles}.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }</style>
</head>
<body>
<div class="app-shell">
<aside class="sidebar">
<div class="brand"><span class="brand-mark" aria-hidden="true">C</span>Connection</div>
${consoleNavigation("connections")}
<div class="account">
<p class="account-name" title="${html(input.account.displayName)}">${html(input.account.displayName)}</p>
<p class="account-email" title="${html(input.account.email ?? "Company account")}">${html(input.account.email ?? "Company account")}</p>
<form method="post" action="/connection/logout"><button class="text-button" type="submit">Sign out</button></form>
</div>
</aside>
<main class="content">
<header class="page-header"><h1>Connections</h1></header>
<section class="panel" aria-labelledby="github-title">
<div class="panel-header"><h2 id="github-title">GitHub</h2><ul class="action-list">${actionList}</ul></div>
<div class="issue-form"><div></div><a class="primary-button" href="/connection/connections/github" target="_blank" rel="noopener noreferrer">Add GitHub account</a></div>
${connections}
</section>
</main>
</div>
</body>
</html>`;
}

function authorizationPreviewPage(input: {
	account: { displayName: string; email: string | null };
	idempotencyKey: string;
	preview: CurrentConsumerAuthorizationPreview;
}) {
	const currentAccount = input.preview.currentConnection
		? `Current GitHub account ${html(input.preview.currentConnection.externalAccount)}`
		: "No GitHub account is currently authorized";
	const actionList = input.preview.actions
		.map((action) => {
			const scopes = action.requiredScopes.length
				? ` <span class="connection-meta">Scopes: ${html(action.requiredScopes.join(", "))}</span>`
				: ' <span class="connection-meta">Scopes: none</span>';
			return `<li>${html(action.description)} <span class="status status-${action.effect === "READ" ? "active" : "expired"}">${html(action.effect)}</span>${scopes}</li>`;
		})
		.join("");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review access | Connection</title>
<style>${consoleStyles}</style>
</head>
<body>
<div class="app-shell">
<aside class="sidebar">
<div class="brand"><span class="brand-mark" aria-hidden="true">C</span>Connection</div>
${consoleNavigation("connections")}
<div class="account">
<p class="account-name" title="${html(input.account.displayName)}">${html(input.account.displayName)}</p>
<p class="account-email" title="${html(input.account.email ?? "Company account")}">${html(input.account.email ?? "Company account")}</p>
<form method="post" action="/connection/logout"><button class="text-button" type="submit">Sign out</button></form>
</div>
</aside>
<main class="content">
<header class="page-header"><h1>Review access for ${html(input.preview.consumer.name)}</h1></header>
<section class="panel" aria-labelledby="authorization-change-title">
<div class="panel-header"><h2 id="authorization-change-title">Switch GitHub account</h2><p>${currentAccount}</p><p>New GitHub account ${html(input.preview.targetConnection.externalAccount)}</p></div>
<p class="connection-meta">Required scopes: ${html(input.preview.requiredScopes.join(", ") || "none")}</p>
<ul class="action-list">${actionList}</ul>
<form class="issue-form" method="post" action="/connection/authorization-previews/${encodeURIComponent(input.preview.previewId)}/confirm">
<input type="hidden" name="confirmation_token" value="${html(input.preview.confirmationToken)}">
<input type="hidden" name="idempotency_key" value="${html(input.idempotencyKey)}">
<a class="secondary-button" href="/connection/connections">Cancel</a>
<button class="primary-button" type="submit">Confirm switch</button>
</form>
</section>
</main>
</div>
</body>
</html>`;
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

function formValue(form: FormData, name: string) {
	const value = form.get(name);
	return typeof value === "string" ? value : "";
}

async function authorizationRequest<T>(operation: () => Promise<T>) {
	try {
		return await operation();
	} catch (error) {
		if (
			error instanceof ConnectionError &&
			(error.code === "INVALID_REQUEST" || error.code === "FORBIDDEN")
		) {
			throw new OAuthProtocolError("invalid_request", error.message);
		}
		throw error;
	}
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

	app.get("/connection", (context) =>
		context.redirect(
			options.management ? "/connection/connections" : "/connection/tokens",
		),
	);

	app.get("/connection/login", async (context) => {
		if (await currentBrowserAccount(context)) {
			return context.redirect(
				options.management ? "/connection/connections" : "/connection/tokens",
			);
		}
		secureHtmlHeaders(context);
		return context.html(consoleLoginPage());
	});

	app.post("/connection/login", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const form = await context.req.raw.formData();
		try {
			const login = await options.service.loginBrowserSession({
				password: formValue(form, "password"),
				username: formValue(form, "username"),
			});
			setCookie(context, browserSessionCookie, login.sessionToken, {
				...cookieOptions,
				expires: login.expiresAt,
				maxAge: Math.max(
					0,
					Math.floor((login.expiresAt.getTime() - Date.now()) / 1_000),
				),
			});
			return context.redirect(
				options.management ? "/connection/connections" : "/connection/tokens",
				303,
			);
		} catch (error) {
			if (
				!(error instanceof OAuthProtocolError) ||
				error.error !== "access_denied"
			) {
				throw error;
			}
			secureHtmlHeaders(context);
			return context.html(consoleLoginPage("Authentication failed"), 401);
		}
	});

	app.post("/connection/logout", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const sessionToken = getCookie(context, browserSessionCookie);
		await options.service.logoutBrowserSession(sessionToken);
		deleteCookie(context, browserSessionCookie, cookieOptions);
		return context.redirect("/connection/login", 303);
	});

	app.get("/connection/tokens", async (context) => {
		const session = await currentBrowserAccount(context);
		if (!session) return context.redirect("/connection/login");
		const tokens = await options.service.listPersonalAccessTokens(
			session.sessionToken,
		);
		secureHtmlHeaders(context);
		return context.html(tokenConsolePage({ account: session.account, tokens }));
	});

	app.post("/connection/tokens", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const session = await currentBrowserAccount(context);
		if (!session) return context.redirect("/connection/login", 303);
		const form = await context.req.raw.formData();
		try {
			const issued = await options.service.issuePersonalAccessToken({
				name: formValue(form, "name"),
				sessionToken: session.sessionToken,
			});
			const tokens = await options.service.listPersonalAccessTokens(
				session.sessionToken,
			);
			secureHtmlHeaders(context);
			return context.html(
				tokenConsolePage({ account: session.account, issued, tokens }),
				201,
			);
		} catch (error) {
			if (
				!(error instanceof OAuthProtocolError) ||
				error.error !== "invalid_request"
			) {
				throw error;
			}
			const tokens = await options.service.listPersonalAccessTokens(
				session.sessionToken,
			);
			secureHtmlHeaders(context);
			return context.html(
				tokenConsolePage({
					account: session.account,
					error: error.message,
					tokens,
				}),
				400,
			);
		}
	});

	app.post("/connection/tokens/:tokenId/revoke", async (context) => {
		requireSameOrigin(context.req.raw.headers, options.issuer);
		const session = await currentBrowserAccount(context);
		if (!session) return context.redirect("/connection/login", 303);
		await options.service.revokePersonalAccessToken({
			sessionToken: session.sessionToken,
			tokenId: context.req.param("tokenId"),
		});
		return context.redirect("/connection/tokens", 303);
	});

	if (options.management) {
		const management = options.management;
		app.get("/connection/connections", async (context) => {
			const session = await currentBrowserAccount(context);
			if (!session) return context.redirect("/connection/login");
			secureHtmlHeaders(context);
			return context.html(
				connectionConsolePage({
					account: session.account,
					overview: await management.service.overview(
						session.account.principalId,
					),
				}),
			);
		});

		app.get("/connection/connections/github", async (context) => {
			const session = await currentBrowserAccount(context);
			if (!session) return context.redirect("/connection/login");
			const authorization = await management.service.startGithubOAuth(
				session.account.principalId,
				management.githubRedirectUri,
			);
			return context.redirect(authorization.authorizationUrl, 303);
		});

		app.get("/oauth/callback", async (context) => {
			await management.service.completeGithubOAuth(
				context.req.query("code") ?? "",
				context.req.query("state") ?? "",
			);
			return context.redirect("/connection/connections", 303);
		});

		app.post(
			"/connection/connections/:connectionId/authorize",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserAccount(context);
				if (!session) return context.redirect("/connection/login", 303);
				const form = await context.req.raw.formData();
				const preview = await authorizationRequest(() =>
					management.service.createCurrentConsumerAuthorizationPreview({
						connectionId: context.req.param("connectionId"),
						consumerId: formValue(form, "consumer_id"),
						principalId: session.account.principalId,
					}),
				);
				secureHtmlHeaders(context);
				return context.html(
					authorizationPreviewPage({
						account: session.account,
						idempotencyKey: randomUUID(),
						preview,
					}),
				);
			},
		);

		app.post(
			"/connection/authorization-previews/:previewId/confirm",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserAccount(context);
				if (!session) return context.redirect("/connection/login", 303);
				const form = await context.req.raw.formData();
				await authorizationRequest(() =>
					management.service.confirmCurrentConsumerAuthorization({
						confirmationToken: formValue(form, "confirmation_token"),
						idempotencyKey: formValue(form, "idempotency_key"),
						previewId: context.req.param("previewId"),
						principalId: session.account.principalId,
					}),
				);
				return context.redirect("/connection/connections", 303);
			},
		);

		app.post("/connection/grants/:grantId/revoke", async (context) => {
			requireSameOrigin(context.req.raw.headers, options.issuer);
			const session = await currentBrowserAccount(context);
			if (!session) return context.redirect("/connection/login", 303);
			await management.service.revokeGrant(
				session.account.principalId,
				context.req.param("grantId"),
			);
			return context.redirect("/connection/connections", 303);
		});

		app.post(
			"/connection/connections/:connectionId/disconnect",
			async (context) => {
				requireSameOrigin(context.req.raw.headers, options.issuer);
				const session = await currentBrowserAccount(context);
				if (!session) return context.redirect("/connection/login", 303);
				await management.service.disconnectConnection(
					session.account.principalId,
					context.req.param("connectionId"),
				);
				return context.redirect("/connection/connections", 303);
			},
		);
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
					loginPage({ clientName: "your client", error: error.message }),
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
					clientName: "your client",
					error: "Authentication failed",
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
			await options.service.revokeInstance(
				context.req.header("authorization"),
				context.req.param("instanceId"),
			);
			return context.body(null, 204);
		},
	);

	return app;
}
