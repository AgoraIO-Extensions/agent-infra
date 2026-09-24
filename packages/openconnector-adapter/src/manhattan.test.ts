import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ManhattanAdapter, manhattanConnectionCatalog } from "./manhattan.ts";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

function session(accessToken: string) {
	const payload = Buffer.from(
		JSON.stringify({ access_token: accessToken }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function credential(accessToken: string) {
	return JSON.stringify({
		email: "user@example.com",
		sessionToken: session(accessToken),
	});
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
			"manhattan.get_current_user@v2",
			"manhattan.list_sdk_dumps@v2",
			"manhattan.get_sdk_dump@v2",
			"manhattan.list_symbols@v2",
		],
	);
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
	const identity = await adapter.validateCredential(
		credential("personal-token"),
	);
	assert.equal(headers.get("apikey"), "machine-key");
	assert.equal(headers.get("authorization"), "Bearer personal-token");
	assert.equal(identity.externalAccount, "user@example.com");
	assert.deepEqual(identity.grantedScopes, ["manhattan.sdk.read"]);
	assert.equal(JSON.parse(identity.accessToken).email, "user@example.com");
});

test("Manhattan maps actions only to fixed endpoints", async () => {
	const requests: Array<{ method?: string; url: string }> = [];
	const adapter = new ManhattanAdapter(async (input, init) => {
		requests.push({ method: init?.method, url: String(input) });
		return Response.json({ data: [] });
	}, "machine-key");
	await adapter.execute({
		action: "manhattan.list_sdk_dumps",
		credential: { accessToken: credential("token") },
		input: { current: 1 },
	});
	await adapter.execute({
		action: "manhattan.list_symbols",
		credential: { accessToken: credential("token") },
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
			credential: { accessToken: credential("token") },
			input: {},
		}),
		/response is too large/,
	);
});

test("Manhattan refreshes an expired HCI session once", async () => {
	const requests: string[] = [];
	const adapter = new ManhattanAdapter(async (input) => {
		requests.push(String(input));
		if (String(input) === "https://grafana.bj2.agoralab.co/") {
			return new Response(null, {
				headers: {
					"set-cookie": `HCIAuthToken=${session("fresh-token")}; Path=/`,
				},
				status: 200,
			});
		}
		if (requests.filter((url) => url.includes("/api/connection/")).length === 1)
			return new Response(null, { status: 401 });
		return Response.json({ email: "user@example.com", displayName: "User" });
	}, "machine-key");

	const identity = await adapter.validateCredential(
		credential("expired-token"),
	);

	assert.deepEqual(requests, [
		"https://manhattan-api.agoralab.co/api/connection/whoami",
		"https://grafana.bj2.agoralab.co/",
		"https://manhattan-api.agoralab.co/api/connection/whoami",
	]);
	assert.equal(
		JSON.parse(identity.accessToken).sessionToken,
		session("fresh-token"),
	);
});

test("Manhattan compares HCI email identity case-insensitively", async () => {
	const adapter = new ManhattanAdapter(
		async () => Response.json({ email: "USER@example.com" }),
		"machine-key",
	);
	const identity = await adapter.validateCredential(credential("token"));
	assert.equal(identity.externalAccount, "user@example.com");
});

test("Manhattan does not rotate credentials during action execution", async () => {
	const requests: string[] = [];
	const adapter = new ManhattanAdapter(async (input) => {
		requests.push(String(input));
		return new Response(null, { status: 401 });
	}, "machine-key");
	await assert.rejects(
		adapter.execute({
			action: "manhattan.get_current_user",
			credential: { accessToken: credential("expired-token") },
			input: {},
		}),
		/credential was rejected/,
	);
	assert.deepEqual(requests, [
		"https://manhattan-api.agoralab.co/api/connection/whoami",
	]);
});
