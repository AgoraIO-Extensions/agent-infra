import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ManhattanAdapter, manhattanConnectionCatalog } from "./manhattan.ts";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

test("Manhattan executor digest pins its reviewed source", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./manhattan.ts", import.meta.url)))
		.digest("hex");
	assert.equal(manhattanExecutorDigest, `sha256:${digest}`);
});

test("Manhattan catalog is read only", () => {
	assert.equal(manhattanConnectionCatalog.actions.length, 4);
	assert.ok(
		manhattanConnectionCatalog.actions.every(
			(action) => action.effect === "READ",
		),
	);
});

test("Manhattan validates identity with machine and personal credentials", async () => {
	let headers = new Headers();
	const adapter = new ManhattanAdapter(async (_input, init) => {
		headers = new Headers(init?.headers);
		return Response.json({ email: "user@example.com", displayName: "User" });
	}, "machine-key");
	const credential = await adapter.validateCredential("personal-token");
	assert.equal(headers.get("apikey"), "machine-key");
	assert.equal(headers.get("authorization"), "Bearer personal-token");
	assert.equal(credential.externalAccount, "user@example.com");
	assert.deepEqual(credential.grantedScopes, ["manhattan.sdk.read"]);
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
