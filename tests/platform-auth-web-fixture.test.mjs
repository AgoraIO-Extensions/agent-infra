import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createPlatformAuthWebServer,
	parsePublicKeyDocument,
} from "./fixtures/custom-agent-web/platform-auth-server.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

const encode = (value) =>
	Buffer.from(JSON.stringify(value)).toString("base64url");
function token(privateKey, keyVersion, claims) {
	const header = encode({
		alg: "EdDSA",
		kid: keyVersion,
		typ: "platform-entry+jws",
	});
	const payload = encode(claims);
	const input = `${header}.${payload}`;
	return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}
async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return `http://127.0.0.1:${server.address().port}`;
}
async function writeAuth(path, revision = "r1") {
	await writeFile(
		path,
		JSON.stringify({
			users: [{ userId: "alice", authorizationRevision: revision }],
		}),
		{ mode: 0o600 },
	);
	await chmod(path, 0o600);
}
async function freePort() {
	const server = createNetServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const port = address.port;
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}
function claims(keyVersion, now, revision = "r1") {
	return {
		schemaVersion: 1,
		issuer: "fixture-issuer",
		audience: "custom_agent",
		issuedAt: now,
		expiresAt: now + 30_000,
		contextId: "context-1",
		keyVersion,
		userId: "alice",
		organizationIds: ["org-1"],
		roles: ["employee"],
		authorizationRevision: revision,
		agentId: "agent-1",
	};
}

test("platform-auth fixture verifies context, rotation and request-time revocation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "platform-auth-fixture-"));
	const authFile = join(directory, "authorization.json");
	await writeAuth(authFile);
	const oldPair = generateKeyPairSync("ed25519");
	const newPair = generateKeyPairSync("ed25519");
	let now = 1_000_000;
	const publicKeys = new Map([["k1", oldPair.publicKey]]);
	const fixture = createPlatformAuthWebServer({
		publicKeys,
		issuer: "fixture-issuer",
		agentId: "agent-1",
		authFile,
		now: () => now,
		version: "fixture-b",
	});
	const origin = await listen(fixture.server);
	const request = (value, headers = {}) =>
		fetch(origin, {
			headers: { "x-agent-infra-platform-context": value, ...headers },
			redirect: "error",
		});
	try {
		const valid = token(oldPair.privateKey, "k1", claims("k1", now));
		const health = await fetch(`${origin}/healthz`, { redirect: "error" });
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), {
			status: "ready",
			interactionMode: "self-managed",
			identityResponsibility: "platform-managed",
			version: "fixture-b",
		});
		const allowed = await request(valid, { "x-user-id": "forged" });
		assert.equal(allowed.status, 200);
		assert.match(await allowed.text(), /Authenticated platform Web for alice/);
		assert.equal(fixture.sideEffects(), 1);

		const [headerPart, payloadPart, signaturePart] = valid.split(".");
		const tamperedSignature = `${signaturePart.startsWith("A") ? "B" : "A"}${signaturePart.slice(1)}`;
		const tampered = `${headerPart}.${payloadPart}.${tamperedSignature}`;
		const rejected = await request(tampered);
		assert.equal(rejected.status, 401);
		assert.equal(await rejected.text(), "");
		assert.equal(fixture.sideEffects(), 1);
		for (const invalidClaims of [
			{ ...claims("k1", now), issuer: "other-issuer" },
			{ ...claims("k1", now), audience: "other-audience" },
			{ ...claims("k1", now), agentId: "other-agent" },
		]) {
			assert.equal(
				(await request(token(oldPair.privateKey, "k1", invalidClaims))).status,
				401,
			);
		}
		assert.equal(fixture.sideEffects(), 1);

		await writeAuth(authFile, "r2");
		const revoked = await request(valid);
		assert.equal(revoked.status, 403);
		assert.equal(fixture.sideEffects(), 1);

		publicKeys.set("k2", newPair.publicKey);
		const rotated = await request(
			token(newPair.privateKey, "k2", claims("k2", now, "r2")),
		);
		assert.equal(rotated.status, 200);
		publicKeys.delete("k1");
		assert.equal((await request(valid)).status, 401);

		now += 30_000;
		assert.equal(
			(
				await request(
					token(newPair.privateKey, "k2", claims("k2", now - 30_000, "r2")),
				)
			).status,
			401,
		);
	} finally {
		await new Promise((resolve, reject) =>
			fixture.server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(directory, { recursive: true, force: true });
	}
});

test("platform-auth sample image keeps the platform identity verifier contract explicit", async () => {
	const dockerfile = await readFile(
		join(
			fixtureDirectory,
			"fixtures/custom-agent-web/Dockerfile.platform-auth",
		),
		"utf8",
	);
	assert.match(dockerfile, /^FROM node@sha256:[a-f0-9]{64}$/m);
	assert.match(
		dockerfile,
		/LABEL io\.agora\.agent\.runtime\.manifest='([^']+)'/,
	);
	const manifest = JSON.parse(
		dockerfile.match(
			/LABEL io\.agora\.agent\.runtime\.manifest='([^']+)'/,
		)?.[1],
	);
	assert.deepEqual(manifest, {
		schemaVersion: 1,
		interactionMode: "self-managed",
		service: { port: 8080 },
		health: { path: "/healthz" },
	});
	assert.match(dockerfile, /COPY --chown=node:node platform-auth-server\.mjs/);
	assert.match(
		dockerfile,
		/ENTRYPOINT \["node", "\/app\/platform-auth-server\.mjs"\]/,
	);
	assert.doesNotMatch(dockerfile, /custom-base-image|workload\/server/);
	const contractPair = generateKeyPairSync("ed25519");
	const publicKey = contractPair.publicKey.export({
		type: "spki",
		format: "pem",
	});
	assert.equal(
		parsePublicKeyDocument({ keys: { k1: publicKey } }).get("k1")
			.asymmetricKeyType,
		"ed25519",
	);
	assert.throws(() =>
		parsePublicKeyDocument({ keys: { k1: publicKey }, extra: true }),
	);
	assert.throws(() => parsePublicKeyDocument({ keys: { k1: "invalid" } }));

	const entrypoint = join(
		fixtureDirectory,
		"fixtures/custom-agent-web/platform-auth-server.mjs",
	);
	const child = spawn(process.execPath, [entrypoint], {
		env: Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) =>
					![
						"PLATFORM_AUTH_PUBLIC_KEYS_FILE",
						"PLATFORM_AUTH_AUTHORIZATION_FILE",
						"PLATFORM_AUTH_ISSUER",
						"PLATFORM_AUTH_AGENT_ID",
					].includes(key),
			),
		),
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	assert.equal(exitCode, 1);
	assert.equal(stderr, "PLATFORM_AUTH_CONFIGURATION_REQUIRED\n");

	const directory = await mkdtemp(join(tmpdir(), "platform-auth-entrypoint-"));
	const authFile = join(directory, "authorization.json");
	const publicKeysFile = join(directory, "public-keys.json");
	const entryPair = generateKeyPairSync("ed25519");
	await writeAuth(authFile);
	await writeFile(
		publicKeysFile,
		JSON.stringify({
			keys: {
				k1: entryPair.publicKey.export({ type: "spki", format: "pem" }),
			},
		}),
		{ mode: 0o600 },
	);
	await chmod(publicKeysFile, 0o600);
	const port = await freePort();
	const running = spawn(process.execPath, [entrypoint], {
		env: {
			...process.env,
			PLATFORM_AUTH_PUBLIC_KEYS_FILE: publicKeysFile,
			PLATFORM_AUTH_AUTHORIZATION_FILE: authFile,
			PLATFORM_AUTH_ISSUER: "fixture-issuer",
			PLATFORM_AUTH_AGENT_ID: "agent-1",
			PORT: String(port),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let runningStderr = "";
	running.stdout.on("data", (chunk) => (stdout += chunk));
	running.stderr.on("data", (chunk) => (runningStderr += chunk));
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`entrypoint did not start: ${runningStderr}`)),
			5_000,
		);
		const onData = () => {
			if (stdout.includes('"event":"listening"')) {
				clearTimeout(timeout);
				running.stdout.off("data", onData);
				resolve();
			}
		};
		running.stdout.on("data", onData);
		running.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
	const health = await fetch(`http://127.0.0.1:${port}/healthz`);
	assert.equal(health.status, 200);
	assert.deepEqual(await health.json(), {
		status: "ready",
		interactionMode: "self-managed",
		identityResponsibility: "platform-managed",
		version: "sample",
	});
	running.kill("SIGTERM");
	await new Promise((resolve) => running.once("close", resolve));
	assert.equal(runningStderr, "");
	await rm(directory, { recursive: true, force: true });
});
