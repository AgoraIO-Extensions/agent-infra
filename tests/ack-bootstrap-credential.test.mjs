import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapCredential } from "../deploy/ack/bootstrap-credential.mjs";

async function fixture(replayed = false) {
	const dir = await mkdtemp(join(tmpdir(), "ack-credential-"));
	const state = join(dir, "state.json");
	const output = join(dir, "credential.json");
	const input = join(dir, "input.json");
	await writeFile(
		state,
		JSON.stringify({
			cookies: [
				{
					name: "__Host-platform-session",
					value: "session-private",
					domain: "127.0.0.1",
					path: "/",
					expires: -1,
					httpOnly: true,
					secure: false,
					sameSite: "Lax",
				},
			],
			origins: [],
		}),
		{ mode: 0o600 },
	);
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		assert.equal(request.headers.cookie?.includes("session-private"), true);
		assert.equal(
			request.headers.origin,
			`http://${server.address().address}:${server.address().port}`,
		);
		assert.equal(request.headers["idempotency-key"], "issue-key");
		assert.equal(JSON.parse(body).scopes.includes("agent:create"), true);
		response.writeHead(replayed ? 200 : 201, {
			"content-type": "application/json",
		});
		response.end(
			JSON.stringify({
				replayed,
				credential: replayed ? null : `papi_${"A".repeat(43)}`,
				metadata: { credentialId: "id", scopes: ["agent:create"] },
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	await writeFile(
		input,
		JSON.stringify({
			schemaVersion: 1,
			origin: origin.replace("http:", "https:"),
			storageStateFile: state,
			outputFile: output,
			scopes: ["agent:create", "agent:read"],
			expiresAt: null,
			idempotencyKey: "issue-key",
		}),
		{ mode: 0o600 },
	);
	return { dir, state, output, input, server, origin };
}

for (const scenario of [
	"empty",
	"existing",
	"replace-failed",
	"changed-readback",
	"invalid-state",
	"public-key-file",
	"missing-key-file",
	"invalid-key-file",
]) {
	test(`personal Relay Key bootstrap ${scenario} keeps the authenticated HTTP and API credential order`, async (t) => {
		const f = await fixture();
		t.after(async () => {
			f.server.closeAllConnections();
			f.server.close();
			await rm(f.dir, { recursive: true, force: true });
		});
		const keyFile = join(f.dir, "personal.key");
		const key = "sk-private-fixture-do-not-log";
		await writeFile(keyFile, scenario === "invalid-key-file" ? "short" : key, {
			mode: 0o600,
		});
		if (scenario === "public-key-file") await chmod(keyFile, 0o644);
		if (scenario === "missing-key-file") await rm(keyFile);
		const config = {
			...JSON.parse(await readFile(f.input, "utf8")),
			origin: f.origin,
			personalRelayKeyFile: keyFile,
		};
		const calls = [];
		let version = scenario === "existing" ? 5 : null;
		f.server.removeAllListeners("request");
		f.server.on("request", async (request, response) => {
			let body = "";
			for await (const chunk of request) body += chunk;
			calls.push(`${request.method} ${request.url}`);
			assert(request.headers.cookie?.includes("session-private"));
			assert.equal(request.headers.authorization, undefined);
			response.setHeader("content-type", "application/json");
			if (request.url === "/api/v2/me/relay-key") {
				if (request.method === "PUT") {
					assert.equal(request.headers.origin, f.origin);
					assert.deepEqual(JSON.parse(body), {
						expectedVersion: null,
						keyValue: key,
					});
					if (scenario === "replace-failed") {
						response.writeHead(409);
						response.end(JSON.stringify({ code: "CONFLICT" }));
						return;
					}
					version = 1;
					response.end(
						JSON.stringify({ schemaVersion: 1, isSet: true, keyVersion: 1 }),
					);
					return;
				}
				assert.equal(request.method, "GET");
				if (scenario === "invalid-state") {
					response.end(
						JSON.stringify({ schemaVersion: 1, isSet: true, keyVersion: null }),
					);
					return;
				}
				response.end(
					JSON.stringify({
						schemaVersion: 1,
						isSet: version !== null,
						keyVersion:
							scenario === "changed-readback" && version !== null ? 2 : version,
					}),
				);
				return;
			}
			assert.equal(request.url, "/api/v2/me/api-credentials");
			assert(version !== null);
			assert.equal(request.method, "POST");
			assert.equal(request.headers.origin, f.origin);
			response.writeHead(201);
			response.end(
				JSON.stringify({
					replayed: false,
					credential: `papi_${"A".repeat(43)}`,
					metadata: {},
				}),
			);
		});
		if (["empty", "existing"].includes(scenario)) {
			const result = await bootstrapCredential(config);
			assert.deepEqual(result.personalRelayKey, {
				mode:
					scenario === "empty"
						? "installed-and-read-back"
						: "existing-retained",
				keyVersion: scenario === "empty" ? 1 : 5,
			});
			assert.equal(JSON.stringify(result).includes(key), false);
			assert.deepEqual(calls, [
				"GET /api/v2/me/relay-key",
				...(scenario === "empty" ? ["PUT /api/v2/me/relay-key"] : []),
				"GET /api/v2/me/relay-key",
				"POST /api/v2/me/api-credentials",
			]);
		} else {
			await assert.rejects(bootstrapCredential(config));
			assert.equal(calls.includes("POST /api/v2/me/api-credentials"), false);
			await assert.rejects(readFile(f.output), { code: "ENOENT" });
			if (scenario.endsWith("key-file")) assert.deepEqual(calls, []);
		}
	});
}

test("credential bootstrap rejects non-HTTPS origins before networking", async () => {
	const f = await fixture();
	try {
		await assert.rejects(
			bootstrapCredential({
				schemaVersion: 1,
				origin: "http://bad",
				storageStateFile: f.state,
				outputFile: f.output,
				scopes: ["agent:create"],
				expiresAt: null,
				idempotencyKey: "issue-key",
			}),
			/AssertionError/,
		);
	} finally {
		f.server.close();
	}
});

test("credential bootstrap writes one-time material privately and never returns it", async () => {
	const f = await fixture();
	const config = JSON.parse(await readFile(f.input, "utf8"));
	config.origin = f.origin;
	await writeFile(f.input, JSON.stringify(config), { mode: 0o600 });
	try {
		const result = await bootstrapCredential(config);
		assert.equal(result.replayed, false);
		assert.match(result.credentialHash, /^[a-f0-9]{64}$/);
		assert(!JSON.stringify(result).includes("papi_"));
		assert.equal(await readFile(f.output, "utf8"), `papi_${"A".repeat(43)}`);
	} finally {
		f.server.close();
	}
});

test("same idempotency key replay reads the existing private credential and never replaces it", async () => {
	const f = await fixture(true);
	const config = JSON.parse(await readFile(f.input, "utf8"));
	config.origin = f.origin;
	await writeFile(f.output, `papi_${"B".repeat(43)}`, { mode: 0o600 });
	try {
		const result = await bootstrapCredential(config);
		assert.equal(result.replayed, true);
		assert.match(result.credentialHash, /^[a-f0-9]{64}$/);
		assert.equal(await readFile(f.output, "utf8"), `papi_${"B".repeat(43)}`);
	} finally {
		f.server.close();
	}
});
