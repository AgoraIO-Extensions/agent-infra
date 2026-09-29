import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	ManhattanAdapter,
	ManhattanOAuthAdapter,
	manhattanConnectionCatalog,
	manhattanLegacyProviderReleaseIds,
} from "./manhattan.ts";
import { manhattanExecutorDigest } from "./manhattan-integrity.ts";

test("Manhattan executor digest pins its reviewed source", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./manhattan.ts", import.meta.url)))
		.digest("hex");
	assert.equal(manhattanExecutorDigest, `sha256:${digest}`);
});

test("Manhattan catalog adds only explicit crash READ Actions", () => {
	assert.equal(
		manhattanConnectionCatalog.providerReleaseId,
		"manhattan-connection-v5",
	);
	assert.deepEqual(manhattanLegacyProviderReleaseIds, [
		"manhattan-connection-v4",
	]);
	assert.equal(manhattanConnectionCatalog.actions.length, 6);
	assert.deepEqual(
		manhattanConnectionCatalog.actions.map((action) => action.id),
		[
			"manhattan.get_current_user@v5",
			"manhattan.list_sdk_dumps@v5",
			"manhattan.get_sdk_dump@v5",
			"manhattan.list_symbols@v5",
			"manhattan.get_crash_profile@v1",
			"manhattan.get_crash_thread@v1",
		],
	);
	assert.ok(
		manhattanConnectionCatalog.actions.every(
			(action) => action.effect === "READ",
		),
	);
});

test("Manhattan parses a crash profile URL but only requests fixed bounded endpoints", async () => {
	const requests: Array<{ headers: Headers; url: string }> = [];
	const adapter = new ManhattanAdapter(async (input, init) => {
		requests.push({ headers: new Headers(init?.headers), url: String(input) });
		return Response.json({
			data: { eventUuid: "0123456789ABCDEF0123456789ABCDEF" },
		});
	}, "machine-key");
	const url =
		"https://manhattan.agoralab.co/crash/profile?id=0123456789abcdef0123456789abcdef";
	await adapter.execute({
		action: "manhattan.get_crash_profile",
		credential: { accessToken: "personal-token" },
		input: { url, threadOffset: 20, threadLimit: 2, moduleLimit: 1 },
	});
	await adapter.execute({
		action: "manhattan.get_crash_thread",
		credential: { accessToken: "personal-token" },
		input: { url, index: 7, offset: 10, limit: 5 },
	});
	assert.deepEqual(
		requests.map((request) => request.url),
		[
			"https://manhattan-api.agoralab.co/api/connection/crash/profile?id=0123456789ABCDEF0123456789ABCDEF&threadOffset=20&threadLimit=2&moduleLimit=1",
			"https://manhattan-api.agoralab.co/api/connection/crash/thread?id=0123456789ABCDEF0123456789ABCDEF&index=7&offset=10&limit=5",
		],
	);
	assert.ok(
		requests.every(
			(request) =>
				request.headers.get("authorization") === "Bearer personal-token" &&
				request.headers.get("apikey") === "machine-key",
		),
	);

	for (const invalid of [
		"http://manhattan.agoralab.co/crash/profile?id=0123456789ABCDEF0123456789ABCDEF",
		"https://manhattan.agoralab.co.evil.invalid/crash/profile?id=0123456789ABCDEF0123456789ABCDEF",
		"https://user@manhattan.agoralab.co/crash/profile?id=0123456789ABCDEF0123456789ABCDEF",
		"https://manhattan.agoralab.co/crash/list?id=0123456789ABCDEF0123456789ABCDEF",
		`${url}&download=1`,
		`${url}&id=0123456789ABCDEF0123456789ABCDEF`,
		`${url}#fragment`,
		"https://manhattan.agoralab.co/crash/profile?id=bad",
	]) {
		await assert.rejects(
			adapter.execute({
				action: "manhattan.get_crash_profile",
				credential: { accessToken: "personal-token" },
				input: { url: invalid },
			}),
			/crash profile URL/,
		);
	}
	await assert.rejects(
		adapter.execute({
			action: "manhattan.get_crash_thread",
			credential: { accessToken: "personal-token" },
			input: { url, index: 0, limit: 21 },
		}),
		/limit is out of range/,
	);
	assert.equal(requests.length, 2);
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
