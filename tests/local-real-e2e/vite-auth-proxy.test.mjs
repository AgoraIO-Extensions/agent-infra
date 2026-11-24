import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { get as httpsGet } from "node:https";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const requireFromWeb = createRequire(
	new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = requireFromWeb("@playwright/test");

async function freePort() {
	const server = createTcpServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

async function fakeApi(publicOrigin) {
	// Simulate the external authorization endpoint and the registered callback as
	// separate origins. This fixture exercises browser navigation and proxy headers.
	const callback = new URL("/auth/oidc/callback", publicOrigin);
	const issuer = createServer((request, response) => {
		if (request.url !== "/authorize?state=synthetic-state") {
			response.writeHead(400).end();
			return;
		}
		response
			.writeHead(302, {
				Location: `${callback.href}?code=synthetic-code&state=synthetic-state`,
			})
			.end();
	});
	issuer.listen(0, "127.0.0.1");
	await once(issuer, "listening");
	const issuerAddress = issuer.address();
	assert(issuerAddress && typeof issuerAddress !== "string");
	const seen = [];
	const server = createServer(async (request, response) => {
		const path = new URL(request.url ?? "/", "http://api.test").pathname;
		const headers = request.headers;
		seen.push({
			path,
			method: request.method,
			host: headers.host,
			origin: headers.origin,
			proto: headers["x-forwarded-proto"],
			protoCount: request.rawHeaders.filter(
				(value, index) =>
					index % 2 === 0 && value.toLowerCase() === "x-forwarded-proto",
			).length,
			csrf: headers["x-platform-csrf"],
			hasSession: (headers.cookie ?? "").includes("proxy_session=synthetic"),
		});
		if (path === "/api/v1/session") {
			response.setHeader("Content-Type", "application/json");
			if ((headers.cookie ?? "").includes("proxy_session=synthetic")) {
				response.end(
					JSON.stringify({
						schemaVersion: 1,
						user: {
							userId: "synthetic-user",
							displayName: "合成用户",
							roles: ["employee"],
						},
					}),
				);
			} else {
				response.statusCode = 401;
				response.end(
					JSON.stringify({
						schemaVersion: 1,
						code: "AUTHENTICATION_REQUIRED",
						message: "Authentication required",
						retryable: false,
						traceId: "synthetic-auth-proxy",
					}),
				);
			}
			return;
		}
		if (path === "/auth/oidc/login" && request.method === "GET") {
			response
				.writeHead(302, {
					Location: `http://127.0.0.1:${issuerAddress.port}/authorize?state=synthetic-state`,
					"Set-Cookie":
						"oidc_tx=synthetic-state; Path=/auth/oidc; Secure; HttpOnly; SameSite=Lax",
				})
				.end();
			return;
		}
		if (path === "/auth/oidc/callback" && request.method === "GET") {
			const params = new URL(request.url, publicOrigin).searchParams;
			if (
				params.get("code") !== "synthetic-code" ||
				params.get("state") !== "synthetic-state" ||
				!(headers.cookie ?? "").includes("oidc_tx=synthetic-state")
			) {
				response.writeHead(400).end();
				return;
			}
			response
				.writeHead(303, {
					Location: "/agents",
					"Set-Cookie": [
						"proxy_session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax",
						"oidc_tx=; Path=/auth/oidc; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
					],
				})
				.end();
			return;
		}
		if (path === "/auth/logout" && request.method === "POST") {
			response.statusCode = headers["x-platform-csrf"] === "1" ? 204 : 403;
			response.setHeader(
				"Set-Cookie",
				"proxy_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
			);
			response.end();
			return;
		}
		response.statusCode = 404;
		response.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		target: `http://127.0.0.1:${address.port}`,
		seen,
		close: () =>
			Promise.all(
				[issuer, server].map((s) => new Promise((resolve) => s.close(resolve))),
			),
	};
}

function probe(port, tls) {
	if (!tls) return fetch(`http://127.0.0.1:${port}/`);
	return new Promise((resolve, reject) => {
		httpsGet(
			{ hostname: "127.0.0.1", port, path: "/", rejectUnauthorized: false },
			(response) => {
				response.resume();
				response.once("end", resolve);
			},
		).once("error", reject);
	});
}

async function startWeb(port, target, tlsFiles) {
	const child = spawn(
		"pnpm",
		["dev:web", "--env-mode=loose", "--", "--port", String(port)],
		{
			cwd: root,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PLATFORM_API_PROXY_TARGET: target,
				PLATFORM_WEB_TLS_CERT_FILE: tlsFiles?.cert ?? "",
				PLATFORM_WEB_TLS_KEY_FILE: tlsFiles?.key ?? "",
				VITE_PLATFORM_LOGIN_URL: "/auth/oidc/login",
				VITE_PLATFORM_LOGOUT_URL: "/auth/logout",
				VITE_PLATFORM_DEVELOPMENT_MODE: "",
			},
		},
	);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (data) => {
			output = (output + data.toString()).slice(-4000);
		});
	}
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) break;
		try {
			await probe(port, Boolean(tlsFiles));
			return {
				stop: () => {
					process.kill(-child.pid, "SIGTERM");
				},
				output: () => output,
			};
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	if (child.exitCode === null) process.kill(-child.pid, "SIGTERM");
	throw new Error(`pnpm dev:web did not start: ${output}`);
}

function assertBoundary(events, path, origin, method) {
	const event = events.find((value) => value.path === path);
	assert(event, `${path} must reach the fake API`);
	assert.equal(event.method, method);
	assert.equal(event.host, new URL(origin).host);
	if (method === "POST") assert.equal(event.origin, origin);
	assert.equal(event.proto, new URL(origin).protocol.slice(0, -1));
	assert.equal(event.protoCount, 1);
	return event;
}

test("TLS pnpm dev:web proxies browser login and logout with trusted public headers", {
	timeout: 60_000,
}, async () => {
	const temp = mkdtempSync(join(tmpdir(), "vite-auth-proxy-"));
	const cert = join(temp, "cert.pem");
	const key = join(temp, "key.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			key,
			"-out",
			cert,
			"-days",
			"1",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		],
		{ stdio: "ignore" },
	);
	assert(readFileSync(cert).length > 0);
	const port = await freePort();
	const origin = `https://127.0.0.1:${port}`;
	const api = await fakeApi(origin);
	let web;
	let browser;
	try {
		web = await startWeb(port, api.target, { cert, key });
		browser = await chromium.launch();
		const context = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await context.newPage();
		await page.goto(`${origin}/agents`);
		await page.getByRole("heading", { name: "登录工作区" }).waitFor();
		// Forge the client header on real browser navigations. Vite must overwrite it.
		await page.route("**/auth/**", (route) =>
			route.continue({
				headers: {
					...route.request().headers(),
					"X-Forwarded-Proto": "http,https",
				},
			}),
		);
		await page.getByRole("link", { name: "使用公司账号登录" }).click();
		await page.getByRole("button", { name: "退出登录" }).waitFor();
		await page.getByRole("button", { name: "退出登录" }).click();
		await page.getByRole("heading", { name: "登录工作区" }).waitFor();
		const login = assertBoundary(api.seen, "/auth/oidc/login", origin, "GET");
		assertBoundary(api.seen, "/auth/oidc/callback", origin, "GET");
		const logout = assertBoundary(api.seen, "/auth/logout", origin, "POST");
		assert.equal(logout.csrf, "1");
		assert.equal(logout.hasSession, true);
		assert.equal(login.hasSession, false);
		assert(
			api.seen.some(
				(value) => value.path === "/api/v1/session" && value.hasSession,
			),
		);
		await context.close();
	} finally {
		await browser?.close();
		web?.stop();
		await api.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test("plain HTTP dev server overrides a forged HTTPS forwarding claim", {
	timeout: 30_000,
}, async () => {
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const api = await fakeApi(origin);
	let web;
	try {
		web = await startWeb(port, api.target);
		const response = await fetch(`${origin}/auth/oidc/login`, {
			redirect: "manual",
			headers: { "X-Forwarded-Proto": "https" },
		});
		assert.equal(response.status, 302);
		assertBoundary(api.seen, "/auth/oidc/login", origin, "GET");
	} finally {
		web?.stop();
		await api.close();
	}
});
