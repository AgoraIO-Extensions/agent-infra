import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	DataLegoOAuthAdapter,
	datalegoOAuthConnectionCatalog,
} from "./datalego-oauth.ts";
import { datalegoOAuthExecutorDigest } from "./datalego-oauth-integrity.ts";

const config = {
	clientId: "test-client",
	clientSecret: "test-secret",
	redirectUri: "https://connection.example/oauth/callback?provider=datalego",
};
const userInfoUrl = "https://oauth.agoralab.co/api/v2/userInfo";
const tokenUrl = "https://oauth.agoralab.co/oauth/token";
const proofUrl =
	"https://datalego.agoralab.co/api/v1/datainsight/jobs/__connection_credential_probe__/status";

test("DataLego OAuth pilot pins its source and exposes only identity READ", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./datalego-oauth.ts", import.meta.url)))
		.digest("hex");
	assert.equal(datalegoOAuthExecutorDigest, `sha256:${digest}`);
	assert.deepEqual(
		datalegoOAuthConnectionCatalog.actions.map(({ id, effect }) => [
			id,
			effect,
		]),
		[["datalego-oauth-pilot.get_current_user@v1", "READ"]],
	);
});

test("DataLego OAuth binds the callback and stores only proven personal tokens", async () => {
	const requests: Array<{ url: string; headers: Headers; body: string }> = [];
	let exchanges = 0;
	const adapter = new DataLegoOAuthAdapter(async (input, init) => {
		requests.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: String(init?.body ?? ""),
		});
		if (String(input) === tokenUrl) {
			exchanges += 1;
			return Response.json({
				access_token: `personal-${exchanges}`,
				token_type: "Bearer",
				expires_in: 3600,
				...(exchanges === 1 ? { refresh_token: "refresh-token" } : {}),
			});
		}
		if (String(input) === userInfoUrl)
			return Response.json({ email: "User@Example.com", id: 42 });
		assert.equal(String(input), proofUrl);
		return Response.json({ message: "record not found" }, { status: 400 });
	}, config);
	const url = new URL(
		adapter.getAuthorizationUrl({
			codeChallenge: "unused-confidential-client-pkce",
			redirectUri: config.redirectUri,
			state: "one-time-state",
		}),
	);
	assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
	assert.equal(url.searchParams.get("state"), "one-time-state");
	assert.equal(url.searchParams.has("client_secret"), false);
	assert.throws(() =>
		adapter.getAuthorizationUrl({
			codeChallenge: "challenge",
			redirectUri: "https://untrusted.example/callback",
			state: "state",
		}),
	);
	const identity = await adapter.exchangeCode({
		code: "one-time-code",
		codeVerifier: "verifier",
		redirectUri: config.redirectUri,
	});
	assert.equal(identity.externalAccount, "user@example.com");
	assert.equal(identity.accessToken, "personal-1");
	assert.equal(identity.refreshToken, "refresh-token");
	assert.ok(identity.expiresAt);
	const refreshed = await adapter.refresh("refresh-token");
	assert.equal(refreshed.accessToken, "personal-2");
	assert.equal(refreshed.refreshToken, "refresh-token");
	assert.deepEqual(
		requests.map(({ url }) => url),
		[tokenUrl, userInfoUrl, proofUrl, tokenUrl, userInfoUrl, proofUrl],
	);
	assert.equal(
		requests[0]?.headers.get("authorization"),
		`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`,
	);
	assert.equal(requests[1]?.headers.get("authorization"), "Bearer personal-1");
	assert.equal(requests[2]?.headers.get("accessToken"), "personal-1");
	assert.equal(requests[2]?.headers.has("cookie"), false);
	assert.equal(
		new URLSearchParams(requests[0]?.body).get("grant_type"),
		"authorization_code",
	);
	assert.equal(
		new URLSearchParams(requests[3]?.body).get("grant_type"),
		"refresh_token",
	);
	assert.equal(
		requests.some(({ body }) => body.includes("test-secret")),
		false,
	);
});

test("DataLego rejects unproven tokens without returning upstream content", async () => {
	for (const response of [
		Response.json({ message: "secret-upstream-content" }, { status: 401 }),
		new Response(null, {
			status: 302,
			headers: { location: "https://oauth.agoralab.co/" },
		}),
		Response.json({ message: "unexpected" }, { status: 400 }),
		Response.json(
			{ message: "authorization failed", detail: "expected record not found" },
			{ status: 400 },
		),
		Response.json({ message: "not record not found" }, { status: 400 }),
		Response.json({ detail: "record not found" }, { status: 400 }),
		new Response("record not found", { status: 400 }),
	]) {
		const adapter = new DataLegoOAuthAdapter(async (input) => {
			if (String(input) === userInfoUrl)
				return Response.json({ email: "user@example.com" });
			return response;
		}, config);
		await assert.rejects(
			adapter.validateCredential("private-token"),
			(error: Error) => {
				assert.equal(error.message.includes("private-token"), false);
				assert.equal(error.message.includes("secret-upstream-content"), false);
				return true;
			},
		);
	}
});

test("DataLego pilot results omit credentials and reject SQL actions", async () => {
	let requests = 0;
	const adapter = new DataLegoOAuthAdapter(async (input) => {
		requests += 1;
		return String(input) === userInfoUrl
			? Response.json({ email: "user@example.com" })
			: Response.json({ message: "record not found" }, { status: 400 });
	}, config);
	assert.deepEqual(
		await adapter.execute({
			action: "datalego-oauth-pilot.get_current_user",
			credential: { accessToken: "private-token" },
			input: {},
		}),
		{ email: "user@example.com" },
	);
	await assert.rejects(
		adapter.execute({
			action: "datalego.submit_query",
			credential: { accessToken: "private-token" },
			input: { sql: "SELECT 1" },
		}),
	);
	assert.equal(requests, 2);
});

test("DataLego requires refresh material and maps invalid_grant without replay", async () => {
	let requests = 0;
	const adapter = new DataLegoOAuthAdapter(async () => {
		requests += 1;
		return requests === 1
			? Response.json({
					access_token: "token",
					token_type: "Bearer",
					expires_in: 3600,
				})
			: Response.json(
					{ error: "invalid_grant", detail: "private-token" },
					{ status: 400 },
				);
	}, config);
	await assert.rejects(
		adapter.exchangeCode({
			code: "code",
			codeVerifier: "verifier",
			redirectUri: config.redirectUri,
		}),
		/refresh token is missing/,
	);
	await assert.rejects(
		adapter.refresh("refresh-token"),
		/^Error: invalid_grant$/,
	);
	assert.equal(requests, 2);
});
