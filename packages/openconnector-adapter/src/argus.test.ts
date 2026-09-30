import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	ArgusAdapter,
	ArgusOAuthAdapter,
	argusConnectionCatalog,
} from "./argus.ts";
import { argusExecutorDigest } from "./argus-integrity.ts";

test("Argus catalog pins eight read-only actions and its reviewed source", () => {
	assert.equal(argusConnectionCatalog.providerReleaseId, "argus-connection-v1");
	assert.equal(argusConnectionCatalog.actions.length, 8);
	assert.ok(
		argusConnectionCatalog.actions.every((action) => action.effect === "READ"),
	);
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./argus.ts", import.meta.url)))
		.digest("hex");
	assert.equal(argusExecutorDigest, `sha256:${digest}`);
});

test("Argus personal OAuth exchanges and refreshes without a cookie or robot account", async () => {
	const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		calls.push({
			url,
			headers: new Headers(init?.headers),
			body: init?.body?.toString(),
		});
		if (url.endsWith("/oauth/token"))
			return Response.json({
				access_token: "personal-token",
				refresh_token: "refresh-token",
				expires_in: 3600,
			});
		if (url.endsWith("/api/userInfo"))
			return Response.json({ Email: "USER@agora.io" });
		return Response.json([]);
	};
	const adapter = new ArgusAdapter(fetcher);
	const oauth = new ArgusOAuthAdapter(
		adapter,
		fetcher,
		"argus-client",
		"client-secret",
	);
	const redirectUri =
		"https://connection.example/oauth/callback?provider=argus";
	const authorization = new URL(
		oauth.getAuthorizationUrl({
			state: "state",
			codeChallenge: "challenge",
			redirectUri,
		}),
	);
	assert.equal(authorization.searchParams.get("redirect_uri"), redirectUri);
	assert.equal(authorization.searchParams.get("scope"), "email");
	const identity = await oauth.exchangeCode({
		code: "one-time-code",
		codeVerifier: "verifier",
		redirectUri,
	});
	assert.equal(identity.externalAccount, "user@agora.io");
	assert.equal(identity.refreshToken, "refresh-token");
	assert.equal(
		calls[0]?.headers.get("authorization"),
		`Basic ${Buffer.from("argus-client:client-secret").toString("base64")}`,
	);
	assert.match(calls[0]?.body ?? "", /grant_type=authorization_code/);
	assert.equal(calls[1]?.headers.get("authorization"), "Bearer personal-token");
	assert.equal(calls[2]?.headers.get("authorization"), "Bearer personal-token");
	assert.match(
		calls[2]?.url ?? "",
		/^https:\/\/argus\.agoralab\.co\/argus-service\/api\/v1\/call-sessions\?fromTs=/,
	);
	assert.equal(calls[2]?.headers.get("cookie"), null);
	await oauth.refresh("refresh-token");
	assert.match(calls[3]?.body ?? "", /grant_type=refresh_token/);
});

test("Argus reads only fixed paths with personal Bearer and bounded input", async () => {
	const calls: Array<{
		url: string;
		method?: string;
		headers: Headers;
		body?: string;
	}> = [];
	const adapter = new ArgusAdapter(async (input, init) => {
		calls.push({
			url: String(input),
			method: init?.method,
			headers: new Headers(init?.headers),
			body: init?.body?.toString(),
		});
		return Response.json([{ id: 1 }]);
	});
	const credential = { accessToken: "personal-token" };
	assert.deepEqual(
		await adapter.execute({
			action: "argus.search_calls",
			credential,
			input: { fromTs: 100, toTs: 200, size: 2, channelId: 42, accounts: "alice" },
		}),
		{ items: [{ id: 1 }] },
	);
	await adapter.execute({
		action: "argus.get_call_detail",
		credential,
		input: { callId: "a/b" },
	});
	await adapter.execute({
		action: "argus.get_counter_series",
		credential,
		input: {
			callId: "call",
			fromTs: 100,
			toTs: 200,
			sids: ["sid"],
			peerUids: [42],
			counterIds: [3],
		},
	});
	assert.equal(
		calls[0]?.url,
		"https://argus.agoralab.co/argus-service/api/v1/call-sessions?fromTs=100&toTs=200&channelId=42&accounts=alice&from=0&size=2",
	);
	assert.equal(
		calls[1]?.url,
		"https://argus.agoralab.co/argus-service/api/v1/call-sessions/a%2Fb?source=normal",
	);
	assert.equal(calls[2]?.method, "POST");
	assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), {
		sids: ["sid"],
		counterIds: [3],
		peerUids: [42, 0, 666666],
		fromTs: 100,
		toTs: 200,
	});
	assert.ok(
		calls.every(
			(call) =>
				call.headers.get("authorization") === "Bearer personal-token" &&
				!call.headers.has("cookie"),
		),
	);
	await assert.rejects(
		adapter.execute({
			action: "argus.search_calls",
			credential,
			input: { fromTs: 100, toTs: 200 + 8 * 86400 },
		}),
		/time range/,
	);
	assert.equal(calls.length, 3);
});

test("Argus rejects OAuth redirects and oversized data without following them", async () => {
	const redirect = new ArgusAdapter(
		async () =>
			new Response(null, {
				status: 302,
				headers: { location: "https://oauth.agoralab.co/oauth/authorize" },
			}),
	);
	await assert.rejects(
		redirect.validateCredential("token"),
		/identity was rejected/,
	);
	await assert.rejects(
		redirect.execute({
			action: "argus.get_counter_meta",
			credential: { accessToken: "token" },
			input: {},
		}),
		/authorization was rejected/,
	);
	const huge = new ArgusAdapter(
		async () =>
			new Response(JSON.stringify({ data: "x".repeat(256 * 1024) }), {
				headers: { "content-type": "application/json" },
			}),
	);
	await assert.rejects(
		huge.execute({
			action: "argus.search_calls",
			credential: { accessToken: "token" },
			input: { fromTs: 1, toTs: 2 },
		}),
		/too large/,
	);
});

test("Argus counter metadata returns bounded pages", async () => {
	const adapter = new ArgusAdapter(async () =>
		Response.json(Array.from({ length: 70 }, (_, id) => ({ id }))),
	);
	const first = await adapter.execute({
		action: "argus.get_counter_meta",
		credential: { accessToken: "token" },
		input: { limit: 50 },
	});
	assert.ok(Array.isArray(first.items));
	assert.equal(first.items.length, 50);
	assert.equal(first.nextOffset, 50);
	const second = await adapter.execute({
		action: "argus.get_counter_meta",
		credential: { accessToken: "token" },
		input: { offset: 50, limit: 50 },
	});
	assert.ok(Array.isArray(second.items));
	assert.equal(second.items.length, 20);
	assert.equal(second.hasMore, false);
});
