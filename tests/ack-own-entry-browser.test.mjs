import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserEntry } from "../deploy/ack/self-managed-entry.ts";
import {
	createOwnEntryServer,
	ownEntryResult,
} from "./fixtures/custom-agent-web/signed-server.ts";

test("the own-entry browser logs in, invokes the application and preserves the protected session", async (t) => {
	const require = createRequire(
		new URL("../apps/web/package.json", import.meta.url),
	);
	if (!existsSync(require("@playwright/test").chromium.executablePath())) {
		t.skip(
			"Install Playwright Chromium to run the real own-entry browser fixture",
		);
		return;
	}
	const directory = await mkdtemp(join(tmpdir(), "own-entry-browser-"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const configuration = {
		issuer: "browser-test",
		audience: "application-test",
		publicKey: publicKey.export({ type: "spki", format: "pem" }),
		role: "single",
	};
	const application = createOwnEntryServer(configuration);
	let proxy;
	try {
		const key = join(directory, "tls.key");
		const cert = join(directory, "tls.crt");
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
		await chmod(key, 0o600);
		await chmod(cert, 0o600);
		await new Promise((resolve) => application.listen(0, "127.0.0.1", resolve));
		proxy = createServer(
			{ key: await readFile(key), cert: await readFile(cert) },
			(request, response) => {
				const forward = httpRequest(
					{
						hostname: "127.0.0.1",
						port: application.address().port,
						path: request.url,
						method: request.method,
						headers: request.headers,
					},
					(upstream) => {
						response.writeHead(upstream.statusCode, upstream.headers);
						upstream.pipe(response);
					},
				);
				forward.on("error", () => {
					response.writeHead(502);
					response.end();
				});
				request.pipe(forward);
			},
		);
		await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const token = (permissions) => {
			const encode = (value) =>
				Buffer.from(JSON.stringify(value)).toString("base64url");
			const now = Math.floor(Date.now() / 1000);
			const data = `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode({ iss: configuration.issuer, aud: configuration.audience, sub: "fixture-user", iat: now, exp: now + 300, permissions })}`;
			return `Bearer ${data}.${sign(null, Buffer.from(data), privateKey).toString("base64url")}`;
		};
		const result = await browserEntry(
			`https://127.0.0.1:${proxy.address().port}`,
			token(["web:read"]),
			token([]),
			cert,
			ownEntryResult.message,
			directory,
		);
		assert.deepEqual(result, {
			loginVerified: true,
			renderedApplication: true,
			backendInteraction: true,
			reloadVerified: true,
			deniedLoginVerified: true,
			tlsLeafPinned: true,
		});
	} finally {
		await new Promise((resolve) => application.close(resolve));
		if (proxy) {
			proxy.closeAllConnections();
			await new Promise((resolve) => proxy.close(resolve));
		}
		await rm(directory, { recursive: true, force: true });
	}
});
