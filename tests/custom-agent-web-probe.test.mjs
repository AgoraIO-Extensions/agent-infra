import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseInput } from "./local-real-e2e/custom-agent-web-probe.ts";

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
		server = createServer(
			{ key: await readFile(key), cert: await readFile(cert) },
			(request, response) => {
				const accepted =
					permissive || request.headers.authorization === allowed;
				response.writeHead(accepted ? 200 : 403, {
					"content-type": "text/html",
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
