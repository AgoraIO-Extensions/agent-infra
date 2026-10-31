import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
	createHash(algorithm).update(bytes).digest(encoding);

async function install(
	t,
	{
		interrupted = 0,
		status = 200,
		badHash,
		fetchError,
		shortBudget = false,
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "opencode-installer-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const path of [
		"deploy/runtime",
		"packages/agent-runtime/src",
		"packages/agent-runtime/third-party",
		"package/bin",
		"temporary",
	])
		await mkdir(join(root, path), { recursive: true });
	const binary = Buffer.from("synthetic pinned executable");
	await writeFile(join(root, "package/bin/opencode"), binary);
	const archive = join(root, "archive.tgz");
	execFileSync("tar", ["-czf", archive, "-C", root, "package/bin/opencode"]);
	const bytes = await readFile(archive);
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		assert.equal(request.url, "/release.tgz");
		response.writeHead(status, { "Content-Length": bytes.length });
		if (requests <= interrupted) {
			response.write(bytes.subarray(0, 16));
			setTimeout(() => response.destroy(), 10);
		} else response.end(bytes);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	const metadata = {
		artifacts: {
			"linux-arm64": {
				tarball: `http://127.0.0.1:${server.address().port}/release.tgz`,
				archiveSha256: badHash === "archive" ? "0".repeat(64) : digest(bytes),
				integrity: `sha512-${badHash === "integrity" ? "invalid" : digest(bytes, "sha512", "base64")}`,
				executableSha256:
					badHash === "executable" ? "0".repeat(64) : digest(binary),
			},
		},
	};
	await writeFile(
		join(root, "packages/agent-runtime/src/opencode-release.json"),
		JSON.stringify(metadata),
	);
	await writeFile(
		join(root, "packages/agent-runtime/third-party/opencode-LICENSE"),
		"synthetic license",
	);
	const installer = join(root, "deploy/runtime/install-opencode.mjs");
	await copyFile(
		new URL("../deploy/runtime/install-opencode.mjs", import.meta.url),
		installer,
	);
	const trace = join(root, "trace.jsonl");
	const preload = join(root, "observe-fetch.mjs");
	await writeFile(
		preload,
		`import { appendFileSync } from "node:fs";
const record = (value) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value) + "\\n");
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => { record({ budgetMs: ms }); return timeout(${shortBudget} ? 100 : ms); };
const originalFetch = globalThis.fetch;
let calls = 0, firstSignal;
globalThis.fetch = async (url, options) => {
  calls++;
  firstSignal ??= options.signal;
  record({ call: calls, sameSignal: options.signal === firstSignal });
  if (${JSON.stringify(fetchError)} && calls === 1)
    throw new TypeError("sensitive transport detail", { cause: { code: ${JSON.stringify(fetchError)} } });
  return originalFetch(url, options);
};
`,
	);
	const child = spawn(
		process.execPath,
		["--import", preload, installer, "arm64", join(root, "installed"), "gnu"],
		{
			env: {
				...process.env,
				TMPDIR: join(root, "temporary"),
				TMP: join(root, "temporary"),
				TEMP: join(root, "temporary"),
			},
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10000,
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.resume();
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const records = (await readFile(trace, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.deepEqual(
		await readdir(join(root, "temporary")),
		[],
		"actual installer staging must be cleaned",
	);
	assert.doesNotMatch(stderr, /sensitive transport detail/);
	return { root, code, stderr, requests, records, binary };
}

test("restarts an interrupted HTTP body and installs only the complete pinned archive", async (t) => {
	const result = await install(t, { interrupted: 1 });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.requests, 2);
	assert.deepEqual(
		result.records.filter((r) => "budgetMs" in r),
		[{ budgetMs: 300000 }],
	);
	assert(result.records.filter((r) => "call" in r).every((r) => r.sameSignal));
	assert.deepEqual(
		await readFile(join(result.root, "installed/bin/opencode")),
		result.binary,
	);
});

test("retries a connection reset before response headers", async (t) => {
	const result = await install(t, { fetchError: "ECONNRESET" });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.records.filter((r) => "call" in r).length, 2);
});

test("stops after three interrupted responses and cleans actual staging", async (t) => {
	const result = await install(t, { interrupted: 3 });
	assert.notEqual(result.code, 0);
	assert.equal(result.requests, 3);
	assert.match(result.stderr, /OpenCode release asset download failed/);
	await assert.rejects(readFile(join(result.root, "installed/bin/opencode")), {
		code: "ENOENT",
	});
});

test("the original overall budget also aborts retry backoff", async (t) => {
	const result = await install(t, {
		fetchError: "ECONNRESET",
		shortBudget: true,
	});
	assert.notEqual(result.code, 0);
	assert.deepEqual(result.records, [
		{ budgetMs: 300000 },
		{ call: 1, sameSignal: true },
	]);
	assert.equal(result.requests, 0);
	assert.match(result.stderr, /OpenCode release asset download failed/);
});

for (const status of [401, 404])
	test(`does not retry HTTP ${status}`, async (t) => {
		const result = await install(t, { status });
		assert.notEqual(result.code, 0);
		assert.equal(result.requests, 1);
		assert.match(result.stderr, /OpenCode release asset unavailable/);
	});

test("does not retry a TLS trust failure", async (t) => {
	const result = await install(t, { fetchError: "CERT_HAS_EXPIRED" });
	assert.notEqual(result.code, 0);
	assert.equal(result.requests, 0);
	assert.equal(result.records.filter((r) => "call" in r).length, 1);
});

for (const badHash of ["archive", "integrity", "executable"])
	test(`does not retry or install a ${badHash} checksum mismatch`, async (t) => {
		const result = await install(t, { badHash });
		assert.notEqual(result.code, 0);
		assert.equal(result.requests, 1);
		assert.match(result.stderr, /checksum mismatch/);
		await assert.rejects(
			readFile(join(result.root, "installed/bin/opencode")),
			{ code: "ENOENT" },
		);
	});
