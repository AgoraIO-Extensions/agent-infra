#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { request } = requireWeb("@playwright/test");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

async function privateJson(file, maximum = 1024 * 1024) {
	if (!isAbsolute(file)) fail("PRIVATE_FILE_INVALID");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maximum)
			fail("PRIVATE_FILE_INVALID");
		const bytes = Buffer.alloc(maximum + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== stat.size || bytesRead > maximum) fail("PRIVATE_FILE_INVALID");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)));
	} finally { await handle.close(); }
}

async function privateText(file, maximum = 8192, pattern = /^papi_[A-Za-z0-9_-]{43}$/u) {
	if (!isAbsolute(file)) fail("PRIVATE_FILE_INVALID");
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maximum)
			fail("PRIVATE_FILE_INVALID");
		const bytes = Buffer.alloc(maximum + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		if (bytesRead !== stat.size || bytesRead > maximum) fail("PRIVATE_FILE_INVALID");
		const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim();
		if (!pattern.test(value)) fail("PRIVATE_CREDENTIAL_INVALID");
		return value;
	} finally { await handle.close(); }
}

async function privatePath(file) {
	if (!isAbsolute(file)) fail("OUTPUT_FILE_INVALID");
	const stat = await lstat(file).catch(() => undefined);
	if (stat && (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
		fail("OUTPUT_FILE_INVALID");
}

function parse(input) {
	assert(input && input.schemaVersion === 1 && typeof input.origin === "string");
	const url = new URL(input.origin);
	assert(
		(url.protocol === "https:" ||
			(url.protocol === "http:" && url.hostname === "127.0.0.1")) &&
			url.origin === input.origin &&
			url.pathname === "/",
	);
	assert(typeof input.storageStateFile === "string" && isAbsolute(input.storageStateFile));
	assert(typeof input.outputFile === "string" && isAbsolute(input.outputFile));
	assert(input.personalRelayKeyFile === undefined || (typeof input.personalRelayKeyFile === "string" && isAbsolute(input.personalRelayKeyFile)));
	assert(Array.isArray(input.scopes) && input.scopes.length > 0 && input.scopes.length <= 4);
	assert(input.scopes.every((scope) => ["agent:read", "agent:use", "agent:manage", "agent:create"].includes(scope)));
	assert(new Set(input.scopes).size === input.scopes.length);
	assert(input.expiresAt === null || (typeof input.expiresAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(input.expiresAt)));
	assert(typeof input.idempotencyKey === "string" && /^[\x21-\x7e]{8,256}$/u.test(input.idempotencyKey));
	return input;
}

export async function bootstrapCredential(input) {
	const parsed = parse(input);
	await privatePath(parsed.storageStateFile);
	await privatePath(parsed.outputFile);
	const state = await privateJson(parsed.storageStateFile);
	assert(Array.isArray(state.cookies) && Array.isArray(state.origins));
	assert(state.origins.every((entry) => entry && entry.origin === parsed.origin));
	const existing = await lstat(parsed.outputFile).catch(() => undefined);
	const personalKey = parsed.personalRelayKeyFile === undefined ? undefined
		: await privateText(parsed.personalRelayKeyFile, 8192, /^[\x21-\x7e]{16,8192}$/u);
	const context = await request.newContext({
		baseURL: parsed.origin,
		storageState: state,
		ignoreHTTPSErrors: false,
	});
	try {
		let personalRelayKey;
		if (personalKey !== undefined) {
			const read = async () => {
				const response = await context.get("/api/v2/me/relay-key", { timeout: 30_000, maxRedirects: 0 });
				assert.equal(response.status(), 200, "PERSONAL_RELAY_KEY_READ_FAILED");
				const value = await response.json();
				assert(value.schemaVersion === 1 && Object.keys(value).sort().join(",") === "isSet,keyVersion,schemaVersion" &&
					(value.isSet === false ? value.keyVersion === null : value.isSet === true && Number.isSafeInteger(value.keyVersion) && value.keyVersion > 0), "PERSONAL_RELAY_KEY_STATE_INVALID");
				return value;
			};
			const before = await read();
			let expectedVersion = before.keyVersion;
			if (!before.isSet) {
				const response = await context.put("/api/v2/me/relay-key", { headers: { Origin: parsed.origin },
					data: { expectedVersion: null, keyValue: personalKey }, timeout: 30_000, maxRedirects: 0 });
				assert.equal(response.status(), 200, "PERSONAL_RELAY_KEY_REPLACE_FAILED");
				const value = await response.json();
				assert(value.schemaVersion === 1 && value.isSet === true && Number.isSafeInteger(value.keyVersion) && value.keyVersion > 0, "PERSONAL_RELAY_KEY_REPLACE_INVALID");
				expectedVersion = value.keyVersion;
			}
			const after = await read();
			assert(after.isSet === true && after.keyVersion === expectedVersion, "PERSONAL_RELAY_KEY_CHANGED");
			personalRelayKey = { mode: before.isSet ? "existing-retained" : "installed-and-read-back", keyVersion: after.keyVersion };
		}
		const response = await context.post("/api/v2/me/api-credentials", {
			headers: { "Idempotency-Key": parsed.idempotencyKey, Origin: parsed.origin },
			data: { scopes: parsed.scopes, expiresAt: parsed.expiresAt },
			timeout: 30_000,
		});
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		assert(response.status() === 201 || response.status() === 200);
		assert(body?.replayed === false || body?.replayed === true);
		let credential = body.credential;
		if (body.replayed === true) {
			assert(existing);
			credential = await privateText(parsed.outputFile);
			assert(typeof credential === "string" && credential.startsWith("papi_"));
		} else {
			assert(typeof credential === "string" && /^papi_[A-Za-z0-9_-]{43}$/u.test(credential));
			const temporary = `${parsed.outputFile}.${process.pid}.tmp`;
			try {
				await unlink(temporary).catch(() => {});
			await writeFile(temporary, credential, { flag: "wx", mode: 0o600 });
				await rename(temporary, parsed.outputFile);
			} finally { await unlink(temporary).catch(() => {}); }
		}
		return { schemaVersion: 1, kind: "ack-api-credential", status: response.status(), replayed: body.replayed, credentialHash: hash(credential), metadataHash: hash(JSON.stringify(body.metadata ?? {})),
			...(personalRelayKey ? { personalRelayKey } : {}), businessVerified: false };
	} finally { await context.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const file = process.argv[2];
		if (!file) fail("CONFIGURATION_REQUIRED");
		const result = await bootstrapCredential(JSON.parse(await readFile(file, "utf8")));
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} catch { process.stderr.write("ACK_API_CREDENTIAL_BOOTSTRAP_FAILED\n"); process.exitCode = 1; }
}
