import { createHash } from "node:crypto";
import {
	browserAuthorizationRecoveryTarget,
	type CompanyOAuthEntry,
	companyEntryCheckPath,
	companyEntryPath,
	companyEntryStateTtl,
	companyEntryTtl,
	companyIdentityCallbackPath,
} from "@agent-infra/connection-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
	browserApiError,
	html,
	rejectForeignBrowserOrigin,
	secureHtmlHeaders,
} from "./oauth-routes";

const completeScript =
	'document.getElementById("company-oauth-complete").requestSubmit();';
const completeScriptHash = createHash("sha256")
	.update(completeScript)
	.digest("base64");

const stateCookie = "__Host-connection_company_oauth_state";
const ticketCookie = "__Host-connection_company_oauth_entry";

export function companyEntryRequired(path: string) {
	if (
		path === "/oauth/authorize" ||
		path === "/oauth/login" ||
		path.startsWith("/oauth/authorization-requests/") ||
		path.startsWith("/connection/pat-bindings/")
	)
		return true;
	if (!path.startsWith("/api/v1/connection/")) return false;
	if (
		path === companyIdentityCallbackPath ||
		path === companyEntryPath ||
		path === companyEntryCheckPath ||
		path === "/api/v1/connection/browser-confirmation"
	)
		return false;
	if (
		path === "/api/v1/connection/pat-bindings" ||
		/^\/api\/v1\/connection\/pat-bindings\/[^/]+\/claim$/.test(path)
	)
		return false;
	return true;
}

export function createCompanyOAuthEntryApp(
	entry: CompanyOAuthEntry | undefined,
	issuer: string,
) {
	const app = new Hono();
	const admitted = (cookie: string | undefined) =>
		!entry || entry.admitted(cookie);
	const stateOptions = {
		httpOnly: true,
		secure: true,
		sameSite: "Lax" as const,
		path: "/",
		maxAge: companyEntryStateTtl,
	};
	app.use("*", async (context, next) => {
		if (
			!companyEntryRequired(context.req.path) ||
			admitted(getCookie(context, ticketCookie))
		)
			return next();
		context.header("cache-control", "no-store");
		if (context.req.path.startsWith("/api/"))
			return browserApiError(context, {
				code: "AUTHENTICATION_REQUIRED",
				messageKey: "connection.error.company_oauth_required",
				status: 401,
			});
		secureHtmlHeaders(context);
		if (context.req.method === "GET") {
			const target = new URL(companyEntryPath, issuer);
			target.searchParams.set(
				"returnTo",
				`${context.req.path}${new URL(context.req.url).search}`,
			);
			return context.redirect(target.href, 303);
		}
		const recovery = browserAuthorizationRecoveryTarget(
			`${context.req.path}${new URL(context.req.url).search}`,
			issuer,
		);
		return context.html(
			`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>请重新登录</title><p>公司 OAuth 入口会话已过期。本次提交不会重放；重新登录后请核对账号并确认。若内置浏览器仍失败，请复制下方入口到系统浏览器。</p><a href="${html(recovery ? `${companyEntryPath}?returnTo=${encodeURIComponent(recovery)}` : "/connection/login")}">重新登录并打开授权页</a></html>`,
			401,
		);
	});
	app.get(companyEntryCheckPath, (context) => {
		context.header("cache-control", "no-store");
		return context.body(
			null,
			admitted(getCookie(context, ticketCookie)) ? 204 : 401,
		);
	});
	app.get(companyEntryPath, (context) => {
		secureHtmlHeaders(context, {
			formActionOrigins: ["https://oauth.agoralab.co"],
		});
		if (!entry)
			return context.html(
				'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><p>公司 OAuth 入口尚未启用。</p></html>',
				503,
			);
		const originalMethod = context.req.header("x-connection-original-method");
		if (originalMethod && !["GET", "HEAD"].includes(originalMethod)) {
			const recovery = browserAuthorizationRecoveryTarget(
				context.req.header("x-connection-return-to"),
				issuer,
			);
			return context.html(
				`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>请重新登录</title><p>公司入口会话已过期。本次提交不会自动重放；重新登录后仍需核对账号并确认。</p><a href="${html(recovery ? `${companyEntryPath}?returnTo=${encodeURIComponent(recovery)}` : "/connection/login")}">重新登录并打开授权页</a></html>`,
				401,
			);
		}
		const returnTo = entry.returnTo(
			context.req.query("returnTo") ??
				context.req.header("x-connection-return-to") ??
				undefined,
		);
		if (entry.admitted(getCookie(context, ticketCookie)))
			return context.redirect(returnTo, 303);
		const started = entry.start(returnTo);
		setCookie(context, stateCookie, started.state, stateOptions);
		return context.redirect(started.authorizationUrl, 303);
	});
	app.use(companyIdentityCallbackPath, bodyLimit({ maxSize: 8192 }));
	app.get(companyIdentityCallbackPath, (context, next) => {
		const state = context.req.query("state") ?? "";
		if (!entry || !state.startsWith("entry.")) return next();
		secureHtmlHeaders(context);
		try {
			if (
				context.req.query("error") ||
				context.req.queries("state")?.length !== 1 ||
				context.req.queries("code")?.length !== 1
			)
				throw new Error("Rejected");
			const code = context.req.query("code") ?? "";
			entry.validateCallback(state, getCookie(context, stateCookie), code);
			const csrfToken = entry.createCallbackConfirmation(
				state,
				getCookie(context, stateCookie),
				code,
			);
			secureHtmlHeaders(context, { inlineScriptHash: completeScriptHash });
			return context.html(
				`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>正在跳转</title><style>#company-oauth-recovery{visibility:hidden;animation:show-recovery 0s 2s forwards}@keyframes show-recovery{to{visibility:visible}}</style><p role="status">正在跳转…</p><form id="company-oauth-complete" method="post" action="${companyIdentityCallbackPath}"><input type="hidden" name="csrfToken" value="${html(csrfToken)}"><input type="hidden" name="flow" value="entry"><input type="hidden" name="state" value="${html(state)}"><input type="hidden" name="code" value="${html(code)}"><div id="company-oauth-recovery"><p>若未自动跳转，请点击下方按钮。</p><button type="submit">完成公司登录</button></div></form><script>${completeScript}</script></html>`,
			);
		} catch {
			console.warn(
				JSON.stringify({
					event: "connection_company_entry_rejected",
					stage: "callback_get",
				}),
			);
			const recovery = entry.recoveryTarget(state);
			return context.html(
				`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><p>公司登录未完成。请重新登录，或将下方入口链接复制到系统浏览器继续。</p><a href="${html(`${companyEntryPath}?returnTo=${encodeURIComponent(recovery)}`)}">重新打开公司登录</a></html>`,
				400,
			);
		}
	});
	app.post(companyIdentityCallbackPath, async (context, next) => {
		if (!entry) return next();
		const body = await context.req.text();
		const form = new URLSearchParams(body);
		if (form.get("flow") !== "entry") return next();
		secureHtmlHeaders(context);
		try {
			rejectForeignBrowserOrigin(context.req.raw.headers, issuer);
			if (
				!context.req
					.header("content-type")
					?.startsWith("application/x-www-form-urlencoded") ||
				Buffer.byteLength(body) > 8192 ||
				form.getAll("state").length !== 1 ||
				form.getAll("code").length !== 1 ||
				form.getAll("flow").length !== 1 ||
				form.getAll("csrfToken").length !== 1 ||
				[...form.keys()].some(
					(k) => !["flow", "state", "code", "csrfToken"].includes(k),
				)
			)
				throw new Error("Rejected");
			const cookie = getCookie(context, stateCookie);
			entry.verifyCallbackConfirmation({
				state: form.get("state") ?? "",
				code: form.get("code") ?? "",
				cookie,
				csrfToken: form.get("csrfToken") ?? "",
			});
			deleteCookie(context, stateCookie, stateOptions);
			const completed = await entry.complete({
				state: form.get("state") ?? "",
				code: form.get("code") ?? "",
				cookie,
			});
			setCookie(context, ticketCookie, completed.ticket, {
				httpOnly: true,
				secure: stateOptions.secure,
				sameSite: "Strict",
				path: "/",
				maxAge: companyEntryTtl,
			});
			return context.redirect(completed.returnTo, 303);
		} catch {
			console.warn(
				JSON.stringify({
					event: "connection_company_entry_rejected",
					stage: "callback_post",
				}),
			);
			const recovery = entry.recoveryTarget(form.get("state") ?? "");
			return context.html(
				`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><p>公司登录未完成，本次授权不会自动重试。请重新登录；若内置浏览器仍失败，请复制下方入口到系统浏览器。</p><a href="${html(`${companyEntryPath}?returnTo=${encodeURIComponent(recovery)}`)}">重新打开公司登录</a></html>`,
				400,
			);
		}
	});
	return app;
}
