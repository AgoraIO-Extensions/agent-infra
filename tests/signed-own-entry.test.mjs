import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
	createOwnEntryServer,
	ownEntryPage,
	ownEntryResult,
} from "./fixtures/custom-agent-web/signed-server.ts";

test("path entry keeps login, backend requests and cookies under its approved prefix", async (t) => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const basePath = `/a/agent-${"a".repeat(32)}/`;
	const server = createOwnEntryServer({
		issuer: "path-test",
		audience: "agent-a",
		publicKey: publicKey.export({ type: "spki", format: "pem" }),
		role: "single",
		basePath,
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	const origin = `http://127.0.0.1:${server.address().port}`;
	const encode = (value) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const now = Math.floor(Date.now() / 1000);
	const payload = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: "path-test", aud: "agent-a", sub: "owner", iat: now, exp: now + 300, permissions: ["web:read"] })}`;
	const token = `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
	const page = await fetch(origin + basePath);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.ok(
		html.includes(`${basePath}auth/login`) && html.includes(`${basePath}app`),
	);
	assert.equal((await fetch(`${origin}${basePath}api/check`)).status, 401);
	for (const path of [
		"/",
		"/auth/login",
		`/a/agent-${"b".repeat(32)}/`,
		`${basePath}../api/check`,
	]) {
		assert.equal((await fetch(origin + path)).status, 404);
	}
	const login = await fetch(`${origin}${basePath}auth/login`, {
		method: "POST",
		headers: {
			origin: origin.replace("http:", "https:"),
			"content-type": "application/json",
		},
		body: JSON.stringify({ token }),
	});
	assert.equal(login.status, 204);
	const cookie = login.headers.get("set-cookie");
	assert.ok(cookie.startsWith("__Secure-custom-entry-agent-"));
	assert.ok(
		cookie.includes(`Path=${basePath}; HttpOnly; Secure; SameSite=Strict`),
	);
	const headers = { cookie: cookie.split(";")[0] };
	const app = await fetch(`${origin}${basePath}app`, { headers });
	assert.equal(app.status, 200);
	assert.ok((await app.text()).includes(`${basePath}api/check`));
	assert.deepEqual(
		await (await fetch(`${origin}${basePath}api/check`, { headers })).json(),
		ownEntryResult,
	);
	assert.equal((await fetch(`${origin}/healthz`)).status, 200);
	const badOrigin = await fetch(`${origin}${basePath}auth/login`, {
		method: "POST",
		headers: { origin: "https://foreign.example.test" },
		body: JSON.stringify({ token }),
	});
	assert.equal(badOrigin.status, 403);
});

test("own entry verifies signed application identity and never trusts supplied principal headers", async (t) => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const issuer = "test-issuer";
	const audience = "test-application";
	const server = createOwnEntryServer({
		issuer,
		audience,
		publicKey: publicKey.export({ type: "spki", format: "pem" }),
		role: "single",
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const origin = `http://127.0.0.1:${server.address().port}`;
	const token = (changes = {}, key = privateKey) => {
		const encode = (value) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const now = Math.floor(Date.now() / 1000);
		const text = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: issuer, aud: audience, sub: "owner", iat: now, exp: now + 300, permissions: ["web:read"], ...changes })}`;
		return `${text}.${sign(null, Buffer.from(text), key).toString("base64url")}`;
	};
	const allowed = token();
	const denied = token({ sub: "viewer", permissions: [] });
	for (const [credential, status] of [
		[null, 401],
		["forged", 401],
		[denied, 403],
		[token({ aud: "other-app" }), 401],
		[token({ exp: 1 }), 401],
		[token({}, generateKeyPairSync("ed25519").privateKey), 401],
	]) {
		const response = await fetch(`${origin}/app`, {
			headers: {
				"x-user-id": "owner",
				"x-agent-infra-platform-context": "forged",
				...(credential ? { authorization: `Bearer ${credential}` } : {}),
			},
		});
		assert.equal(response.status, status);
		assert.equal(await response.text(), "");
	}
	const headers = { authorization: `Bearer ${allowed}`, "x-user-id": "other" };
	const page = await fetch(`${origin}/app`, { headers });
	assert.equal(page.status, 200);
	assert.equal(await page.text(), ownEntryPage);
	const backend = await fetch(`${origin}/api/check`, { headers });
	assert.deepEqual(await backend.json(), ownEntryResult);
	const login = await fetch(`${origin}/auth/login`, {
		method: "POST",
		headers: {
			origin: origin.replace("http:", "https:"),
			"content-type": "application/json",
		},
		body: JSON.stringify({ token: allowed }),
	});
	assert.equal(login.status, 204);
	const cookie = login.headers.get("set-cookie");
	assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/u);
	const persisted = await fetch(`${origin}/app`, {
		headers: { cookie: cookie.split(";")[0] },
	});
	assert.equal(await persisted.text(), ownEntryPage);
	const forgedOrigin = await fetch(`${origin}/auth/login`, {
		method: "POST",
		headers: { origin: "https://foreign.example.test" },
		body: JSON.stringify({ token: allowed }),
	});
	assert.equal(forgedOrigin.status, 403);
	const deniedLogin = await fetch(`${origin}/auth/login`, {
		method: "POST",
		headers: { origin: origin.replace("http:", "https:") },
		body: JSON.stringify({ token: denied }),
	});
	assert.equal(deniedLogin.status, 403);
	assert.equal(deniedLogin.headers.has("set-cookie"), false);
});
