import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	parseInput,
	verifyCustomAgentWeb,
} from "./local-real-e2e/custom-agent-web-probe.ts";

for (const scenario of [
	"recovery",
	"exhausted",
	"default",
	"tls",
	"tls-leaf",
	"unknown",
	"http",
	"content",
	"leak",
	"body-error",
]) {
	test(`entry transport evidence preserves the boundary: ${scenario}`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "entry-transport-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const allowed = "Bearer SYNTHETIC_ALLOWED_SECRET";
		const denied = "Bearer SYNTHETIC_DENIED_SECRET";
		const content = "<html>synthetic private application</html>";
		const input = {
			url: "https://entry.example.test/app",
			sourceSha: "a".repeat(40),
			imageDigest: `sha256:${"b".repeat(64)}`,
			configurationRevision: "workload-1",
			contentSha256: createHash("sha256").update(content).digest("hex"),
			allowedAuthorizationFile: join(directory, "allowed"),
			deniedAuthorizationFile: join(directory, "denied"),
		};
		await writeFile(input.allowedAuthorizationFile, allowed, { mode: 0o600 });
		await writeFile(input.deniedAuthorizationFile, denied, { mode: 0o600 });
		let calls = 0;
		t.mock.method(globalThis, "fetch", async (_url, options) => {
			calls++;
			if (
				calls === 1 &&
				[
					"recovery",
					"exhausted",
					"default",
					"tls",
					"tls-leaf",
					"unknown",
				].includes(scenario)
			) {
				const cause = Object.assign(new Error("SYNTHETIC_ERROR_SECRET"), {
					code:
						scenario === "tls"
							? "CERT_HAS_EXPIRED"
							: scenario === "tls-leaf"
								? "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
								: scenario === "unknown"
									? "SYNTHETIC_UNKNOWN_SECRET"
									: "EAI_AGAIN",
				});
				throw new TypeError("SYNTHETIC_ERROR_SECRET", { cause });
			}
			assert(options.signal instanceof AbortSignal);
			if (calls === 1 && scenario === "http")
				return new Response("", { status: 503 });
			if (calls === 1 && scenario === "body-error")
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("SYNTHETIC_ERROR_SECRET"));
						},
					}),
					{ status: 401 },
				);
			const authorized = options.headers.authorization === allowed;
			return new Response(
				authorized
					? scenario === "content"
						? "wrong"
						: content
					: scenario === "leak"
						? content
						: "",
				{
					status: authorized ? 200 : 403,
					headers: { "content-type": "text/html" },
				},
			);
		});
		const result = await verifyCustomAgentWeb(
			input,
			scenario === "default"
				? {}
				: { transportRetryTimeoutMs: scenario === "exhausted" ? 1 : 5000 },
		);
		assert.equal(result.pass, scenario === "recovery");
		assert.equal(calls, scenario === "recovery" ? 6 : 5);
		assert.equal(result.results[0].attempts, scenario === "recovery" ? 2 : 1);
		if (scenario === "recovery")
			assert.deepEqual(result.results[0].transportFailures, ["EAI_AGAIN"]);
		if (scenario.startsWith("tls"))
			assert.equal(result.results[0].error, "TLS_INVALID");
		if (scenario === "unknown")
			assert.equal(result.results[0].error, "TRANSPORT_UNCLASSIFIED");
		if (scenario === "http")
			assert.equal(result.results[0].error, "HTTP_STATUS_UNEXPECTED");
		if (scenario === "content")
			assert.equal(result.results.at(-1).error, "CONTENT_HASH_MISMATCH");
		if (scenario === "leak")
			assert.equal(result.results[0].error, "UNAUTHORIZED_BODY");
		if (scenario === "body-error")
			assert.equal(result.results[0].error, "CONTENT_READ_FAILED");
		for (const secret of [
			allowed,
			denied,
			content,
			"SYNTHETIC_ERROR_SECRET",
			"SYNTHETIC_UNKNOWN_SECRET",
			input.url,
		])
			assert.equal(JSON.stringify(result).includes(secret), false);
		for (const budget of [-1, 120001, 1.5, Number.NaN])
			await assert.rejects(
				verifyCustomAgentWeb(input, { transportRetryTimeoutMs: budget }),
				/TRANSPORT_RETRY_BUDGET_INVALID/u,
			);
	});
}

for (const budget of [5000, 2000]) {
	test(`entry retry clock respects the 2000ms boundary with a ${budget}ms budget`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "entry-retry-clock-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const allowed = "Bearer SYNTHETIC_ALLOWED_CLOCK";
		const content = "<html>synthetic clock fixture</html>";
		const input = {
			url: "https://entry.example.test/app",
			sourceSha: "a".repeat(40),
			imageDigest: `sha256:${"b".repeat(64)}`,
			configurationRevision: "clock-fixture",
			contentSha256: createHash("sha256").update(content).digest("hex"),
			allowedAuthorizationFile: join(directory, "allowed"),
			deniedAuthorizationFile: join(directory, "denied"),
		};
		await writeFile(input.allowedAuthorizationFile, allowed, { mode: 0o600 });
		await writeFile(
			input.deniedAuthorizationFile,
			"Bearer SYNTHETIC_DENIED_CLOCK",
			{ mode: 0o600 },
		);
		const start = Date.UTC(2026, 9, 29);
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: start });
		const calls = [];
		const firstRequest = Promise.withResolvers();
		t.mock.method(globalThis, "fetch", async (_url, options) => {
			calls.push(Date.now() - start);
			assert(options.signal instanceof AbortSignal);
			if (calls.length === 1) {
				firstRequest.resolve();
				throw new TypeError("synthetic transport failure", {
					cause: Object.assign(new Error("synthetic cause"), {
						code: "EAI_AGAIN",
					}),
				});
			}
			const authorized = options.headers.authorization === allowed;
			return new Response(authorized ? content : "", {
				status: authorized ? 200 : 403,
				headers: { "content-type": "text/html" },
			});
		});
		const pending = verifyCustomAgentWeb(input, {
			transportRetryTimeoutMs: budget,
		});
		await firstRequest.promise;
		// setImmediate is not mocked: settle the rejected fetch and install its retry timer.
		await new Promise(setImmediate);
		assert.deepEqual(calls, [0]);
		t.mock.timers.tick(1999);
		await new Promise(setImmediate);
		assert.deepEqual(calls, [0]);
		t.mock.timers.tick(1);
		const result = await pending;
		const retry = budget > 2000;
		assert.deepEqual(
			calls,
			retry ? [0, 2000, 2000, 2000, 2000, 2000] : [0, 2000, 2000, 2000, 2000],
		);
		assert.equal(result.pass, retry);
		assert.deepEqual(result.results[0], {
			name: "anonymous",
			status: retry ? 403 : null,
			pass: retry,
			attempts: retry ? 2 : 1,
			transportFailures: ["EAI_AGAIN"],
			...(retry ? {} : { error: "EAI_AGAIN" }),
		});
		assert.equal(result.results.length, 5);
		assert(
			result.results.slice(1).every((item) => item.pass && item.attempts === 1),
		);
	});
}

test("detects permissive and leaking HTTPS custom-Web services", async () => {
	const directory = await mkdtemp(join(tmpdir(), "custom-agent-web-probe-"));
	let server;
	try {
		const key = join(directory, "key.pem");
		const cert = join(directory, "cert.pem");
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
				"-keyout",
				key,
				"-out",
				cert,
			],
			{ stdio: "ignore" },
		);
		const allowed = `Bearer ${randomBytes(32).toString("hex")}`;
		const denied = `Bearer ${randomBytes(32).toString("hex")}`;
		const content =
			"<!doctype html><title>Private custom Agent</title><p>Authenticated</p>";
		let permissive = false;
		let leak = false;
		let contentType = "text/html";
		server = createServer(
			{ key: await readFile(key), cert: await readFile(cert) },
			(request, response) => {
				const accepted =
					permissive || request.headers.authorization === allowed;
				response.writeHead(accepted ? 200 : 403, {
					"content-type": contentType,
				});
				response.end(accepted || leak ? content : "");
			},
		);
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const input = {
			url: `https://127.0.0.1:${address.port}/private`,
			sourceSha: "a".repeat(40),
			imageDigest: `sha256:${"b".repeat(64)}`,
			configurationRevision: "controlled-local-test",
			contentSha256: createHash("sha256").update(content).digest("hex"),
			allowedAuthorizationFile: join(directory, "allowed"),
			deniedAuthorizationFile: join(directory, "denied"),
		};
		await writeFile(input.allowedAuthorizationFile, allowed, { mode: 0o600 });
		await writeFile(input.deniedAuthorizationFile, denied, { mode: 0o600 });
		const config = join(directory, "config.json");
		await writeFile(config, JSON.stringify(input));
		async function run() {
			const child = spawn(
				process.execPath,
				["tests/local-real-e2e/custom-agent-web-probe.ts", config],
				{
					env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const code = await new Promise((resolve, reject) => {
				child.on("error", reject);
				child.on("close", resolve);
			});
			for (const secret of [allowed, denied, content])
				assert.equal((stdout + stderr).includes(secret), false);
			return { code, stdout, stderr };
		}
		const success = await run();
		assert.equal(success.code, 0, success.stderr);
		assert.equal(JSON.parse(success.stdout).results.length, 5);
		const linked = join(directory, "linked");
		await symlink(input.deniedAuthorizationFile, linked);
		await writeFile(
			config,
			JSON.stringify({ ...input, deniedAuthorizationFile: linked }),
		);
		assert.equal((await run()).code, 1);
		await writeFile(config, JSON.stringify(input));
		for (const invalidType of [
			'application/json; note="text/html"',
			"text/html-invalid",
		]) {
			contentType = invalidType;
			assert.equal((await run()).code, 1);
		}
		contentType = "Text/HTML; charset=utf-8";
		assert.equal((await run()).code, 0);
		contentType = "text/html";
		permissive = true;
		const permissiveResult = await run();
		assert.equal(permissiveResult.code, 1);
		permissive = false;
		leak = true;
		const leakResult = await run();
		assert.equal(leakResult.code, 1);
		assert.throws(() =>
			parseInput({ ...input, url: input.url.replace("https:", "http:") }),
		);
		assert.throws(() =>
			parseInput({ ...input, url: `${input.url}?token=secret` }),
		);
		for (const path of ["/healthz/", "/%68ealthz", "/readyz", "/livez"])
			assert.throws(() =>
				parseInput({ ...input, url: `${input.url.replace("/private", path)}` }),
			);
	} finally {
		if (server)
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		await rm(directory, { recursive: true, force: true });
	}
});
