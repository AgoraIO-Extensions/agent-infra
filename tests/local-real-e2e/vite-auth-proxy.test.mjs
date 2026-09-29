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

async function fakeApi() {
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
		if (path === "/auth/login" && request.method === "POST") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString());
			if (
				body.login !== "synthetic-user" ||
				body.password !== "synthetic-pass"
			) {
				response.statusCode = 401;
				response.end();
				return;
			}
			response.statusCode = 204;
			response.setHeader(
				"Set-Cookie",
				"proxy_session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax",
			);
			response.end();
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
		close: () => new Promise((resolve) => server.close(resolve)),
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
				VITE_PLATFORM_LOGIN_URL: "/auth/login",
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

function assertBoundary(events, path, origin, proto) {
	const event = events.find((value) => value.path === path);
	assert(event, `${path} must reach the fake API`);
	assert.equal(event.method, "POST");
	assert.equal(event.host, new URL(origin).host);
	assert.equal(event.origin, origin);
	assert.equal(event.proto, proto);
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
	const api = await fakeApi();
	const port = await freePort();
	let web;
	let browser;
	try {
		web = await startWeb(port, api.target, { cert, key });
		browser = await chromium.launch();
		const context = await browser.newContext({ ignoreHTTPSErrors: true });
		const page = await context.newPage();
		const origin = `https://127.0.0.1:${port}`;
		await page.goto(`${origin}/agents`);
		await page.getByRole("heading", { name: "登录工作空间" }).waitFor();
		const spoofed = await page.evaluate(
			async () =>
				(
					await fetch("/auth/login", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Forwarded-Proto": "http,https",
						},
						body: JSON.stringify({
							login: "synthetic-user",
							password: "wrong",
						}),
					})
				).status,
		);
		assert.equal(spoofed, 401);
		await page.getByLabel("账号").fill("synthetic-user");
		await page.getByLabel("密码").fill("synthetic-pass");
		await page.getByRole("button", { name: "登录" }).click();
		await page.getByRole("button", { name: "退出登录" }).waitFor();
		await page.getByRole("button", { name: "退出登录" }).click();
		await page.getByRole("heading", { name: "登录工作空间" }).waitFor();
		const login = assertBoundary(api.seen, "/auth/login", origin, "https");
		const logout = assertBoundary(api.seen, "/auth/logout", origin, "https");
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
	const api = await fakeApi();
	const port = await freePort();
	let web;
	try {
		web = await startWeb(port, api.target);
		const origin = `http://127.0.0.1:${port}`;
		const response = await fetch(`${origin}/auth/login`, {
			method: "POST",
			headers: {
				Origin: origin,
				"Content-Type": "application/json",
				"X-Forwarded-Proto": "https",
			},
			body: JSON.stringify({ login: "synthetic-user", password: "wrong" }),
		});
		assert.equal(response.status, 401);
		assertBoundary(api.seen, "/auth/login", origin, "http");
	} finally {
		web?.stop();
		await api.close();
	}
});
