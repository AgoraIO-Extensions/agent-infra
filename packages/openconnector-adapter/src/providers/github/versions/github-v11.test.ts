import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPinnedProviderFetch } from "../../../provider-fetch.ts";
import {
	githubAuthorizationCompatibility,
	githubConnectionCatalog,
} from "../compatibility.ts";
import {
	OpenConnectorGitHubAdapter as PreviousAdapter,
	githubConnectionCatalog as previousCatalog,
} from "./github-v10.ts";
import {
	OpenConnectorGitHubAdapter,
	OpenConnectorGitHubOAuthAdapter,
} from "./github-v11.ts";
import { githubV11ExecutorSources } from "./github-v11-integrity.ts";

const credential = { accessToken: "TOKEN-CANARY" };
const input = { owner: "acme", repo: "widgets", jobId: 42 };
const action = "github.get_workflow_job_logs";
const signedUrl =
	"https://productionresultssa2.blob.core.windows.net/logs/job.txt?sig=SIGNATURE-CANARY";
function execute(adapter: OpenConnectorGitHubAdapter, extra = {}) {
	return adapter.execute({ action, credential, input: { ...input, ...extra } });
}
function logs(text: string) {
	return new Response(text, {
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

test("v11 reads paginated CRLF/UTF-8 logs across one credential-free download, closes transport, and excludes signatures from diagnostics", async () => {
	const { observeProviderFetch, newCallDiagnostics, withCallDiagnostics } =
		await import("../../../../../connection-core/src/call-diagnostics.ts");
	let closed = 0;
	let requests = 0;
	const adapter = new OpenConnectorGitHubAdapter(
		observeProviderFetch("github", async (url, init) => {
			requests++;
			assert.equal(
				String(url),
				"https://api.github.com/repos/acme/widgets/actions/jobs/42/logs",
			);
			assert.equal(init?.redirect, "manual");
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer TOKEN-CANARY",
			);
			return new Response(null, {
				status: 302,
				headers: { location: signedUrl },
			});
		}),
		(origin) => {
			assert.equal(
				origin,
				"https://productionresultssa2.blob.core.windows.net",
			);
			return {
				close: async () => {
					closed++;
				},
				fetch: observeProviderFetch("github", async (url, init) => {
					requests++;
					assert.equal(String(url), signedUrl);
					assert.equal(init?.redirect, "manual");
					assert.equal(init?.method, "GET");
					assert.equal(new Headers(init?.headers).get("authorization"), null);
					assert.equal(new Headers(init?.headers).get("cookie"), null);
					return logs("first\r\n第二行\r\nthird\n");
				}),
			};
		},
	);
	const diagnostics = newCallDiagnostics("EXECUTE");
	const first = await withCallDiagnostics(diagnostics, () =>
		execute(adapter, { maxLines: 2 }),
	);
	assert.deepEqual(first, {
		text: "first\n第二行",
		startLine: 1,
		endLine: 2,
		nextStartLine: 3,
		moreData: true,
		truncated: true,
		scanLimitReached: false,
		lineTruncated: false,
	});
	assert.equal((await execute(adapter, { startLine: 3 })).text, "third");
	assert.equal((await execute(adapter, { startLine: 4 })).text, "");
	assert.equal(closed, 3);
	assert.equal(requests, 6);
	assert.doesNotMatch(
		JSON.stringify({ first, diagnostics }),
		/TOKEN-CANARY|SIGNATURE-CANARY|job.txt/,
	);
});

test("empty logs and exact page boundaries do not invent a trailing line", async () => {
	for (const text of ["", "a\nb", "a\nb\n"]) {
		const result = await execute(
			new OpenConnectorGitHubAdapter(async () => logs(text)),
			{ maxLines: 2 },
		);
		assert.equal(result.moreData, false);
		assert.equal(result.nextStartLine, null);
		assert.equal(result.endLine, text ? 2 : 0);
	}
});

test("the actual pinned download transport rejects private DNS answers before sending credentials", async () => {
	const adapter = new OpenConnectorGitHubAdapter(
		async () =>
			new Response(null, { status: 302, headers: { location: signedUrl } }),
		(origin) =>
			createPinnedProviderFetch({
				origins: [origin],
				lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			}),
	);
	await assert.rejects(execute(adapter), /transport failed/);
});

test("output cap preserves complete UTF-8 characters and reports skipped long-line remainder", async () => {
	const adapter = new OpenConnectorGitHubAdapter(async () =>
		logs(`${"中".repeat(30000)}\ntail`),
	);
	const result = await execute(adapter);
	assert.equal(Buffer.byteLength(String(result.text)), 65535);
	assert.doesNotMatch(String(result.text), /\uFFFD/);
	assert.equal(result.lineTruncated, true);
	assert.equal(result.nextStartLine, 2);
	assert.equal((await execute(adapter, { startLine: 2 })).text, "tail");
	const wholeLines = await execute(
		new OpenConnectorGitHubAdapter(async () =>
			logs(`${"x".repeat(65000)}\n${"y".repeat(1000)}`),
		),
	);
	assert.equal(wholeLines.nextStartLine, 2);
	assert.equal(wholeLines.lineTruncated, false);
});

test("scan cap cancels the stream and never claims an unknown next line is readable", async () => {
	let canceled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode("prefix\n" + "x".repeat(8 * 1024 * 1024)),
			);
		},
		cancel() {
			canceled = true;
		},
	});
	const result = await execute(
		new OpenConnectorGitHubAdapter(
			async () =>
				new Response(stream, { headers: { "content-type": "text/plain" } }),
		),
		{ startLine: 2 },
	);
	assert.equal(canceled, true);
	assert.equal(result.scanLimitReached, true);
	assert.equal(result.lineTruncated, true);
	assert.equal(result.moreData, true);
	assert.equal(result.nextStartLine, null);
	assert.equal(Buffer.byteLength(String(result.text)), 65536);
});

test("injected credential is excluded while approved arbitrary build content remains", async () => {
	const result = await execute(
		new OpenConnectorGitHubAdapter(async () =>
			logs("business-secret TOKEN-CANARY"),
		),
	);
	assert.equal(result.text, "business-secret [REDACTED]");
});

for (const prefixLength of [1, 6, credential.accessToken.length - 1]) {
	test(`redacts the ${prefixLength}-character credential prefix split by the scan cap`, async () => {
		const text = `${"x".repeat(8 * 1024 * 1024 - prefixLength - 1)}\n${credential.accessToken}\ntail`;
		const result = await execute(
			new OpenConnectorGitHubAdapter(async () => logs(text)),
			{ startLine: 2 },
		);
		assert.equal(result.text, "[REDACTED]");
		assert.equal(result.scanLimitReached, true);
		assert.equal(result.lineTruncated, true);
		assert.equal(result.nextStartLine, null);
	});
}

test("redacts a complete self-overlapping credential ending exactly at the scan cap", async () => {
	const accessToken = "ABABABABAB";
	const text = `${"x".repeat(8 * 1024 * 1024 - accessToken.length - 1)}\n${accessToken}\ntail`;
	const result = await new OpenConnectorGitHubAdapter(async () =>
		logs(text),
	).execute({
		action,
		credential: { accessToken },
		input: { ...input, startLine: 2 },
	});
	assert.equal(result.text, "[REDACTED]");
	assert.equal(result.scanLimitReached, true);
	assert.equal(result.nextStartLine, null);
});

for (const target of [
	null,
	"http://productionresultssa2.blob.core.windows.net/log",
	"https://productionresultssa2.blob.core.windows.net:444/log",
	"https://productionresultssa2.blob.core.windows.net.evil.example/log",
	"https://other.blob.core.windows.net/log",
	"https://127.0.0.1/log",
	"https://productionresultssa2.blob.core.windows.net/log#fragment",
	"https://user:pass@productionresultssa2.blob.core.windows.net/log",
	"/relative",
]) {
	test(`reject download target ${target ?? "missing"} before opening a connection`, async () => {
		const adapter = new OpenConnectorGitHubAdapter(
			async () =>
				new Response(null, {
					status: 302,
					headers: target ? { location: target } : {},
				}),
			() => {
				assert.fail("Forbidden target must never reach transport");
			},
		);
		await assert.rejects(execute(adapter), /download target is not allowed/);
	});
}

for (const status of [
	202, 206, 301, 302, 307, 401, 403, 404, 410, 429, 500, 503,
]) {
	test(`download refuses HTTP ${status} without another redirect/retry or leaking response text`, async () => {
		let count = 0;
		let closed = false;
		const adapter = new OpenConnectorGitHubAdapter(
			async () =>
				new Response(null, { status: 302, headers: { location: signedUrl } }),
			() => ({
				close: async () => {
					closed = true;
				},
				fetch: async () => {
					count++;
					return new Response("TOKEN-CANARY SIGNATURE-CANARY", {
						status,
						headers: { location: signedUrl },
					});
				},
			}),
		);
		await assert.rejects(
			execute(adapter),
			(error: Error & { providerStatus?: number }) => {
				assert.equal(error.providerStatus, status);
				assert.doesNotMatch(error.message, /CANARY|https:/);
				return true;
			},
		);
		assert.equal(count, 1);
		assert.equal(closed, true);
	});
}

for (const status of [401, 403, 404, 410, 429, 500, 503]) {
	test(`API refusal ${status} preserves status and does not open a download`, async () => {
		const adapter = new OpenConnectorGitHubAdapter(
			async () => new Response("private", { status }),
			() => {
				assert.fail();
			},
		);
		await assert.rejects(
			execute(adapter),
			(error: Error & { providerStatus?: number }) =>
				error.providerStatus === status,
		);
	});
}

test("invalid identity, resource path and pagination input is rejected before network", async () => {
	const adapter = new OpenConnectorGitHubAdapter(async () => {
		assert.fail("Invalid input dispatched");
	});
	for (const extra of [
		{ owner: "../acme" },
		{ repo: ".." },
		{ jobId: -1 },
		{ jobId: 1.5 },
		{ jobId: Number.MAX_SAFE_INTEGER + 1 },
		{ startLine: 0 },
		{ startLine: 8388610 },
		{ maxLines: 1001 },
		{ maxLines: "200" },
		{ url: signedUrl },
		{ principalId: "other-user" },
		{ connectionId: "other-connection" },
		{ consumerId: "other-consumer" },
		{ headers: {} },
	])
		await assert.rejects(
			execute(adapter, extra),
			/Invalid GitHub Job log input/,
		);
});

test("transport failure, unsupported content, and a stalled body produce safe bounded failures", async (t) => {
	await assert.rejects(
		execute(
			new OpenConnectorGitHubAdapter(async () => {
				throw new Error(signedUrl);
			}),
		),
		/transport failed/,
	);
	await assert.rejects(
		execute(
			new OpenConnectorGitHubAdapter(async () =>
				Response.json({ private: credential.accessToken }),
			),
		),
		/unsupported content/,
	);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let canceled = false;
	let bodyOpened!: () => void;
	const opened = new Promise<void>((resolve) => {
		bodyOpened = resolve;
	});
	const pending = execute(
		new OpenConnectorGitHubAdapter(async () => {
			bodyOpened();
			return new Response(
				new ReadableStream({
					cancel() {
						canceled = true;
					},
				}),
				{ headers: { "content-type": "text/plain" } },
			);
		}),
	);
	await opened;
	await Promise.resolve();
	const rejection = assert.rejects(pending, /timed out/);
	t.mock.timers.tick(30000);
	await rejection;
	assert.equal(canceled, true);
});

test("existing actions, scopes and the exact v10 execution closure are retained", async () => {
	assert.equal(
		githubConnectionCatalog.actions.length,
		previousCatalog.actions.length + 1,
	);
	assert.deepEqual(
		githubConnectionCatalog.actions.slice(0, -1).map(({ id, ...rest }) => rest),
		previousCatalog.actions.map(({ id, ...rest }) => rest),
	);
	const token = new OpenConnectorGitHubOAuthAdapter({
		clientId: "client",
		clientSecret: "secret",
		publishedActions: [action],
	}).getAuthorizationUrl({
		redirectUri: "https://connection.example/callback",
		state: "state",
		codeChallenge: "challenge",
	});
	assert.deepEqual(
		new URL(token).searchParams.get("scope")?.split(" ").sort(),
		["read:user", "repo"],
	);
	const fetcher: typeof fetch = async () =>
		Response.json({ message: "Merge refused" }, { status: 409 });
	for (const adapter of [
		new OpenConnectorGitHubAdapter(fetcher),
		new PreviousAdapter(fetcher),
	])
		await assert.rejects(
			adapter.execute({
				action: "github.merge_pull_request",
				credential,
				input: { owner: "acme", repo: "widgets", pullNumber: 7 },
			}),
			(error: Error & { providerStatus?: number }) =>
				error.providerStatus === 409,
		);
	const digest = createHash("sha256");
	for (const path of githubV11ExecutorSources) {
		digest.update(path + "\0");
		digest.update(await readFile(new URL(path, import.meta.url)));
	}
	assert.equal(
		githubConnectionCatalog.executorDigest,
		`sha256:${digest.digest("hex")}`,
	);
	for (const proof of githubAuthorizationCompatibility.filter(
		(proof) => proof.toReleaseId === githubConnectionCatalog.providerReleaseId,
	))
		assert.equal(
			proof.toExecutorDigest,
			githubConnectionCatalog.executorDigest,
		);
});
