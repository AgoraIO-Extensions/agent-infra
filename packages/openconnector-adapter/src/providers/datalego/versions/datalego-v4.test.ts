import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	DataLegoV4Adapter,
	datalegoV4ConnectionCatalog,
} from "./datalego-v4.ts";
import { datalegoV4ExecutorDigest } from "./datalego-v4-integrity.ts";

const config = {
	clientId: "test-client",
	clientSecret: "test-secret",
	redirectUri: "https://connection.example/oauth/callback?provider=datalego",
};
const userInfoUrl = "https://oauth.agoralab.co/api/v2/userInfo";
const tokenUrl = "https://oauth.agoralab.co/oauth/token";
const proofUrl =
	"https://datalego.agoralab.co/api/v1/datainsight/jobs/__connection_credential_probe__/status";

test("DataLego OAuth pins its v4 source and bounded action effects", () => {
	const digest = createHash("sha256")
		.update(readFileSync(new URL("./datalego-v4.ts", import.meta.url)))
		.digest("hex");
	assert.equal(datalegoV4ExecutorDigest, `sha256:${digest}`);
	assert.deepEqual(
		datalegoV4ConnectionCatalog.actions.map(({ id, effect }) => [id, effect]),
		[
			["datalego.get_current_user@v4", "READ"],
			["datalego.submit_query@v4", "WRITE"],
			["datalego.get_query_status@v4", "READ"],
			["datalego.cancel_query@v4", "WRITE"],
		],
	);
});

test("DataLego OAuth binds the callback and stores only proven personal tokens", async () => {
	const requests: Array<{ url: string; headers: Headers; body: string }> = [];
	let exchanges = 0;
	const adapter = new DataLegoV4Adapter(async (input, init) => {
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
		const adapter = new DataLegoV4Adapter(async (input) => {
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

test("DataLego identity results omit credentials and reject incomplete SQL inputs", async () => {
	let requests = 0;
	const adapter = new DataLegoV4Adapter(async (input) => {
		requests += 1;
		return String(input) === userInfoUrl
			? Response.json({ email: "user@example.com" })
			: Response.json({ message: "record not found" }, { status: 400 });
	}, config);
	assert.deepEqual(
		await adapter.execute({
			action: "datalego.get_current_user",
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
	const adapter = new DataLegoV4Adapter(async () => {
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

test("DataLego v4 uses personal OAuth for bounded business paths and never Grafana", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const adapter = new DataLegoV4Adapter(async (url, init) => {
		requests.push({ url: String(url), init });
		if (String(url) === userInfoUrl)
			return Response.json({ email: "user@example.com" });
		if (String(url) === proofUrl)
			return Response.json({ message: "record not found" }, { status: 400 });
		assert.equal(
			new Headers(init?.headers).get("accessToken"),
			"personal-token",
		);
		return Response.json({ success: true });
	}, config);
	const credential = { accessToken: "personal-token" };
	await adapter.execute({
		action: "datalego.submit_query",
		credential,
		input: {
			sql: "SELECT 1",
			engine: "hive",
			creator: "untrusted@example.com",
		},
	});
	const submitted = requests.at(-1);
	assert.ok(submitted);
	assert.equal(
		submitted.url,
		"https://datalego.agoralab.co/api/v1/datainsight/job/trigger?creator=user%40example.com",
	);
	assert.deepEqual(JSON.parse(String(submitted.init?.body)), {
		sql: "SELECT 1",
		engine: "hive",
		queue: "share",
		panelId: 0,
		download: false,
	});
	await adapter.execute({
		action: "datalego.get_query_status",
		credential,
		input: { jobId: "a/b?c" },
	});
	assert.equal(
		requests.at(-1)?.url,
		"https://datalego.agoralab.co/api/v1/datainsight/jobs/a%2Fb%3Fc/status",
	);
	await adapter.execute({
		action: "datalego.cancel_query",
		credential,
		input: { jobId: "job-1" },
	});
	assert.equal(requests.at(-1)?.init?.method, "PUT");
	assert.equal(
		requests.some(({ url }) => url.includes("grafana")),
		false,
	);
});

test("DataLego v4 rejects authentication failures without replaying business writes", async () => {
	let writes = 0;
	const adapter = new DataLegoV4Adapter(async (url, init) => {
		if (String(url) === userInfoUrl)
			return Response.json({ email: "user@example.com" });
		if (String(url) === proofUrl)
			return Response.json({ message: "record not found" }, { status: 400 });
		assert.equal(init?.method, "POST");
		writes += 1;
		return Response.json(
			{ message: "access token has expired" },
			{ status: 401 },
		);
	}, config);
	await assert.rejects(
		adapter.execute({
			action: "datalego.submit_query",
			credential: { accessToken: "personal-token" },
			input: { sql: "SELECT 1", engine: "hive" },
		}),
		{ providerCredentialInvalid: true },
	);
	assert.equal(writes, 1);
});

test("DataLego v4 preserves bounded query results and rejects path normalization", async () => {
	let requests = 0;
	const result = { result: "x".repeat(80_000) };
	const adapter = new DataLegoV4Adapter(async () => {
		requests += 1;
		return Response.json(result);
	}, config);
	const credential = { accessToken: "personal-token" };
	assert.deepEqual(
		await adapter.execute({
			action: "datalego.get_query_status",
			credential,
			input: { jobId: "job-1" },
		}),
		result,
	);
	for (const jobId of [".", ".."])
		await assert.rejects(
			adapter.execute({
				action: "datalego.get_query_status",
				credential,
				input: { jobId },
			}),
		);
	assert.equal(requests, 1);
	await assert.rejects(
		adapter.validateCredential("personal-token"),
		/response is too large/,
	);
});
