import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ManhattanAdapter, manhattanConnectionCatalog } from "./manhattan.ts";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

const personalPAT = `mhpat_${"a".repeat(43)}`;

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
			"manhattan.get_current_user@v4",
			"manhattan.list_sdk_dumps@v4",
			"manhattan.get_sdk_dump@v4",
			"manhattan.list_symbols@v4",
		],
	);
	assert.ok(
		manhattanConnectionCatalog.actions.every(
			(action) => action.effect === "READ",
		),
	);
});

test("Manhattan validates a personal PAT without sending a company password", async () => {
	const requests: Array<{ headers: Headers; url: string }> = [];
	const adapter = new ManhattanAdapter(async (input, init) => {
		requests.push({
			headers: new Headers(init?.headers),
			url: String(input),
		});
		return Response.json({
			email: "user@example.com",
			displayName: "User",
			scopes: ["manhattan.sdk.read"],
		});
	}, "machine-key");
	const identity = await adapter.validateCredential(personalPAT);
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0]?.url,
		"https://manhattan-api.agoralab.co/api/connection/whoami",
	);
	assert.equal(requests[0]?.headers.get("apikey"), "machine-key");
	assert.equal(
		requests[0]?.headers.get("authorization"),
		`Bearer ${personalPAT}`,
	);
	assert.equal(identity.externalAccount, "user@example.com");
	assert.deepEqual(identity.grantedScopes, ["manhattan.sdk.read"]);
	assert.equal(identity.accessToken, personalPAT);
	await assert.rejects(
		adapter.validateCredential(
			JSON.stringify({ username: "user", password: "secret" }),
		),
		/Manhattan personal PAT is required/,
	);
	assert.equal(requests.length, 1);
});

test("Manhattan refuses a PAT whose identity has no read scope", async () => {
	const adapter = new ManhattanAdapter(
		async () => Response.json({ email: "user@example.com", scopes: [] }),
		"machine-key",
	);
	await assert.rejects(
		adapter.validateCredential(personalPAT),
		/lacks the required read scope/,
	);
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
