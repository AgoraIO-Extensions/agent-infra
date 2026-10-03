import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runProbe(tokenFile, apiPort) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["deploy/local/check-api-auth.ts", tokenFile, String(apiPort), "3001"],
			{ cwd: process.cwd() },
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stderr }));
	});
}

test("local API auth probe requires the configured token and rejects another", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-auth-probe-"));
	const token = randomBytes(32).toString("base64url");
	const tokenFile = join(directory, "proxy-token");
	let expectedToken = token;
	let wrongTokenStatus = 400;
	const observed = [];
	const server = createServer((request, response) => {
		observed.push({
			method: request.method,
			path: request.url,
			host: request.headers.host,
			forwardedProto: request.headers["x-forwarded-proto"],
			tokenMatches: request.headers["x-platform-proxy-token"] === expectedToken,
		});
		const correctRoute =
			request.method === "HEAD" &&
			request.url === "/auth/login" &&
			request.headers.host === "localhost:3001" &&
			request.headers["x-forwarded-proto"] === "https";
		response.statusCode = !correctRoute
			? 404
			: request.headers["x-platform-proxy-token"] === expectedToken
				? 405
				: wrongTokenStatus;
		response.end();
	});
	try {
		await writeFile(tokenFile, token, { mode: 0o600 });
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const valid = await runProbe(tokenFile, address.port);
		assert.equal(valid.code, 0, `${JSON.stringify(observed)}\n${valid.stderr}`);
		assert.equal(observed[0]?.method, "HEAD");

		expectedToken = randomBytes(32).toString("base64url");
		const mismatch = await runProbe(tokenFile, address.port);
		assert.notEqual(mismatch.code, 0);
		assert.doesNotMatch(mismatch.stderr, new RegExp(token));

		expectedToken = token;
		wrongTokenStatus = 405;
		const missingGuard = await runProbe(tokenFile, address.port);
		assert.notEqual(missingGuard.code, 0);
		assert.doesNotMatch(missingGuard.stderr, new RegExp(token));
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	}
});
