import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 512;
const READ_PERMISSION = "web:read";

function invalidAuthConfiguration() {
	return new Error("AUTH_CONFIGURATION_INVALID");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

/**
 * Parse the owner-managed credential file without logging or returning tokens.
 * The file is deliberately tiny and is reloaded per request so revocation is
 * visible without restarting the sample service.
 */
export function parseAuthDocument(value) {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["users"]) ||
		!Array.isArray(value.users)
	)
		throw invalidAuthConfiguration();
	const subjects = new Set();
	const tokens = [];
	for (const user of value.users) {
		if (
			!isRecord(user) ||
			!exactKeys(user, ["subject", "token", "permissions"]) ||
			typeof user.subject !== "string" ||
			!/^[A-Za-z0-9._:-]{1,128}$/.test(user.subject) ||
			typeof user.token !== "string" ||
			user.token.length === 0 ||
			Buffer.byteLength(user.token, "utf8") > MAX_TOKEN_BYTES ||
			!Array.isArray(user.permissions) ||
			user.permissions.some((permission) => permission !== READ_PERMISSION)
		)
			throw invalidAuthConfiguration();
		if (subjects.has(user.subject)) throw invalidAuthConfiguration();
		subjects.add(user.subject);
		const token = Buffer.from(user.token, "utf8");
		if (tokens.some((existing) => existing.equals(token)))
			throw invalidAuthConfiguration();
		tokens.push(token);
	}
	return value.users.map((user) => ({
		subject: user.subject,
		token: Buffer.from(user.token, "utf8"),
		canRead: user.permissions.includes(READ_PERMISSION),
	}));
}

async function readAuthDocument(path) {
	if (
		typeof path !== "string" ||
		!path.startsWith("/") ||
		typeof constants.O_NOFOLLOW !== "number"
	)
		throw invalidAuthConfiguration();
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			(stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
			stat.size > MAX_AUTH_FILE_BYTES
		)
			throw invalidAuthConfiguration();
		const bytes = await handle.readFile();
		const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return parseAuthDocument(JSON.parse(source));
	} catch (error) {
		if (error?.message === "AUTH_CONFIGURATION_INVALID") throw error;
		throw invalidAuthConfiguration();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function sameToken(left, right) {
	return left.length === right.length && timingSafeEqual(left, right);
}

function authenticate(request, users) {
	const value = request.headers.authorization;
	if (typeof value !== "string") return { kind: "missing" };
	const match = /^Bearer ([^\s]+)$/.exec(value);
	if (!match) return { kind: "missing" };
	const supplied = Buffer.from(match[1], "utf8");
	for (const user of users) {
		if (sameToken(user.token, supplied))
			return user.canRead
				? { kind: "authorized", subject: user.subject }
				: { kind: "forbidden" };
	}
	return { kind: "missing" };
}

function escapeHtml(value) {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character],
	);
}

function empty(response, status, headers = {}) {
	response.writeHead(status, { "content-length": "0", ...headers });
	response.end();
}

function json(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	response.end(body);
}

function page(subject, version) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Custom Agent Web</title></head><body><main><h1>Custom Agent Web</h1><p>Authenticated self-managed Web for ${escapeHtml(subject)}</p><p>Identity responsibility: self-managed</p><p>Platform identity entry: unavailable</p><p>Service status: ready</p><p>Sample revision: ${escapeHtml(version)}</p></main></body></html>`;
}

async function handleRequest(request, response, authFile, version) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		empty(response, 405, { allow: "GET, HEAD" });
		return;
	}
	const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
	let users;
	try {
		users = await readAuthDocument(authFile);
	} catch {
		empty(response, 503);
		return;
	}
	if (pathname === "/healthz" || pathname === "/readyz") {
		if (request.method === "HEAD") {
			response.writeHead(200, { "content-length": "0" });
			response.end();
			return;
		}
		json(response, 200, {
			status: "ready",
			interactionMode: "self-managed",
			platformAuth: "unavailable",
			version,
		});
		return;
	}
	if (pathname !== "/" && pathname !== "/app") {
		empty(response, 404);
		return;
	}
	const authentication = authenticate(request, users);
	if (authentication.kind === "missing") {
		empty(response, 401, {
			"www-authenticate": 'Bearer realm="custom-agent-web"',
		});
		return;
	}
	if (authentication.kind === "forbidden") {
		empty(response, 403);
		return;
	}
	const body = page(authentication.subject, version);
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store",
	});
	if (request.method === "GET") response.write(body);
	response.end();
}

export function createCustomAgentWebServer({ authFile, version = "sample" }) {
	if (typeof authFile !== "string" || !authFile.startsWith("/"))
		throw invalidAuthConfiguration();
	if (typeof version !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(version))
		throw invalidAuthConfiguration();
	return createServer((request, response) => {
		void handleRequest(request, response, authFile, version).catch(() => {
			if (!response.headersSent) empty(response, 503);
			else response.destroy();
		});
	});
}

async function start() {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: This fixture-only variable is injected by the sample deployment.
	const authFile = process.env.CUSTOM_AGENT_AUTH_FILE;
	if (typeof authFile !== "string" || !authFile.startsWith("/")) {
		process.stderr.write("CUSTOM_AGENT_AUTH_FILE_REQUIRED\n");
		process.exitCode = 1;
		return;
	}
	try {
		await readAuthDocument(authFile);
	} catch {
		process.stderr.write("CUSTOM_AGENT_AUTH_CONFIGURATION_INVALID\n");
		process.exitCode = 1;
		return;
	}
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: This fixture-only value distinguishes A-to-B image revisions.
	const version = process.env.CUSTOM_AGENT_VERSION ?? "sample";
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: PORT is the container's standard fixture override.
	const port = Number.parseInt(process.env.PORT ?? "8080", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		process.stderr.write("CUSTOM_AGENT_PORT_INVALID\n");
		process.exitCode = 1;
		return;
	}
	let server;
	try {
		server = createCustomAgentWebServer({ authFile, version });
	} catch {
		process.stderr.write("CUSTOM_AGENT_VERSION_INVALID\n");
		process.exitCode = 1;
		return;
	}
	server.listen(port, "0.0.0.0", () => {
		process.stdout.write(
			`${JSON.stringify({ event: "listening", port, interactionMode: "self-managed" })}\n`,
		);
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await start();
