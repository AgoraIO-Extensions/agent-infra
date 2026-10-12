import { verify } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";

const MAX_LIFETIME_MS = 60_000;
const CONTEXT_HEADER = "x-agent-infra-platform-context";

function invalid() {
	return new Error("PLATFORM_ENTRY_CONTEXT_INVALID");
}

function decode(value) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
	const bytes = Buffer.from(value, "base64url");
	if (bytes.toString("base64url") !== value) throw invalid();
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function exactKeys(value, keys) {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function verifyContext(token, options) {
	if (typeof token !== "string") throw invalid();
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((part) => !part)) throw invalid();
	const [headerPart, payloadPart, signaturePart] = parts;
	const header = decode(headerPart);
	if (
		!header ||
		typeof header !== "object" ||
		!exactKeys(header, ["alg", "kid", "typ"]) ||
		header.alg !== "EdDSA" ||
		header.typ !== "platform-entry+jws" ||
		typeof header.kid !== "string"
	)
		throw invalid();
	const key = options.publicKeys.get(header.kid);
	if (
		key?.type !== "public" ||
		key.asymmetricKeyType !== "ed25519" ||
		!verify(
			null,
			Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
			key,
			Buffer.from(signaturePart, "base64url"),
		)
	)
		throw invalid();
	const claims = decode(payloadPart);
	const claimKeys = [
		"schemaVersion",
		"issuer",
		"audience",
		"issuedAt",
		"expiresAt",
		"contextId",
		"keyVersion",
		"userId",
		"organizationIds",
		"roles",
		"authorizationRevision",
		"agentId",
	];
	if (
		!claims ||
		typeof claims !== "object" ||
		!exactKeys(claims, claimKeys) ||
		claims.schemaVersion !== 1 ||
		claims.issuer !== options.issuer ||
		claims.audience !== "custom_agent" ||
		claims.keyVersion !== header.kid ||
		claims.agentId !== options.agentId ||
		typeof claims.userId !== "string" ||
		typeof claims.authorizationRevision !== "string" ||
		!Array.isArray(claims.organizationIds) ||
		!claims.organizationIds.every((value) => typeof value === "string") ||
		!Array.isArray(claims.roles) ||
		!claims.roles.every(
			(value) => value === "employee" || value === "system_admin",
		) ||
		!Number.isSafeInteger(claims.issuedAt) ||
		!Number.isSafeInteger(claims.expiresAt)
	)
		throw invalid();
	const now = (options.now ?? Date.now)();
	if (
		!Number.isSafeInteger(now) ||
		claims.issuedAt > now ||
		now >= claims.expiresAt ||
		claims.expiresAt <= claims.issuedAt ||
		claims.expiresAt - claims.issuedAt > MAX_LIFETIME_MS
	)
		throw invalid();
	return claims;
}

async function readAuthorization(path) {
	if (!path?.startsWith("/") || typeof constants.O_NOFOLLOW !== "number")
		throw invalid();
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			(stat.mode & 0o077) !== 0 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())
		)
			throw invalid();
		const value = JSON.parse(await handle.readFile("utf8"));
		if (!value || typeof value !== "object" || !Array.isArray(value.users))
			throw invalid();
		return value.users.map((user) => {
			if (
				!user ||
				typeof user !== "object" ||
				!exactKeys(user, ["userId", "authorizationRevision"]) ||
				typeof user.userId !== "string" ||
				typeof user.authorizationRevision !== "string"
			)
				throw invalid();
			return user;
		});
	} catch (error) {
		if (error?.message === "PLATFORM_ENTRY_CONTEXT_INVALID") throw error;
		throw invalid();
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function empty(response, status) {
	response.writeHead(status, { "content-length": "0" });
	response.end();
}

function page(claims, version) {
	const userId = claims.userId.replace(
		/[&<>"']/g,
		(value) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				value
			],
	);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Platform Auth Web</title></head><body><main><h1>Platform Auth Web</h1><p>Authenticated platform Web for ${userId}</p><p>Identity responsibility: platform-managed</p><p>Sample revision: ${version}</p></main></body></html>`;
}

export function createPlatformAuthWebServer(options) {
	if (
		!options?.publicKeys ||
		typeof options.publicKeys.get !== "function" ||
		typeof options.issuer !== "string" ||
		typeof options.agentId !== "string" ||
		typeof options.authFile !== "string"
	)
		throw invalid();
	let sideEffects = 0;
	const server = createServer((request, response) => {
		void (async () => {
			if (
				request.method !== "GET" ||
				new URL(request.url ?? "/", "http://fixture").pathname !== "/"
			) {
				empty(response, 404);
				return;
			}
			let claims;
			try {
				claims = verifyContext(request.headers[CONTEXT_HEADER], options);
			} catch {
				empty(response, 401);
				return;
			}
			const users = await readAuthorization(options.authFile).catch(() => null);
			const current = users?.find((user) => user.userId === claims.userId);
			if (
				!current ||
				current.authorizationRevision !== claims.authorizationRevision
			) {
				empty(response, 403);
				return;
			}
			sideEffects++;
			const body = page(claims, options.version ?? "sample");
			response.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"content-length": Buffer.byteLength(body),
				"cache-control": "no-store",
			});
			response.end(body);
		})().catch(() => {
			if (!response.headersSent) empty(response, 503);
			else response.destroy();
		});
	});
	return { server, sideEffects: () => sideEffects };
}
