import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { bundleSignedOwnEntry } from "../deploy/release/bundle-signed-own-entry.mts";
import {
	createOwnEntryServer,
	ownEntryResult,
} from "./fixtures/custom-agent-web/signed-server.ts";

async function fixture(t, basePath = "/", factory = createOwnEntryServer) {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const server = factory({
		issuer: "protocol-fixture",
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
	return {
		server,
		origin,
		publicOrigin: origin.replace("http:", "https:"),
		entry: origin + basePath,
		token(changes = {}) {
			const encode = (value) =>
				Buffer.from(JSON.stringify(value)).toString("base64url");
			const now = Math.floor(Date.now() / 1000);
			const data = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: "protocol-fixture", aud: "agent-a", sub: "fixture-owner", iat: now, exp: now + 300, permissions: ["web:read"], ...changes })}`;
			return `${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`;
		},
	};
}

test("the shipped self-contained bundle preserves entrypoint behavior and snapshot execution", {
	timeout: 10000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "own-entry-bundle-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const output = join(directory, "signed-server.ts");
	await bundleSignedOwnEntry(output);
	await assert.rejects(bundleSignedOwnEntry(output));
	const require = createRequire(import.meta.url);
	const built = require(output);
	const root = join(directory, "snapshots");
	for (const [source, target] of [
		["repo-v1/main.ts", "repo/main.ts"],
		["env/dependency.ts", "env/dependency.ts"],
	]) {
		await mkdir(join(root, target, ".."), { recursive: true });
		await writeFile(
			join(root, target),
			await readFile(
				new URL(
					`./fixtures/custom-agent-web/snapshots/${source}`,
					import.meta.url,
				),
			),
		);
	}
	const f = await fixture(t, "/", (options) =>
		built.createOwnEntryServer({ ...options, snapshotRoot: root }),
	);
	const headers = { authorization: `Bearer ${f.token()}` };
	const events = await fetch(`${f.entry}api/events`, { headers });
	assert.match(await events.text(), /event: complete/u);
	const socket = openSocket(t, f, { headers });
	await once(socket, "open");
	const message = once(socket, "message");
	const closed = once(socket, "close");
	socket.send("check");
	assert.deepEqual(JSON.parse((await message)[0].toString()), ownEntryResult);
	await closed;
	const snapshot = await (
		await fetch(`${f.entry}api/snapshot-check?input=7`, { headers })
	).json();
	assert.equal(snapshot.repoVersion, 1);
	assert.equal(snapshot.total, 55);
});

function openSocket(t, f, { path = "ws", headers = {} } = {}) {
	const socket = new WebSocket(f.entry.replace("http:", "ws:") + path, {
		handshakeTimeout: 1000,
		headers: { origin: f.publicOrigin, ...headers },
	});
	// A rejected handshake or intentional protocol failure must not escape teardown.
	socket.on("error", () => {});
	t.after(() => socket.terminate());
	return socket;
}

async function upgradeStatus(t, f, headers) {
	const socket = openSocket(t, f, { headers });
	return new Promise((resolve, reject) => {
		socket.once("open", () => {
			socket.close();
			resolve(101);
		});
		socket.once("unexpected-response", (request, response) => {
			response.resume();
			request.destroy();
			resolve(response.statusCode);
		});
		socket.once("error", reject);
	});
}

test("authenticated SSE delivers its first event before the bounded completion", {
	timeout: 5000,
}, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = await fixture(t);
	const response = await fetch(`${f.entry}api/events`, {
		headers: { authorization: `Bearer ${f.token()}` },
	});
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type"), /^text\/event-stream/u);
	assert.equal(response.headers.get("x-accel-buffering"), "no");
	const reader = response.body.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	assert.match(first, /event: status/u);
	assert.equal(first.includes("event: complete"), false);
	t.mock.timers.tick(1000);
	let tail = "";
	for (;;) {
		const item = await reader.read();
		if (item.done) break;
		tail += new TextDecoder().decode(item.value);
	}
	assert.match(tail, /event: complete/u);
	assert.deepEqual(
		JSON.parse(first.match(/^data: (.+)$/mu)[1]),
		ownEntryResult,
	);
});

for (const basePath of ["/", `/a/agent-${"a".repeat(32)}/`]) {
	test(`same application cookie protects assets, SSE, WebSocket and logout at ${basePath}`, {
		timeout: 5000,
	}, async (t) => {
		const f = await fixture(t, basePath);
		const login = await fetch(`${f.entry}auth/login`, {
			method: "POST",
			headers: { origin: f.publicOrigin, "content-type": "application/json" },
			body: JSON.stringify({ token: f.token() }),
		});
		assert.equal(login.status, 204);
		const cookie = login.headers.get("set-cookie");
		assert.ok(
			cookie.includes(`Path=${basePath}; HttpOnly; Secure; SameSite=Strict`),
		);
		assert.equal(/(?:^|;)\s*Domain=/iu.test(cookie), false);
		const headers = { cookie: cookie.split(";")[0] };
		const app = await (await fetch(`${f.entry}app`, { headers })).text();
		assert.ok(app.includes(`${basePath}assets/protocols.js`));
		const asset = await fetch(`${f.entry}assets/protocols.js`, { headers });
		assert.equal(asset.status, 200);
		assert.match(asset.headers.get("content-type"), /javascript/u);
		const script = await asset.text();
		assert.ok(
			script.includes(`${basePath}api/events`) &&
				script.includes(`${basePath}ws`),
		);
		const events = await fetch(`${f.entry}api/events`, { headers });
		assert.equal(events.status, 200);
		assert.match(await events.text(), /event: complete/u);
		const socket = openSocket(t, f, { headers });
		await once(socket, "open");
		const message = once(socket, "message");
		const closed = once(socket, "close");
		socket.send("check");
		assert.deepEqual(JSON.parse((await message)[0].toString()), ownEntryResult);
		assert.equal((await closed)[0], 1000);
		assert.equal(
			(
				await fetch(`${f.entry}auth/logout`, {
					method: "POST",
					headers: { ...headers, origin: "https://foreign.example.test" },
				})
			).status,
			403,
		);
		const logout = await fetch(`${f.entry}auth/logout`, {
			method: "POST",
			headers: { ...headers, origin: f.publicOrigin },
		});
		assert.equal(logout.status, 204);
		assert.match(logout.headers.get("set-cookie"), /Max-Age=0/u);
		for (const path of ["app", "assets/protocols.js", "api/events"]) {
			assert.equal((await fetch(f.entry + path)).status, 401);
		}
	});
}

test("web role streams and upgrades using the same authorized private API service", {
	timeout: 5000,
}, async (t) => {
	let backend;
	const service = `http://agent-${"a".repeat(32)}-api:3003`;
	const f = await fixture(t, "/", (configuration) => {
		backend = createOwnEntryServer({ ...configuration, role: "api" });
		return createOwnEntryServer({
			...configuration,
			role: "web",
			backend: service,
		});
	});
	await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise((resolve) => {
				backend.close(resolve);
				backend.closeAllConnections();
			}),
	);
	const request = globalThis.fetch;
	let forwarded = 0;
	t.mock.method(globalThis, "fetch", (url, options) => {
		if (url === `${service}/api/check`) {
			forwarded++;
			assert.match(options.headers.authorization, /^Bearer /u);
			return request(
				`http://127.0.0.1:${backend.address().port}/api/check`,
				options,
			);
		}
		return request(url, options);
	});
	const headers = { authorization: `Bearer ${f.token()}` };
	const events = await fetch(`${f.entry}api/events`, { headers });
	assert.match(await events.text(), /event: complete/u);
	const socket = openSocket(t, f, { headers });
	await once(socket, "open");
	const message = once(socket, "message");
	const closed = once(socket, "close");
	socket.send("check");
	assert.deepEqual(JSON.parse((await message)[0].toString()), ownEntryResult);
	await closed;
	assert.equal(forwarded, 2);
	assert.equal((await fetch(`${f.entry}api/events`)).status, 401);
	assert.equal(forwarded, 2);
});

test("protocol endpoints reject missing, forged, cross-Agent and unauthorized identities", {
	timeout: 5000,
}, async (t) => {
	const f = await fixture(t);
	for (const [token, expected] of [
		[undefined, 401],
		["forged", 401],
		[f.token({ aud: "agent-b" }), 401],
		[f.token({ exp: 1 }), 401],
		[f.token({ permissions: [] }), 403],
	]) {
		const headers = {
			"x-user-id": "fixture-owner",
			"x-agent-infra-platform-context": "forged",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		};
		for (const path of ["api/events", "assets/protocols.js"]) {
			assert.equal((await fetch(f.entry + path, { headers })).status, expected);
		}
		assert.equal(await upgradeStatus(t, f, headers), expected);
	}
	assert.equal(
		await upgradeStatus(t, f, {
			authorization: `Bearer ${f.token()}`,
			origin: "https://foreign.example.test",
		}),
		403,
	);
});

for (const [input, options, expectedClose] of [
	["not-a-check", {}, 1008],
	[Buffer.from("check"), { binary: true }, 1008],
	["x".repeat(4097), {}, 1009],
]) {
	test(`WebSocket rejects unsupported or oversized frames (${expectedClose})`, {
		timeout: 5000,
	}, async (t) => {
		const f = await fixture(t);
		const socket = openSocket(t, f, {
			headers: { authorization: `Bearer ${f.token()}` },
		});
		await once(socket, "open");
		const closed = once(socket, "close");
		socket.send(input, options);
		assert.equal((await closed)[0], expectedClose);
		assert.equal(
			(
				await fetch(`${f.entry}api/check`, {
					headers: { authorization: `Bearer ${f.token()}` },
				})
			).status,
			200,
		);
	});
}

test("a malformed upgrade target is rejected without crashing the application", {
	timeout: 5000,
}, async () => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const source = new URL(
		"./fixtures/custom-agent-web/signed-server.ts",
		import.meta.url,
	).href;
	const code = `
import { createOwnEntryServer } from ${JSON.stringify(source)};
import { generateKeyPairSync } from 'node:crypto';
import { request } from 'node:http';
const { publicKey } = generateKeyPairSync('ed25519');
const server = createOwnEntryServer({ issuer:'test', audience:'test', role:'single', publicKey:publicKey.export({type:'spki',format:'pem'}) });
server.listen(0,'127.0.0.1',()=>{
  request({hostname:'127.0.0.1',port:server.address().port,path:'//[',headers:{connection:'Upgrade',upgrade:'websocket'}}, async response=>{
    response.resume();
    const healthy=(await fetch('http://127.0.0.1:'+server.address().port+'/healthz')).status;
    console.log(JSON.stringify({status:response.statusCode,healthy}));
    server.close(()=>process.exit(0));
    server.closeAllConnections();
  }).end();
});
`;
	const result = await promisify(execFile)(
		process.execPath,
		["--input-type=module", "-e", code],
		{ timeout: 3000 },
	);
	assert.deepEqual(JSON.parse(result.stdout), { status: 400, healthy: 200 });
});
