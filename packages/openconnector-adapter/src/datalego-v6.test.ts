import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { datalegoV5ConnectionCatalog } from "./datalego-v5.ts";
import {
	DataLegoV6Adapter,
	datalegoV6ConnectionCatalog,
} from "./datalego-v6.ts";

const config = {
	clientId: "client-fixture",
	clientSecret: "secret-fixture",
	redirectUri: "https://connection.example/oauth/callback?provider=datalego",
};
const credential = { accessToken: "token-fixture" };

function fixtureFetch(requests: { url: string; init?: RequestInit }[]) {
	return (async (url, init) => {
		requests.push({ url: String(url), init });
		if (String(url).endsWith("/oauth/token"))
			return Response.json({
				access_token: "token-fixture",
				token_type: "Bearer",
				refresh_token: "refresh-fixture",
				expires_in: 3600,
			});
		if (String(url).endsWith("/api/v2/userInfo"))
			return Response.json({ email: "alice@example.invalid" });
		if (String(url).includes("__connection_credential_probe__"))
			return Response.json({ message: "record not found" }, { status: 400 });
		return Response.json({ id: "metadata-job", status: "waiting" });
	}) satisfies typeof fetch;
}

test("v6 preserves the four original boundaries and classifies metadata job creation as WRITE", () => {
	assert.equal(
		datalegoV6ConnectionCatalog.executorDigest,
		`sha256:${createHash("sha256")
			.update(readFileSync(new URL("./datalego-v6.ts", import.meta.url)))
			.digest("hex")}`,
	);
	assert.deepEqual(
		datalegoV6ConnectionCatalog.authProfile,
		datalegoV5ConnectionCatalog.authProfile,
	);
	assert.deepEqual(
		datalegoV6ConnectionCatalog.deploymentProfile,
		datalegoV5ConnectionCatalog.deploymentProfile,
	);
	assert.deepEqual(
		datalegoV6ConnectionCatalog.actions
			.slice(0, 4)
			.map(({ id, ...action }) => action),
		datalegoV5ConnectionCatalog.actions.map(({ id, ...action }) => action),
	);
	assert.deepEqual(
		datalegoV6ConnectionCatalog.actions.slice(4).map((action) => action.effect),
		["WRITE", "WRITE"],
	);
});

test("metadata operations submit exactly one fixed Hive task using personal identity and never poll", async () => {
	for (const [action, input, sql] of [
		[
			"datalego.list_tables",
			{ database: "analytics", pattern: "event*" },
			"SHOW TABLES IN `analytics` LIKE 'event*'",
		],
		[
			"datalego.describe_table",
			{ database: "analytics", table: "events" },
			"DESCRIBE `analytics`.`events`",
		],
	] as const) {
		const requests: { url: string; init?: RequestInit }[] = [];
		const adapter = new DataLegoV6Adapter(fixtureFetch(requests), config);
		assert.deepEqual(await adapter.execute({ action, input, credential }), {
			id: "metadata-job",
			status: "waiting",
		});
		const post = requests.filter((request) => request.init?.method === "POST");
		assert.equal(post.length, 1);
		assert.equal(
			post[0]?.url,
			"https://datalego.agoralab.co/api/v1/datainsight/job/trigger?creator=alice%40example.invalid",
		);
		assert.equal(
			new Headers(post[0]?.init?.headers).get("accessToken"),
			"token-fixture",
		);
		assert.deepEqual(JSON.parse(String(post[0]?.init?.body)), {
			sql,
			engine: "hive",
			queue: "share",
			panelId: 0,
			download: false,
		});
		assert.equal(requests.length, 3);
	}
});

test("injection, unbounded discovery and unsupported parameters fail before any provider request", async () => {
	const requests: { url: string; init?: RequestInit }[] = [];
	const adapter = new DataLegoV6Adapter(fixtureFetch(requests), config);
	for (const action of ["datalego.list_tables", "datalego.describe_table"]) {
		const valid = action.endsWith("list_tables")
			? { database: "analytics", pattern: "event*" }
			: { database: "analytics", table: "events" };
		for (const input of [
			{ ...valid, database: "analytics`; DROP TABLE events; --" },
			{ ...valid, database: "a".repeat(129) },
			{ ...valid, database: "analytics.other" },
			{ ...valid, sql: "SELECT 1" },
			{ ...valid, engine: "doris" },
			{ ...valid, download: true },
			{ ...valid, url: "https://example.invalid" },
			{
				...valid,
				...(action.endsWith("list_tables")
					? { pattern: "*" }
					: { table: "events; SELECT 1" }),
			},
			{
				...valid,
				...(action.endsWith("list_tables")
					? { pattern: "event' OR '1'='1" }
					: { table: " events " }),
			},
		])
			await assert.rejects(adapter.execute({ action, input, credential }), {
				code: "INVALID_REQUEST",
			});
	}
	assert.equal(requests.length, 0);
});

test("OAuth exchange, refresh and identity preserve scopes while returning the new release", async () => {
	const adapter = new DataLegoV6Adapter(fixtureFetch([]), config);
	for (const identity of [
		await adapter.exchangeCode({
			code: "code-fixture",
			codeVerifier: "verifier-fixture",
			redirectUri: config.redirectUri,
		}),
		await adapter.refresh("refresh-fixture"),
		await adapter.validateCredential("token-fixture"),
	]) {
		assert.equal(identity.providerReleaseId, "datalego-connection-v6");
		assert.equal(identity.externalAccount, "alice@example.invalid");
		assert.deepEqual(identity.grantedScopes, ["datalego.query"]);
	}
});

test("legacy status reads remain a single GET and metadata submission failures are never replayed", async () => {
	const requests: { url: string; init?: RequestInit }[] = [];
	const adapter = new DataLegoV6Adapter(async (url, init) => {
		if (init?.method === "POST") {
			requests.push({ url: String(url), init });
			return new Response("unavailable", { status: 503 });
		}
		return fixtureFetch(requests)(url, init);
	}, config);
	await adapter.execute({
		action: "datalego.get_query_status",
		input: { jobId: "existing-job" },
		credential,
	});
	assert.equal(requests.length, 1);
	assert.equal(
		requests[0]?.url,
		"https://datalego.agoralab.co/api/v1/datainsight/jobs/existing-job/status",
	);
	requests.length = 0;
	await assert.rejects(
		adapter.execute({
			action: "datalego.list_tables",
			input: { database: "analytics", pattern: "event*" },
			credential,
		}),
		{ providerStatus: 503, submissionUncertain: true },
	);
	assert.equal(
		requests.filter((request) => request.init?.method === "POST").length,
		1,
	);
});
