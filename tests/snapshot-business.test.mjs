import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOwnEntryServer } from "./fixtures/custom-agent-web/signed-server.ts";
import { runSnapshotBusiness } from "./fixtures/custom-agent-web/snapshot-business.ts";

async function snapshots(t, version = 1) {
	const root = await mkdtemp(join(tmpdir(), "snapshot-business-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = new URL(
		"./fixtures/custom-agent-web/snapshots/",
		import.meta.url,
	);
	await cp(new URL(`repo-v${version}/`, source), join(root, "repo"), {
		recursive: true,
	});
	await cp(new URL("env/", source), join(root, "env"), { recursive: true });
	return root;
}

async function listen(t, configuration) {
	const server = createOwnEntryServer(configuration);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	return `http://127.0.0.1:${server.address().port}`;
}

function signedIdentity() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const configuration = {
		issuer: "snapshot-business-test",
		audience: "agent-a",
		publicKey: publicKey.export({ type: "spki", format: "pem" }),
	};
	const token = (changes = {}) => {
		const encode = (value) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const now = Math.floor(Date.now() / 1000);
		const text = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: configuration.issuer, aud: configuration.audience, sub: "owner", iat: now, exp: now + 300, permissions: ["web:read"], ...changes })}`;
		return `${text}.${sign(null, Buffer.from(text), privateKey).toString("base64url")}`;
	};
	return { configuration, token };
}

test("the HTTP entry executes both repo versions using the separate env dependency", async (t) => {
	const identity = signedIdentity();
	const firstRoot = await snapshots(t);
	const secondRoot = await snapshots(t, 2);
	const first = await listen(t, {
		...identity.configuration,
		role: "api",
		snapshotRoot: firstRoot,
	});
	const second = await listen(t, {
		...identity.configuration,
		audience: "agent-b",
		role: "api",
		snapshotRoot: secondRoot,
	});
	const headers = { authorization: `Bearer ${identity.token()}` };
	const expected = {
		schemaVersion: 1,
		input: 7,
		repoVersion: 1,
		dependencyVersion: "1.0.0",
		total: 55,
	};
	const originalFetch = globalThis.fetch;
	const backend = `http://agent-${"a".repeat(32)}-api:3003`;
	let forwards = 0;
	t.mock.method(globalThis, "fetch", (url, options) => {
		assert.ok(String(url).startsWith(`${backend}/api/snapshot-check?input=`));
		forwards += 1;
		return originalFetch(String(url).replace(backend, first), options);
	});
	const web = await listen(t, {
		...identity.configuration,
		role: "web",
		backend,
	});
	const response = await originalFetch(`${web}/api/snapshot-check?input=7`, {
		headers,
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), expected);
	assert.equal(forwards, 1);
	assert.deepEqual(
		await (
			await originalFetch(`${first}/api/snapshot-check?input=3`, { headers })
		).json(),
		{ ...expected, input: 3, total: 15 },
	);
	const otherHeaders = {
		authorization: `Bearer ${identity.token({ aud: "agent-b" })}`,
	};
	assert.deepEqual(
		await (
			await originalFetch(`${second}/api/snapshot-check?input=7`, {
				headers: otherHeaders,
			})
		).json(),
		{ ...expected, repoVersion: 2, total: 60 },
	);
	for (const [credential, status] of [
		[undefined, 401],
		["forged", 401],
		[identity.token({ aud: "agent-b" }), 401],
		[identity.token({ sub: "viewer", permissions: [] }), 403],
	]) {
		const denied = await originalFetch(`${web}/api/snapshot-check`, {
			headers: {
				"x-user-id": "owner",
				"x-agent-infra-platform-context": "forged",
				...(credential ? { authorization: `Bearer ${credential}` } : {}),
			},
		});
		assert.equal(denied.status, status);
		assert.equal(await denied.text(), "");
	}
	assert.equal(forwards, 1);
	assert.equal(
		(await originalFetch(`${second}/api/snapshot-check`, { headers })).status,
		401,
	);
	for (const query of [
		"input=-1",
		"input=1.5",
		"input=1000001",
		"input=",
		"input=7&input=8",
		"path=/etc/passwd",
		"input=7&snapshotRoot=/tmp",
	]) {
		const refused = await originalFetch(
			`${first}/api/snapshot-check?${query}`,
			{ headers },
		);
		assert.equal(refused.status, 400);
		assert.equal(await refused.text(), "");
	}
	await rm(join(firstRoot, "env/dependency.ts"));
	const missing = await originalFetch(`${first}/api/snapshot-check`, {
		headers,
	});
	assert.equal(missing.status, 503);
	assert.equal(await missing.text(), "");
	const missingThroughWeb = await originalFetch(`${web}/api/snapshot-check`, {
		headers,
	});
	assert.equal(missingThroughWeb.status, 502);
	assert.equal(await missingThroughWeb.text(), "");
});

test("child diagnostics, surplus output and invalid metadata never escape the business boundary", async (t) => {
	const root = await snapshots(t);
	for (const source of [
		'process.stderr.write("synthetic-private-source"); process.exit(1);',
		'process.stdout.write("synthetic-private-source");',
		'process.stdout.write("x".repeat(2048));',
		'console.log(JSON.stringify({schemaVersion:1,input:7,repoVersion:1,dependencyVersion:"1.0.0",total:55,source:"synthetic-private-source"}));',
		'console.log(JSON.stringify({schemaVersion:1,input:999,repoVersion:1,dependencyVersion:"1.0.0",total:55}));',
	]) {
		await writeFile(join(root, "repo/main.ts"), source);
		await assert.rejects(runSnapshotBusiness(root, 7), {
			message: "SNAPSHOT_BUSINESS_UNAVAILABLE",
		});
	}
});

test("business execution is killed after its bounded deadline", {
	timeout: 10000,
}, async (t) => {
	const root = await snapshots(t);
	await writeFile(join(root, "repo/main.ts"), "setInterval(() => {}, 1000);");
	await assert.rejects(runSnapshotBusiness(root, 7), {
		message: "SNAPSHOT_BUSINESS_UNAVAILABLE",
	});
});
