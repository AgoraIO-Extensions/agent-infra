import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("detects leaking and permissive platform-auth HTTPS services", async () => {
	const directory = await mkdtemp(join(tmpdir(), "platform-auth-probe-"));
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
		const allowed = `platform-session=${randomBytes(24).toString("hex")}`;
		const denied = `platform-session=${randomBytes(24).toString("hex")}`;
		const content =
			"<!doctype html><title>Platform Auth</title><p>Authenticated</p>";
		let permissive = false;
		let leak = false;
		let contentType = "text/html";
		server = createServer(
			{ key: await readFile(key), cert: await readFile(cert) },
			(request, response) => {
				const accepted = permissive || request.headers.cookie === allowed;
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
			url: `https://127.0.0.1:${address.port}/platform-auth`,
			sourceSha: "a".repeat(40),
			imageDigest: `sha256:${"b".repeat(64)}`,
			configurationRevision: "controlled-platform-auth",
			contentSha256: createHash("sha256").update(content).digest("hex"),
			allowedRequestHeaderFile: join(directory, "allowed"),
			deniedRequestHeaderFile: join(directory, "denied"),
		};
		await writeFile(input.allowedRequestHeaderFile, allowed, { mode: 0o600 });
		await writeFile(input.deniedRequestHeaderFile, denied, { mode: 0o600 });
		const config = join(directory, "config.json");
		await writeFile(config, JSON.stringify(input));
		async function run() {
			const child = spawn(
				process.execPath,
				["tests/local-real-e2e/custom-agent-platform-auth-probe.ts", config],
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
		contentType = "text/html-invalid";
		assert.equal((await run()).code, 1);
		contentType = "text/html";
		permissive = true;
		assert.equal((await run()).code, 1);
		permissive = false;
		leak = true;
		assert.equal((await run()).code, 1);
	} finally {
		if (server)
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		await rm(directory, { recursive: true, force: true });
	}
});
