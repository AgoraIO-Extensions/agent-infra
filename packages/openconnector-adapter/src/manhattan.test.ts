import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ManhattanAdapter, manhattanConnectionCatalog } from "./manhattan.ts";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

function loginCredential() {
	return JSON.stringify({ password: "secret", username: "user@example.com" });
}

test("Manhattan executor digest pins its reviewed source", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./manhattan.ts", import.meta.url)))
		.digest("hex");
	assert.equal(manhattanExecutorDigest, `sha256:${digest}`);
});

test("Manhattan catalog is read only", () => {
	assert.equal(manhattanConnectionCatalog.actions.length, 4);
	assert.deepEqual(
		manhattanConnectionCatalog.actions.map((action) => action.id),
		[
			"manhattan.get_current_user@v3",
			"manhattan.list_sdk_dumps@v3",
			"manhattan.get_sdk_dump@v3",
			"manhattan.list_symbols@v3",
		],
	);
	assert.ok(
		manhattanConnectionCatalog.actions.every(
			(action) => action.effect === "READ",
		),
	);
});

test("Manhattan exchanges login credentials and stores only the token", async () => {
	const requests: Array<{ body?: string; headers: Headers; url: string }> = [];
	const adapter = new ManhattanAdapter(async (input, init) => {
		requests.push({
			body: init?.body as string,
			headers: new Headers(init?.headers),
			url: String(input),
		});
		if (String(input).endsWith("/login"))
			return Response.json({ data: { token: "personal-token" } });
		return Response.json({ email: "user@example.com", displayName: "User" });
	}, "machine-key");
	const identity = await adapter.validateCredential(loginCredential());
	assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
		password: "secret",
		username: "user@example.com",
	});
	assert.equal(requests[0]?.headers.get("apikey"), "machine-key");
	assert.equal(
		requests[1]?.headers.get("authorization"),
		"Bearer personal-token",
	);
	assert.equal(identity.externalAccount, "user@example.com");
	assert.deepEqual(identity.grantedScopes, ["manhattan.sdk.read"]);
	assert.equal(identity.accessToken, "personal-token");
	assert.equal(JSON.stringify(identity).includes("secret"), false);
});

test("Manhattan maps actions only to fixed endpoints", async () => {
	const requests: Array<{ method?: string; url: string }> = [];
	const adapter = new ManhattanAdapter(async (input, init) => {
		requests.push({ method: init?.method, url: String(input) });
		return Response.json({ data: [] });
	}, "machine-key");
	await adapter.execute({
		action: "manhattan.list_sdk_dumps",
		credential: { accessToken: "token" },
		input: { current: 1 },
	});
	await adapter.execute({
		action: "manhattan.list_symbols",
		credential: { accessToken: "token" },
		input: { pageSize: 20 },
	});
	assert.equal(
		requests[0]?.url,
		"https://manhattan-api.agoralab.co/api/connection/sdk/dumps",
	);
	assert.equal(requests[0]?.method, "POST");
	assert.equal(
		requests[1]?.url,
		"https://manhattan-api.agoralab.co/api/connection/sdk/symbols?pageSize=20",
	);
});

test("Manhattan stops reading responses above 64 KiB", async () => {
	const adapter = new ManhattanAdapter(
		async () => new Response("x".repeat(64 * 1024 + 1)),
		"machine-key",
	);
	await assert.rejects(
		adapter.execute({
			action: "manhattan.get_current_user",
			credential: { accessToken: "token" },
			input: {},
		}),
		/response is too large/,
	);
});
