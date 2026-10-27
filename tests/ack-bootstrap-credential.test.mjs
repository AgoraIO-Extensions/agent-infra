import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
