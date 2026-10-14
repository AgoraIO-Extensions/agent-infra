import {
	type CompanyIdentityProbe,
	companyIdentityCallbackPath,
	companyIdentityProbePath,
	companyIdentityProbeTtlSeconds,
	OAuthProtocolError,
} from "@agent-infra/connection-core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
	html,
	rejectForeignBrowserOrigin,
	secureHtmlHeaders,
} from "./oauth-routes";

const stateCookie = "connection_identity_probe_state";
const sessionCookie = "connection_session";

export function createIdentityProbeApp(
	probe: CompanyIdentityProbe | undefined,
	issuer: string,
) {
	const app = new Hono();
	if (!probe) {
		for (const path of [
			companyIdentityProbePath,
			companyIdentityCallbackPath,
		]) {
			app.all(path, (context) => {
				secureHtmlHeaders(context);
				return context.html(
					'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>身份探测未启用</title><p>公司 OAuth 身份探测尚未启用，请联系管理员确认客户端配置与入口日志门禁。</p></html>',
					503,
				);
			});
		}
		return app;
	}
	app.use("/api/v1/connection/identity/oauth/*", bodyLimit({ maxSize: 8192 }));
	const cookieOptions = {
		httpOnly: true,
		maxAge: companyIdentityProbeTtlSeconds,
		path: companyIdentityCallbackPath,
		sameSite: "Lax" as const,
		secure: new URL(issuer).protocol === "https:",
	};
	app.onError((error, context) => {
		console.warn(
			JSON.stringify({
				event: "connection_identity_probe_rejected",
				stage:
					context.req.path === companyIdentityProbePath ? "start" : "callback",
			}),
		);
		secureHtmlHeaders(context);
		return context.html(
			'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>身份探测未完成</title><p>身份探测未完成，请确认管理员登录后重新发起。不会更新账号或授权。</p></html>',
			error instanceof OAuthProtocolError && error.error === "invalid_token"
				? 401
				: 400,
		);
	});

	app.get(companyIdentityProbePath, async (context) => {
		await probe.requireAdministrator(getCookie(context, sessionCookie));
		const csrfToken = await probe.createStartConfirmation(
			getCookie(context, sessionCookie),
		);
		secureHtmlHeaders(context, {
			formActionOrigins: ["https://oauth.agoralab.co"],
		});
		return context.html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>公司 OAuth 身份探测</title>
<h1>公司 OAuth 身份探测</h1><p>仅比较当前管理员的身份字段。不会更新账号、授权或登录方式。公司登录后请点击“完成身份探测”。</p>
<form method="post" action="${companyIdentityProbePath}"><input type="hidden" name="csrfToken" value="${html(csrfToken)}"><button type="submit">开始公司 OAuth 身份探测</button></form></html>`);
	});
	app.post(companyIdentityProbePath, async (context) => {
		rejectForeignBrowserOrigin(context.req.raw.headers, issuer);
		const form = await context.req.formData();
		if (
			form.getAll("csrfToken").length !== 1 ||
			[...form.keys()].some((key) => key !== "csrfToken")
		)
			throw new OAuthProtocolError(
				"invalid_request",
				"Identity probe is unavailable",
			);
		probe.verifyStartConfirmation(
			getCookie(context, sessionCookie),
			String(form.get("csrfToken") ?? ""),
		);
		const started = await probe.start(getCookie(context, sessionCookie));
		setCookie(context, stateCookie, started.state, cookieOptions);
		secureHtmlHeaders(context, {
			formActionOrigins: ["https://oauth.agoralab.co"],
		});
		return context.redirect(started.authorizationUrl, 303);
	});

	app.get(companyIdentityCallbackPath, (context) => {
		const state = context.req.query("state") ?? "";
		const code = context.req.query("code") ?? "";
		if (
			context.req.query("error") ||
			context.req.queries("state")?.length !== 1 ||
			context.req.queries("code")?.length !== 1
		) {
			throw new OAuthProtocolError(
				"invalid_request",
				"Identity probe is unavailable",
			);
		}
		probe.validateCallback(state, getCookie(context, stateCookie), code);
		const csrfToken = probe.createCallbackConfirmation(
			state,
			getCookie(context, stateCookie),
			code,
		);
		secureHtmlHeaders(context);
		// A fresh same-origin form POST sends the existing Strict session cookie.
		return context.html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>完成身份探测</title>
<p>点击后将校验当前 Connection 管理员会话，并读取公司身份字段。不会更新账号或授权。</p>
<form method="post" action="${companyIdentityCallbackPath}">
<input type="hidden" name="csrfToken" value="${html(csrfToken)}"><input type="hidden" name="state" value="${html(state)}"><input type="hidden" name="code" value="${html(code)}">
<button type="submit">完成身份探测</button></form></html>`);
	});
	app.post(companyIdentityCallbackPath, async (context) => {
		rejectForeignBrowserOrigin(context.req.raw.headers, issuer);
		const body = await context.req.text();
		if (
			Buffer.byteLength(body) > 8192 ||
			!context.req
				.header("content-type")
				?.startsWith("application/x-www-form-urlencoded")
		) {
			throw new OAuthProtocolError(
				"invalid_request",
				"Identity probe is unavailable",
			);
		}
		const form = new URLSearchParams(body);
		if (
			form.getAll("state").length !== 1 ||
			form.getAll("code").length !== 1 ||
			form.getAll("csrfToken").length !== 1 ||
			[...form.keys()].some(
				(key) => key !== "state" && key !== "code" && key !== "csrfToken",
			)
		) {
			throw new OAuthProtocolError(
				"invalid_request",
				"Identity probe is unavailable",
			);
		}
		const cookie = getCookie(context, stateCookie);
		probe.verifyCallbackConfirmation({
			state: form.get("state") ?? "",
			code: form.get("code") ?? "",
			cookie,
			sessionToken: getCookie(context, sessionCookie),
			csrfToken: form.get("csrfToken") ?? "",
		});
		deleteCookie(context, stateCookie, cookieOptions);
		const result = await probe.complete({
			state: form.get("state") ?? "",
			code: form.get("code") ?? "",
			cookie,
			sessionToken: getCookie(context, sessionCookie),
		});
		secureHtmlHeaders(context);
		return context.html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>身份探测结果</title>
<h1>身份探测结果</h1><p>仅为当前两次认证的字段比较，不证明标识不复用或已批准身份迁移。</p>
<pre>${html(JSON.stringify(result, null, 2))}</pre><a href="${companyIdentityProbePath}">重新发起</a></html>`);
	});
	return app;
}
