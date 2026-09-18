import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	type LocalBrowserConfiguration,
	loadLocalBrowserConfiguration,
	parseLocalBrowserConfiguration,
	startLocalBrowserGateway,
} from "./local-browser.ts";

let directory: string;
let ca: Buffer;
const tokens = {
	owner: "o".repeat(48),
	admin: "a".repeat(48),
	expired: "e".repeat(48),
};

before(async () => {
	directory = await mkdtemp(join(tmpdir(), "agent-infra-local-browser-"));
	await chmod(directory, 0o700);
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=IP:127.0.0.1,DNS:localhost",
			"-keyout",
			join(directory, "key.pem"),
			"-out",
			join(directory, "cert.pem"),
		],
		{ stdio: "ignore" },
	);
	await chmod(join(directory, "key.pem"), 0o600);
	ca = await readFile(join(directory, "cert.pem"));
	for (const [name, token] of Object.entries(tokens)) {
		await writeFile(join(directory, `${name}-token`), token, { mode: 0o600 });
	}
});

after(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function listen(server: Server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

type Recorded = {
	path: string;
	method: string;
	headers: IncomingHttpHeaders;
	body: string;
};

async function fixture() {
	const received: Recorded[] = [];
	const webReceived: IncomingHttpHeaders[] = [];
	let streamClosed: (() => void) | undefined;
	const closedStream = new Promise<void>((resolve) => {
		streamClosed = resolve;
	});
	const api = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		received.push({
			path: incoming.url ?? "",
			method: incoming.method ?? "",
			headers: incoming.headers,
			body: Buffer.concat(chunks).toString("utf8"),
		});
		const account =
			incoming.headers.authorization === `Bearer ${tokens.owner}`
				? "owner"
				: incoming.headers.authorization === `Bearer ${tokens.admin}`
					? "admin"
					: undefined;
		if (!account) {
			outgoing.writeHead(401, { "Content-Type": "application/json" });
			outgoing.end(JSON.stringify({ error: "expired or revoked" }));
			return;
		}
		if (incoming.url === "/api/v1/session") {
			outgoing.writeHead(200, { "Content-Type": "application/json" });
			outgoing.end(
				JSON.stringify({
					schemaVersion: 1,
					user: {
						userId: `fixture-${account}`,
						displayName: account,
						roles: account === "admin" ? ["system_admin"] : ["employee"],
					},
				}),
			);
			return;
		}
		if (incoming.url === "/api/events") {
			outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
			outgoing.flushHeaders();
			outgoing.write("id: fixture-1\ndata: streaming\n\n");
			outgoing.on("close", () => streamClosed?.());
			return;
		}
		if (incoming.url === "/api/redirect") {
			outgoing.writeHead(302, {
				Location: "https://example.invalid/steal",
				"Set-Cookie": "untrusted=yes",
			});
			outgoing.end();
			return;
		}
		outgoing.writeHead(200, {
			"Content-Type": "application/json",
			"Set-Cookie": "upstream=secret",
			"Access-Control-Allow-Origin": "*",
		});
		outgoing.end(JSON.stringify({ account }));
	});
	const web = createServer((incoming, outgoing) => {
		webReceived.push(incoming.headers);
		outgoing.writeHead(200, { "Content-Type": "text/html" });
		outgoing.end("<!doctype html><title>Existing Platform Web</title>");
	});
	const apiOrigin = await listen(api);
	const webOrigin = await listen(web);
	const config: LocalBrowserConfiguration = {
		schemaVersion: 1,
		mode: "controlled-development",
		port: 0,
		apiOrigin,
		webOrigin,
		tls: {
			certFile: join(directory, "cert.pem"),
			keyFile: join(directory, "key.pem"),
		},
		accounts: [
			{
				name: "owner",
				label: "开发 Owner",
				tokenFile: join(directory, "owner-token"),
			},
			{
				name: "admin",
				label: "开发审批管理员",
				tokenFile: join(directory, "admin-token"),
			},
			{
				name: "expired",
				label: "已失效的开发身份",
				tokenFile: join(directory, "expired-token"),
			},
		],
	};
	const gateway = await startLocalBrowserGateway(config);
	return {
		...gateway,
		config,
		received,
		webReceived,
		closedStream,
		async close() {
			await gateway.close();
			await close(api);
			await close(web);
		},
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };
type RequestOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
};

async function send(
	origin: string,
	path: string,
	options: RequestOptions = {},
): Promise<Reply> {
	return await new Promise((resolve, reject) => {
		const outgoing = request(
			new URL(origin),
			{
				path,
				ca,
				servername: "localhost",
				agent: false,
				method: options.method ?? "GET",
				headers: options.headers,
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("error", reject);
				incoming.on("end", () =>
					resolve({
						status: incoming.statusCode ?? 0,
						headers: incoming.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		outgoing.on("error", reject);
		outgoing.end(options.body);
	});
}

function cookies(reply: Reply) {
	return (reply.headers["set-cookie"] ?? [])
		.filter((value) => !value.includes("Max-Age=0"))
		.map((value) => value.split(";")[0])
		.join("; ");
}

async function form(input: Fixture, route = "login", session?: string) {
	const response = await send(input.origin, `/__local/${route}`, {
		headers: session ? { Cookie: session } : {},
	});
	assert.equal(response.status, 200);
	const csrf = response.body.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
	assert(csrf);
	return {
		response,
		csrf,
		cookie: [session, cookies(response)].filter(Boolean).join("; "),
	};
}

async function login(input: Fixture, account = "owner", session?: string) {
	const challenge = await form(input, "login", session);
	return await send(input.origin, "/__local/login", {
		method: "POST",
		headers: {
			Origin: input.origin,
			Cookie: challenge.cookie,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ csrf: challenge.csrf, account }).toString(),
	});
}

test("only explicit controlled configuration and literal loopback upstreams are accepted", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	assert.deepEqual(parseLocalBrowserConfiguration(input.config), input.config);
	for (const origin of [
		"https://example.com",
		"http://localhost:3508",
		"http://127.0.0.1:3508/path",
		"http://user:password@127.0.0.1:3508",
		"http://127.0.0.1:3508?target=https://example.com",
	]) {
		assert.throws(() =>
			parseLocalBrowserConfiguration({ ...input.config, apiOrigin: origin }),
		);
	}
	assert.throws(() =>
		parseLocalBrowserConfiguration({ ...input.config, mode: "production" }),
	);
	assert.throws(() =>
		parseLocalBrowserConfiguration({
			...input.config,
			accounts: [{ name: "owner", label: "owner", token: tokens.owner }],
		}),
	);
	const path = join(directory, "config.json");
	await writeFile(path, JSON.stringify(input.config), { mode: 0o600 });
	assert.deepEqual(await loadLocalBrowserConfiguration(path), input.config);
	await chmod(path, 0o644);
	await assert.rejects(loadLocalBrowserConfiguration(path));
});

test("the development page labels fixtures and login verifies identity before issuing a protected opaque cookie", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	const page = await form(input);
	// Native form submissions must retain their same-origin Origin header.
	assert.equal(page.response.headers["referrer-policy"], "same-origin");
	assert.match(page.response.body, /受控开发环境/);
	assert.match(page.response.body, /不代表真实账号登录/);
	assert.doesNotMatch(page.response.body, new RegExp(tokens.owner));
	const response = await login(input);
	assert.equal(response.status, 303);
	assert.equal(response.headers.location, "/agents");
	assert.equal(response.headers["cache-control"], "no-store");
	const session = response.headers["set-cookie"]?.find((value) =>
		value.startsWith("__Host-agent-infra-local-session="),
	);
	assert(session);
	assert.match(
		session,
		/^__Host-agent-infra-local-session=[a-f0-9]{64}; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$/,
	);
	assert.doesNotMatch(session, new RegExp(tokens.owner));
	assert.equal(input.received.length, 1);
	assert.equal(input.received[0]?.path, "/api/v1/session");
	assert.equal(
		(
			await send(input.origin, "/api/v1/session", {
				headers: { Cookie: cookies(response) },
			})
		).status,
		200,
	);
});

test("anonymous and forged sessions cannot proxy the API, including supplied upstream authorization", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	const cases: Record<string, string>[] = [
		{},
		{ Authorization: `Bearer ${tokens.admin}` },
		{ Cookie: `__Host-agent-infra-local-session=${"0".repeat(64)}` },
	];
	for (const headers of cases) {
		const response = await send(input.origin, "/api/v1/session", { headers });
		assert.equal(response.status, 401);
		assert.equal(JSON.parse(response.body).code, "AUTHENTICATION_REQUIRED");
	}
	assert.equal(input.received.length, 0);
	assert.equal((await send(input.origin, "/agents")).status, 200);
	assert.equal(input.webReceived.length, 1);
});

test("unknown accounts and extra caller identity fields fail closed, and rejected upstream identity issues no session", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	assert.equal((await login(input, "nonexistent")).status, 400);
	assert.equal(input.received.length, 0);
	const challenge = await form(input);
	const extra = await send(input.origin, "/__local/login", {
		method: "POST",
		headers: {
			Origin: input.origin,
			Cookie: challenge.cookie,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			csrf: challenge.csrf,
			account: "owner",
			userId: "administrator",
		}).toString(),
	});
	assert.equal(extra.status, 403);
	assert.equal(input.received.length, 0);
	const invalid = await login(input, "expired");
	assert.equal(invalid.status, 503);
	assert.equal(invalid.headers["set-cookie"], undefined);
	assert.doesNotMatch(invalid.body, /expired or revoked/);
});

test("Host, absolute target, missing or foreign Origin and CSRF checks reject requests before proxying", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	for (const [path, headers] of [
		["/agents", { Host: "attacker.example" }],
		["https://example.invalid/", {}],
		["//example.invalid/", {}],
		["/\\example.invalid/", {}],
		["/agents", { "Sec-Fetch-Site": "cross-site" }],
	] as [string, Record<string, string>][]) {
		assert.equal((await send(input.origin, path, { headers })).status, 403);
	}
	const challenge = await form(input);
	const body = new URLSearchParams({
		account: "owner",
		csrf: challenge.csrf,
	}).toString();
	for (const origin of [undefined, "https://example.invalid"]) {
		assert.equal(
			(
				await send(input.origin, "/__local/login", {
					method: "POST",
					headers: {
						Cookie: challenge.cookie,
						"Content-Type": "application/x-www-form-urlencoded",
						...(origin ? { Origin: origin } : {}),
					},
					body,
				})
			).status,
			403,
		);
	}
	assert.equal(
		(
			await send(input.origin, "/__local/login", {
				method: "POST",
				headers: {
					Origin: input.origin,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body,
			})
		).status,
		403,
	);
	assert.equal(input.received.length, 0);
	const accepted = await send(input.origin, "/__local/login", {
		method: "POST",
		headers: {
			Origin: input.origin,
			Cookie: challenge.cookie,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});
	assert.equal(accepted.status, 303);
	assert.equal(
		(
			await send(input.origin, "/__local/login", {
				method: "POST",
				headers: {
					Origin: input.origin,
					Cookie: challenge.cookie,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body,
			})
		).status,
		403,
	);
	assert.equal(
		(
			await send(input.origin, "/api/write", {
				method: "POST",
				headers: { Cookie: cookies(accepted) },
			})
		).status,
		403,
	);
	assert.equal(input.received.length, 1);
});

test("proxy sends only server-selected authorization and allowed headers, never browser authority or upstream cookies", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	const authenticated = await login(input);
	const headers = {
		Cookie: `${cookies(authenticated)}; upstream=attacker`,
		Authorization: `Bearer ${tokens.admin}`,
		"X-User-Id": "administrator",
		"X-Organization-Ids": "other",
		"X-Platform-Roles": "system_admin",
		"X-Forwarded-Host": "attacker.example",
		"Idempotency-Key": "fixture-write-1",
		"Content-Type": "application/json",
		Origin: input.origin,
	};
	const response = await send(
		input.origin,
		"/api/write?target=https://example.invalid",
		{ method: "POST", headers, body: '{"message":"fixture"}' },
	);
	assert.equal(response.status, 200);
	assert.equal(JSON.parse(response.body).account, "owner");
	assert.equal(
		response.headers["set-cookie"]?.some((value) =>
			value.includes("upstream=secret"),
		),
		false,
	);
	assert.equal(response.headers["access-control-allow-origin"], undefined);
	const upstream = input.received.at(-1);
	assert(upstream);
	assert.equal(upstream.headers.authorization, `Bearer ${tokens.owner}`);
	assert.equal(upstream.headers["idempotency-key"], "fixture-write-1");
	for (const name of [
		"cookie",
		"x-user-id",
		"x-organization-ids",
		"x-platform-roles",
		"x-forwarded-host",
		"origin",
	])
		assert.equal(upstream.headers[name], undefined);
	assert.equal(upstream.body, '{"message":"fixture"}');
	const rotatedApiCsrf = response.headers["set-cookie"]?.find((value) =>
		value.startsWith("__Host-agent-infra-local-api-csrf="),
	);
	assert(rotatedApiCsrf);
	assert.equal(
		(
			await send(input.origin, "/api/write", {
				method: "POST",
				headers: {
					Cookie: cookies(authenticated),
					Origin: input.origin,
					"Content-Type": "application/json",
				},
				body: '{"message":"replay"}',
			})
		).status,
		403,
	);
	const session = cookies(authenticated)
		.split("; ")
		.find((value) => value.startsWith("__Host-agent-infra-local-session="));
	assert(session);
	assert.equal(
		(
			await send(input.origin, "/api/write", {
				method: "POST",
				headers: {
					Cookie: `${session}; ${rotatedApiCsrf.split(";")[0]}`,
					Origin: input.origin,
					"Content-Type": "application/json",
				},
				body: '{"message":"rotated"}',
			})
		).status,
		200,
	);
	await send(input.origin, "/assets/app.js", { headers });
	assert.equal(input.webReceived.at(-1)?.authorization, undefined);
	assert.equal(input.webReceived.at(-1)?.cookie, undefined);
	const redirect = await send(input.origin, "/api/redirect", {
		headers: { Cookie: cookies(authenticated) },
	});
	assert.equal(redirect.status, 502);
	assert.equal(redirect.headers.location, undefined);
});

test("switch and logout revoke the previous session and reload the document", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	const owner = await login(input);
	const admin = await login(input, "admin", cookies(owner));
	assert.equal(admin.status, 303);
	assert.equal(
		(
			await send(input.origin, "/api/v1/session", {
				headers: { Cookie: cookies(owner) },
			})
		).status,
		401,
	);
	const current = await send(input.origin, "/api/v1/session", {
		headers: { Cookie: cookies(admin) },
	});
	assert.equal(JSON.parse(current.body).user.userId, "fixture-admin");
	const challenge = await form(input, "logout", cookies(admin));
	const logout = await send(input.origin, "/__local/logout", {
		method: "POST",
		headers: {
			Origin: input.origin,
			Cookie: challenge.cookie,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ csrf: challenge.csrf }).toString(),
	});
	assert.equal(logout.status, 303);
	assert.equal(logout.headers.location, "/agents");
	assert(
		logout.headers["set-cookie"]?.every((value) => value.includes("Max-Age=0")),
	);
	assert.equal(
		(
			await send(input.origin, "/api/v1/session", {
				headers: { Cookie: cookies(admin) },
			})
		).status,
		401,
	);
});

test("SSE arrives before completion and browser disconnect cancels the upstream stream", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	const authenticated = await login(input);
	const outgoing = request(new URL("/api/events", input.origin), {
		ca,
		agent: false,
		headers: { Cookie: cookies(authenticated), "Last-Event-ID": "fixture-0" },
	});
	const reply = once(outgoing, "response", {
		signal: AbortSignal.timeout(3_000),
	});
	outgoing.end();
	const [incoming] = (await reply) as [IncomingMessage];
	assert.equal(incoming.statusCode, 200);
	assert.equal(incoming.headers["content-type"], "text/event-stream");
	const [chunk] = await once(incoming, "data", {
		signal: AbortSignal.timeout(3_000),
	});
	assert.match(chunk.toString(), /data: streaming/);
	assert.equal(input.received.at(-1)?.headers["last-event-id"], "fixture-0");
	incoming.destroy();
	outgoing.destroy();
	await Promise.race([
		input.closedStream,
		new Promise<never>((_, reject) => {
			const signal = AbortSignal.timeout(3_000);
			signal.addEventListener(
				"abort",
				() => reject(new Error("upstream stream was not cancelled")),
				{ once: true },
			);
		}),
	]);
});

test("switching identities also cancels the previous identity's open SSE stream", async (t) => {
	const input = await fixture();
	t.after(() => input.close());
	const authenticated = await login(input);
	const outgoing = request(new URL("/api/events", input.origin), {
		ca,
		agent: false,
		headers: { Cookie: cookies(authenticated) },
	});
	const reply = once(outgoing, "response", {
		signal: AbortSignal.timeout(3_000),
	});
	outgoing.end();
	const [incoming] = (await reply) as [IncomingMessage];
	incoming.on("error", () => undefined);
	await once(incoming, "data", { signal: AbortSignal.timeout(3_000) });
	const switched = await login(input, "admin", cookies(authenticated));
	assert.equal(switched.status, 303);
	await Promise.race([
		input.closedStream,
		new Promise<never>((_, reject) => {
			AbortSignal.timeout(3_000).addEventListener(
				"abort",
				() => reject(new Error("old identity stream remained open")),
				{ once: true },
			);
		}),
	]);
	incoming.destroy();
	outgoing.destroy();
});
