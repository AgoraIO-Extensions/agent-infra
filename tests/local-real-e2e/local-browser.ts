import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as requestHttp } from "node:http";
import { createServer, request as requestHttps } from "node:https";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** Test harness only. The Platform API still resolves every operation's identity. */
export interface LocalBrowserConfiguration {
	schemaVersion: 1;
	mode: "controlled-development";
	port?: number;
	browserHostname?: "127.0.0.1" | "localhost";
	apiOrigin: string;
	webOrigin: string;
	tls: { certFile: string; keyFile: string };
	accounts: readonly { name: string; label: string; tokenFile: string }[];
}

const sessionCookie = "__Host-agent-infra-local-session";
const csrfCookie = "__Host-agent-infra-local-csrf";
const sessionLifetimeMs = 60 * 60 * 1_000;
const challengeLifetimeMs = 10 * 60 * 1_000;
const requestHeaders = [
	"accept",
	"accept-language",
	"content-type",
	"content-length",
	"idempotency-key",
	"last-event-id",
	"range",
	"if-none-match",
	"if-modified-since",
] as const;
const responseHeaders = [
	"content-type",
	"content-length",
	"content-encoding",
	"etag",
	"last-modified",
	"accept-ranges",
	"content-range",
	"retry-after",
] as const;

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("LOCAL_BROWSER_CONFIGURATION_INVALID");
	}
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new Error("LOCAL_BROWSER_CONFIGURATION_INVALID");
	}
}

function filePath(value: unknown): value is string {
	return (
		typeof value === "string" && isAbsolute(value) && !value.includes("\0")
	);
}

function loopbackOrigin(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			["127.0.0.1", "[::1]"].includes(url.hostname) &&
			url.origin === value &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

export function parseLocalBrowserConfiguration(
	value: unknown,
): LocalBrowserConfiguration {
	const config = record(value);
	keys(config, [
		"schemaVersion",
		"mode",
		"port",
		"browserHostname",
		"apiOrigin",
		"webOrigin",
		"tls",
		"accounts",
	]);
	const tls = record(config.tls);
	keys(tls, ["certFile", "keyFile"]);
	if (
		config.schemaVersion !== 1 ||
		config.mode !== "controlled-development" ||
		(config.port !== undefined &&
			(!Number.isInteger(config.port) ||
				(config.port as number) < 0 ||
				(config.port as number) > 65_535)) ||
		(config.browserHostname !== undefined &&
			config.browserHostname !== "127.0.0.1" &&
			config.browserHostname !== "localhost") ||
		!loopbackOrigin(config.apiOrigin) ||
		!loopbackOrigin(config.webOrigin) ||
		config.apiOrigin === config.webOrigin ||
		!filePath(tls.certFile) ||
		!filePath(tls.keyFile) ||
		!Array.isArray(config.accounts) ||
		config.accounts.length < 1 ||
		config.accounts.length > 8
	) {
		throw new Error("LOCAL_BROWSER_CONFIGURATION_INVALID");
	}
	const names = new Set<string>();
	for (const candidate of config.accounts) {
		const account = record(candidate);
		keys(account, ["name", "label", "tokenFile"]);
		if (
			typeof account.name !== "string" ||
			!/^[a-z][a-z0-9-]{0,31}$/.test(account.name) ||
			names.has(account.name) ||
			typeof account.label !== "string" ||
			account.label.length < 1 ||
			account.label.length > 100 ||
			!filePath(account.tokenFile)
		) {
			throw new Error("LOCAL_BROWSER_CONFIGURATION_INVALID");
		}
		names.add(account.name);
	}
	return structuredClone(config) as unknown as LocalBrowserConfiguration;
}

async function readLocalFile(
	path: string,
	maximum: number,
	privateFile = true,
) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (
			!stat.isFile() ||
			stat.size > maximum ||
			(privateFile &&
				((stat.mode & 0o077) !== 0 ||
					(process.getuid !== undefined && stat.uid !== process.getuid())))
		) {
			throw new Error("LOCAL_BROWSER_PROTECTED_FILE_INVALID");
		}
		const bytes = await file.readFile();
		if (bytes.byteLength > maximum) {
			throw new Error("LOCAL_BROWSER_PROTECTED_FILE_INVALID");
		}
		return bytes;
	} finally {
		await file.close();
	}
}

export async function loadLocalBrowserConfiguration(path: string) {
	if (!filePath(path)) throw new Error("LOCAL_BROWSER_CONFIGURATION_INVALID");
	return parseLocalBrowserConfiguration(
		JSON.parse((await readLocalFile(path, 64 * 1_024)).toString("utf8")),
	);
}

function cookie(name: string, value: string, maximumAge: number) {
	return `${name}=${value}; Path=/; Max-Age=${maximumAge}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(
	request: IncomingMessage,
	name: string,
): string | undefined {
	const values = (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`));
	if (values.length !== 1) return undefined;
	const value = values[0]?.slice(name.length + 1);
	return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function html(value: string) {
	return value.replace(/[&<>"']/g, (character) => {
		return (
			(
				{
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				} as Record<string, string>
			)[character] ?? ""
		);
	});
}

function failure(response: ServerResponse, status: number) {
	if (response.headersSent) {
		response.destroy();
		return;
	}
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	response.end(
		JSON.stringify({
			schemaVersion: 1,
			code:
				status === 401
					? "AUTHENTICATION_REQUIRED"
					: "LOCAL_DEVELOPMENT_REQUEST_REJECTED",
			message:
				status === 401 ? "请先选择本地开发身份。" : "本地开发请求未能完成。",
			retryable: status >= 500,
			traceId: randomUUID(),
		}),
	);
}

async function readForm(request: IncomingMessage) {
	if (
		!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(
			request.headers["content-type"] ?? "",
		) ||
		Number(request.headers["content-length"] ?? 0) > 4_096
	) {
		throw new Error("LOCAL_FORM_INVALID");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const value of request) {
		const chunk = Buffer.from(value);
		size += chunk.length;
		if (size > 4_096) throw new Error("LOCAL_FORM_INVALID");
		chunks.push(chunk);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function verifyUpstreamSession(origin: string, token: string) {
	const target = new URL("/api/v1/session", origin);
	const send = target.protocol === "https:" ? requestHttps : requestHttp;
	await new Promise<void>((resolve, reject) => {
		const request = send(
			target,
			{
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
				},
			},
			(response) => {
				if (
					response.statusCode !== 200 ||
					!/^application\/json(?:;|$)/i.test(
						response.headers["content-type"] ?? "",
					)
				) {
					response.resume();
					reject(new Error("LOCAL_IDENTITY_UNAVAILABLE"));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 16 * 1_024)
						request.destroy(new Error("LOCAL_IDENTITY_UNAVAILABLE"));
					else chunks.push(chunk);
				});
				response.on("error", reject);
				response.on("end", () => {
					try {
						const value = record(
							JSON.parse(Buffer.concat(chunks).toString("utf8")),
						);
						const user = record(value.user);
						if (
							value.schemaVersion !== 1 ||
							typeof user.userId !== "string" ||
							!user.userId ||
							typeof user.displayName !== "string" ||
							!Array.isArray(user.roles) ||
							user.roles.length === 0 ||
							user.roles.some(
								(role) => role !== "employee" && role !== "system_admin",
							)
						)
							throw new Error("LOCAL_IDENTITY_UNAVAILABLE");
						resolve();
					} catch {
						reject(new Error("LOCAL_IDENTITY_UNAVAILABLE"));
					}
				});
			},
		);
		const timer = setTimeout(
			() => request.destroy(new Error("LOCAL_IDENTITY_UNAVAILABLE")),
			5_000,
		);
		request.on("close", () => clearTimeout(timer));
		request.on("error", reject);
		request.end();
	});
}

function proxy(
	request: IncomingMessage,
	response: ServerResponse,
	origin: string,
	token?: string,
	activeRequests?: Set<() => void>,
) {
	const target = new URL(request.url ?? "/", origin);
	const headers: Record<string, string> = {};
	for (const name of requestHeaders) {
		const value = request.headers[name];
		if (typeof value === "string") headers[name] = value;
	}
	if (token) headers.authorization = `Bearer ${token}`;
	const send = target.protocol === "https:" ? requestHttps : requestHttp;
	const upstream = send(
		target,
		{ method: request.method, headers },
		(received) => {
			clearTimeout(timer);
			const status = received.statusCode ?? 502;
			if (status >= 300 && status < 400 && status !== 304) {
				received.resume();
				failure(response, 502);
				return;
			}
			const forwarded: Record<string, string | string[]> = {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			};
			for (const name of responseHeaders) {
				const value = received.headers[name];
				if (value !== undefined) forwarded[name] = value;
			}
			response.writeHead(status, forwarded);
			response.flushHeaders();
			received.on("error", () => response.destroy());
			received.pipe(response);
		},
	);
	const timer = setTimeout(
		() => upstream.destroy(new Error("LOCAL_UPSTREAM_UNAVAILABLE")),
		15_000,
	);
	upstream.on("error", () => failure(response, 502));
	upstream.on("close", () => clearTimeout(timer));
	const cancel = () => {
		upstream.destroy();
		response.destroy();
	};
	activeRequests?.add(cancel);
	request.on("aborted", () => upstream.destroy());
	response.on("close", () => {
		activeRequests?.delete(cancel);
		if (!response.writableFinished) upstream.destroy();
	});
	request.pipe(upstream);
}

export async function startLocalBrowserGateway(
	input: LocalBrowserConfiguration,
) {
	const config = parseLocalBrowserConfiguration(input);
	const [cert, key] = await Promise.all([
		readLocalFile(config.tls.certFile, 128 * 1_024, false),
		readLocalFile(config.tls.keyFile, 64 * 1_024),
	]);
	const sessions = new Map<
		string,
		{
			token: string;
			expiresAt: number;
			expiry: ReturnType<typeof setTimeout>;
			activeRequests: Set<() => void>;
		}
	>();
	const challenges = new Map<string, number>();
	let origin = "";
	let authority = "";
	const removeSession = (id: string) => {
		const session = sessions.get(id);
		if (!session) return;
		sessions.delete(id);
		clearTimeout(session.expiry);
		for (const cancel of session.activeRequests) cancel();
	};
	const prune = () => {
		const now = Date.now();
		for (const [id, session] of sessions) {
			if (session.expiresAt <= now) removeSession(id);
		}
		for (const [id, expiresAt] of challenges) {
			if (expiresAt <= now) challenges.delete(id);
		}
	};
	const server = createServer({ cert, key }, (request, response) => {
		void handle(request, response).catch(() => failure(response, 503));
	});
	server.on("upgrade", (_request, socket) => socket.destroy());

	async function handle(request: IncomingMessage, response: ServerResponse) {
		prune();
		const raw = request.url ?? "";
		const hostCount = request.rawHeaders.filter(
			(value, index) => index % 2 === 0 && value.toLowerCase() === "host",
		).length;
		if (
			hostCount !== 1 ||
			request.headers.host !== authority ||
			!raw.startsWith("/") ||
			raw.startsWith("//") ||
			raw.includes("\\") ||
			raw.includes("#") ||
			[...raw].some((character) => character.charCodeAt(0) <= 32) ||
			request.headers["sec-fetch-site"] === "cross-site"
		) {
			failure(response, 403);
			return;
		}
		const method = request.method ?? "";
		if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
			failure(response, 405);
			return;
		}
		if (
			!["GET", "HEAD"].includes(method) &&
			request.headers.origin !== origin
		) {
			failure(response, 403);
			return;
		}
		const url = new URL(raw, origin);
		const sessionId = readCookie(request, sessionCookie);
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (url.pathname.startsWith("/__local/")) {
			const login = url.pathname === "/__local/login";
			if ((!login && url.pathname !== "/__local/logout") || url.search) {
				failure(response, 404);
				return;
			}
			if (method === "GET") {
				if (challenges.size >= 1_024) {
					failure(response, 503);
					return;
				}
				const previous = readCookie(request, csrfCookie);
				if (previous) challenges.delete(previous);
				const challenge = randomBytes(32).toString("hex");
				challenges.set(challenge, Date.now() + challengeLifetimeMs);
				response.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store",
					"Set-Cookie": cookie(
						csrfCookie,
						challenge,
						challengeLifetimeMs / 1_000,
					),
					"Content-Security-Policy":
						"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
					"Referrer-Policy": "same-origin",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(
					`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>本地开发身份</title><style>body{font:16px system-ui;max-width:40rem;margin:10vh auto;padding:1.5rem;line-height:1.6}button,a{display:block;margin:1rem 0;padding:.7rem}button{cursor:pointer}</style><main><h1>${login ? "选择本地开发身份" : "退出本地开发身份"}</h1><p>这是受控开发环境，使用测试身份和测试模型，不代表真实账号登录或真实首通验收。</p><form method="post" action="${url.pathname}"><input type="hidden" name="csrf" value="${challenge}">${login ? config.accounts.map((account) => `<button type="submit" name="account" value="${html(account.name)}">${html(account.label)}</button>`).join("") : '<button type="submit">退出开发身份</button>'}</form><a href="/agents">返回 Agent 页面</a></main></html>`,
				);
				return;
			}
			if (method !== "POST") {
				failure(response, 405);
				return;
			}
			let form: URLSearchParams;
			try {
				form = await readForm(request);
			} catch {
				failure(response, 400);
				return;
			}
			const challenge = readCookie(request, csrfCookie);
			const submitted = form.get("csrf") ?? "";
			if (
				!challenge ||
				!challenges.has(challenge) ||
				!/^[a-f0-9]{64}$/.test(submitted) ||
				!timingSafeEqual(Buffer.from(challenge), Buffer.from(submitted)) ||
				form.getAll("csrf").length !== 1 ||
				[...form.keys()].some(
					(name) => name !== "csrf" && (!login || name !== "account"),
				)
			) {
				failure(response, 403);
				return;
			}
			challenges.delete(challenge);
			let newSession: string | undefined;
			if (login) {
				const account = config.accounts.find(
					(value) => value.name === form.get("account"),
				);
				if (!account || form.getAll("account").length !== 1) {
					failure(response, 400);
					return;
				}
				if (sessions.size >= 256 && !session) {
					failure(response, 503);
					return;
				}
				try {
					const token = (await readLocalFile(account.tokenFile, 1_024))
						.toString("utf8")
						.trim();
					if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error();
					await verifyUpstreamSession(config.apiOrigin, token);
					const issued = randomBytes(32).toString("hex");
					newSession = issued;
					const expiry = setTimeout(
						() => removeSession(issued),
						sessionLifetimeMs,
					);
					expiry.unref();
					sessions.set(issued, {
						token,
						expiresAt: Date.now() + sessionLifetimeMs,
						expiry,
						activeRequests: new Set(),
					});
				} catch {
					failure(response, 503);
					return;
				}
			}
			if (sessionId) removeSession(sessionId);
			response.writeHead(303, {
				Location: "/agents",
				"Cache-Control": "no-store",
				"Set-Cookie": [
					cookie(
						sessionCookie,
						newSession ?? "",
						newSession ? sessionLifetimeMs / 1_000 : 0,
					),
					cookie(csrfCookie, "", 0),
				],
			});
			response.end();
			return;
		}
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			if (!session) {
				failure(response, 401);
				return;
			}
			proxy(
				request,
				response,
				config.apiOrigin,
				session.token,
				session.activeRequests,
			);
			return;
		}
		if (!["GET", "HEAD"].includes(method)) {
			failure(response, 405);
			return;
		}
		proxy(request, response, config.webOrigin);
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port ?? 3511, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("LOCAL_BROWSER_START_FAILED");
	authority = `${config.browserHostname ?? "127.0.0.1"}:${address.port}`;
	origin = `https://${authority}`;
	if ([config.apiOrigin, config.webOrigin].includes(origin)) {
		server.close();
		throw new Error("LOCAL_BROWSER_CONFIGURATION_INVALID");
	}
	return {
		server,
		origin,
		async close() {
			for (const id of sessions.keys()) removeSession(id);
			challenges.clear();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		},
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		if (process.argv.length !== 3 || !process.argv[2]) throw new Error();
		const running = await startLocalBrowserGateway(
			await loadLocalBrowserConfiguration(process.argv[2]),
		);
		console.info(
			JSON.stringify({
				service: "local-browser-development",
				origin: running.origin,
				mode: "controlled-development",
			}),
		);
		let closing = false;
		const stop = () => {
			if (closing) return;
			closing = true;
			void running.close().catch(() => {
				console.error("Local browser development gateway failed to stop");
				process.exitCode = 1;
			});
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	} catch {
		console.error(
			"Local browser development gateway could not start; check the protected configuration and local TLS files",
		);
		process.exitCode = 1;
	}
}
