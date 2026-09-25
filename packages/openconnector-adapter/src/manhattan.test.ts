import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	ManhattanAdapter,
	ManhattanOAuthAdapter,
	manhattanConnectionCatalog,
} from "./manhattan.ts";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

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

test("Manhattan validates only an OAuth token through its fixed identity endpoint", async () => {
	const requests: Array<{ headers: Headers; url: string }> = [];
	const adapter = new ManhattanAdapter(async (input, init) => {
		requests.push({
			headers: new Headers(init?.headers),
			url: String(input),
		});
		return Response.json({ email: "user@example.com", displayName: "User" });
	}, "machine-key");
	const identity = await adapter.validateCredential("personal-token");
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0]?.url,
		"https://manhattan-api.agoralab.co/api/connection/whoami",
	);
	assert.equal(requests[0]?.headers.get("apikey"), "machine-key");
	assert.equal(
		requests[0]?.headers.get("authorization"),
		"Bearer personal-token",
	);
	assert.equal(identity.externalAccount, "user@example.com");
	assert.deepEqual(identity.grantedScopes, ["manhattan.sdk.read"]);
	assert.equal(identity.accessToken, "personal-token");
});

test("Manhattan identifies RBAC denial without treating it as a bad password", async () => {
	const adapter = new ManhattanAdapter(
		async () => Response.json({ error: "not authorized" }, { status: 403 }),
		"machine-key",
	);
	await assert.rejects(adapter.validateCredential("personal-token"), {
		providerAuthorizationDenied: true,
	});
});

test("Manhattan OAuth exchanges a code and refreshes without handling company passwords", async () => {
	const requests: Array<{ body: string; headers: Headers; url: string }> = [];
	const identity = new ManhattanAdapter(async (_input, init) => {
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			"Bearer personal-token",
		);
		return Response.json({ email: "user@example.com", displayName: "User" });
	}, "machine-key");
	const oauth = new ManhattanOAuthAdapter(
		identity,
		async (input, init) => {
			requests.push({
				body: String(init?.body),
				headers: new Headers(init?.headers),
				url: String(input),
			});
			return Response.json({
				access_token: "personal-token",
				expires_in: 3600,
				...(requests.length === 1 ? { refresh_token: "refresh-token" } : {}),
			});
		},
		"oauth-client",
		"oauth-secret",
	);
	const redirectUri =
		"https://connection.example/oauth/callback?provider=manhattan";
	const authorizationUrl = new URL(
		oauth.getAuthorizationUrl({
			codeChallenge: "challenge",
			redirectUri,
			state: "state",
		}),
	);
	assert.equal(authorizationUrl.origin, "https://oauth.agoralab.co");
	assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUri);
	assert.equal(authorizationUrl.searchParams.get("state"), "state");
	assert.equal(authorizationUrl.searchParams.has("client_secret"), false);
	const connected = await oauth.exchangeCode({
		code: "one-time-code",
		codeVerifier: "verifier",
		redirectUri,
	});
	const refreshed = await oauth.refresh("refresh-token");
	assert.equal(connected.externalAccount, "user@example.com");
	assert.equal(connected.refreshToken, "refresh-token");
	assert.equal(refreshed.refreshToken, "refresh-token");
	assert.equal(refreshed.externalAccount, connected.externalAccount);
	assert.ok(connected.expiresAt);
	assert.deepEqual(
		requests.map((request) => request.url),
		[
			"https://oauth.agoralab.co/oauth/token",
			"https://oauth.agoralab.co/oauth/token",
		],
	);
	assert.equal(
		new URLSearchParams(requests[0]?.body).get("code"),
		"one-time-code",
	);
	assert.equal(
		new URLSearchParams(requests[1]?.body).get("refresh_token"),
		"refresh-token",
	);
	assert.equal(
		requests[0]?.headers.get("authorization"),
		`Basic ${Buffer.from("oauth-client:oauth-secret").toString("base64")}`,
	);
	assert.ok(requests.every((request) => !request.body.includes("password")));
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
