import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
	new URL("../deploy/ack/fetch-deploy-tool.sh", import.meta.url),
);
const bytes = Buffer.from("immutable release artifact");
const expected = createHash("sha256").update(bytes).digest("hex");

async function fixture(t, handler) {
	const dir = mkdtempSync(join(tmpdir(), "deploy-download-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
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
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
			"-out",
			cert,
			"-keyout",
			key,
		],
		{ stdio: "ignore" },
	);
	const ranges = [];
	const server = createServer(
		{ key: readFileSync(key), cert: readFileSync(cert) },
		(request, response) => {
			ranges.push(request.headers.range);
			response.setHeader("Connection", "close");
			handler(request, response, ranges.length);
		},
	);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `https://127.0.0.1:${server.address().port}/tool`;
	const output = join(dir, "tool");
	const run = (hash = expected) =>
		new Promise((resolve, reject) => {
			const child = spawn(
				"bash",
				[
					"-euo",
					"pipefail",
					"-c",
					'source "$1" && fetch "$2" "$3" "$4"',
					"test",
					helper,
					url,
					hash,
					output,
				],
				{
					env: {
						...process.env,
						CURL_CA_BUNDLE: cert,
						NO_PROXY: "127.0.0.1",
						no_proxy: "127.0.0.1",
					},
					stdio: ["ignore", "ignore", "pipe"],
				},
			);
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.once("close", (code) => resolve({ code, stderr }));
		});
	return { ranges, output, run };
}

function interrupted(response) {
	response.writeHead(200, { "Content-Length": bytes.length });
	response.end(bytes.subarray(0, 7));
}

test("resumes an interrupted HTTPS download at the saved offset and checks the full file", async (t) => {
	const f = await fixture(t, (_request, response, attempt) => {
		if (attempt === 1) return interrupted(response);
		response.writeHead(206, {
			"Content-Range": `bytes 7-${bytes.length - 1}/${bytes.length}`,
			"Content-Length": bytes.length - 7,
		});
		response.end(bytes.subarray(7));
	});
	const result = await f.run();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(f.ranges, [undefined, "bytes=7-"]);
	assert.deepEqual(readFileSync(f.output), bytes);
});

test("uses the remaining retry budget for a full download when a server ignores Range", async (t) => {
	const f = await fixture(t, (_request, response, attempt) => {
		if (attempt === 1) return interrupted(response);
		response.end(bytes);
	});
	const result = await f.run();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(f.ranges, [undefined, "bytes=7-", undefined]);
	assert.deepEqual(readFileSync(f.output), bytes);
});

test("does not publish a completed file with the wrong checksum", async (t) => {
	const f = await fixture(t, (_request, response) => response.end(bytes));
	const result = await f.run("0".repeat(64));
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /checksum mismatch/u);
	assert.equal(f.ranges.length, 1);
	assert.equal(existsSync(f.output), false);
});

test("four failed transport attempts end without publishing a partial file", async (t) => {
	const f = await fixture(t, (_request, response) => {
		response.writeHead(503);
		response.end();
	});
	const result = await f.run();
	assert.notEqual(result.code, 0);
	assert.equal(f.ranges.length, 4);
	assert.equal(existsSync(f.output), false);
});
