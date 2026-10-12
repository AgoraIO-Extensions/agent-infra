import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	createCustomAgentWebServer,
	parseAuthDocument,
} from "./fixtures/custom-agent-web/server.mjs";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const authFileName = "custom-agent-auth.json";

async function listen(server) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
}

async function writeAuth(path, users) {
	await writeFile(path, JSON.stringify({ users }), { mode: 0o600 });
	await chmod(path, 0o600);
}

test("self-managed Web fixture enforces owner identity and exposes no platform route", async () => {
	const directory = await mkdtemp(join(tmpdir(), "custom-agent-web-fixture-"));
	const authFile = join(directory, authFileName);
	const ownerToken = `owner-${randomBytes(24).toString("hex")}`;
	const viewerToken = `viewer-${randomBytes(24).toString("hex")}`;
	await writeAuth(authFile, [
		{ subject: "owner-1", token: ownerToken, permissions: ["web:read"] },
		{ subject: "viewer-1", token: viewerToken, permissions: [] },
	]);
	const server = createCustomAgentWebServer({ authFile, version: "fixture-a" });
	try {
		const origin = await listen(server);
		const request = (path, headers) =>
			fetch(`${origin}${path}`, { headers, redirect: "error" });

		const health = await request("/healthz");
		assert.equal(health.status, 200);
		assert.deepEqual(await health.json(), {
			status: "ready",
			interactionMode: "self-managed",
			platformAuth: "unavailable",
			version: "fixture-a",
		});

		for (const headers of [
			undefined,
			{
				"x-user-id": "forged-user",
				"x-agent-id": "forged-agent",
				"x-forwarded-user": "forged-user",
			},
			{ "x-agent-infra-platform-context": "forged-context" },
		]) {
			const response = await request("/", headers);
			assert.equal(response.status, 401);
			assert.equal(await response.text(), "");
		}

		const denied = await request("/", {
			authorization: `Bearer ${viewerToken}`,
		});
		assert.equal(denied.status, 403);
		assert.equal(await denied.text(), "");

		const allowed = await request("/", {
			authorization: `Bearer ${ownerToken}`,
		});
		assert.equal(allowed.status, 200);
		assert.match(allowed.headers.get("content-type") ?? "", /^text\/html;/);
		const page = await allowed.text();
		assert.match(page, /Authenticated self-managed Web for owner-1/);
		assert.match(page, /Platform identity entry: unavailable/);
		assert.doesNotMatch(page, new RegExp(ownerToken));
		assert.doesNotMatch(page, /viewer-1|forged-user|forged-agent/);

		const forgedHeader = await request("/", {
			authorization: `Bearer ${ownerToken}`,
			"x-user-id": "forged-user",
			"x-agent-infra-platform-context": "forged-context",
		});
		assert.equal(forgedHeader.status, 200);
		assert.match(await forgedHeader.text(), /for owner-1/);

		const platformRoute = await request("/platform-auth", {
			authorization: `Bearer ${ownerToken}`,
		});
		assert.equal(platformRoute.status, 404);
		assert.equal(await platformRoute.text(), "");

		await writeAuth(authFile, [
			{ subject: "viewer-1", token: viewerToken, permissions: [] },
		]);
		const revoked = await request("/", {
			authorization: `Bearer ${ownerToken}`,
		});
		assert.equal(revoked.status, 401);
		assert.equal(await revoked.text(), "");
	} finally {
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(directory, { recursive: true, force: true });
	}
});

test("self-managed fixture rejects unsafe auth documents and keeps its image contract explicit", async () => {
	assert.throws(() => parseAuthDocument({ users: [{ subject: "owner" }] }));
	assert.throws(() =>
		parseAuthDocument({
			users: [
				{ subject: "owner", token: "same", permissions: ["web:read"] },
				{ subject: "viewer", token: "same", permissions: [] },
			],
		}),
	);
	assert.throws(() =>
		parseAuthDocument({
			users: [{ subject: "owner", token: "token", permissions: ["admin"] }],
		}),
	);

	const dockerfile = await readFile(
		join(fixtureDirectory, "fixtures/custom-agent-web/Dockerfile"),
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
	assert.doesNotMatch(dockerfile, /custom-base-image|workload\/server/);
	assert.throws(() =>
		createCustomAgentWebServer({
			authFile: "/tmp/auth",
			version: "unsafe/version",
		}),
	);
});
