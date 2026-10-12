import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPlatformAuthWebServer } from "./fixtures/custom-agent-web/platform-auth-server.mjs";

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
		const allowed = await request(valid, { "x-user-id": "forged" });
		assert.equal(allowed.status, 200);
		assert.match(await allowed.text(), /Authenticated platform Web for alice/);
		assert.equal(fixture.sideEffects(), 1);

		const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;
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
