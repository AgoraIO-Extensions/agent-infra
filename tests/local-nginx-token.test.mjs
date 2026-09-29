import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("local nginx renders a private token and overwrites the browser header", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-nginx-token-"));
	try {
		const token = randomBytes(32).toString("base64url");
		const tokenPath = join(directory, "token");
		const outputPath = join(directory, "project", "nginx.conf");
		await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
		const result = spawnSync(
			"node",
			["deploy/local/render-nginx.mjs", tokenPath, outputPath],
			{
				cwd: process.cwd(),
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const content = await readFile(outputPath, "utf8");
		assert.equal(
			await readFile(join(directory, "project", "proxy-token"), "utf8"),
			token,
		);
		assert.match(
			content,
			new RegExp(`proxy_set_header X-Platform-Proxy-Token ${token};`),
		);
		assert.doesNotMatch(
			content,
			/__PLATFORM_LOCAL_PROXY_TOKEN__|\$http_x_platform_proxy_token/,
		);
		assert.equal((await stat(join(directory, "project"))).mode & 0o077, 0);
		assert.equal((await stat(outputPath)).mode & 0o777, 0o644);
		assert.equal(
			(await stat(join(directory, "project", "proxy-token"))).mode & 0o777,
			0o644,
		);
		assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
		const linkedToken = join(directory, "linked-token");
		await symlink(tokenPath, linkedToken);
		const linked = spawnSync(
			"node",
			["deploy/local/render-nginx.mjs", linkedToken, outputPath],
			{ cwd: process.cwd(), encoding: "utf8" },
		);
		assert.notEqual(linked.status, 0);
		assert.equal(await readFile(outputPath, "utf8"), content);
		for (const invalidToken of ["short", "a".repeat(43), "a".repeat(45)]) {
			await writeFile(tokenPath, invalidToken);
			const invalid = spawnSync(
				"node",
				["deploy/local/render-nginx.mjs", tokenPath, outputPath],
				{ cwd: process.cwd(), encoding: "utf8" },
			);
			assert.notEqual(invalid.status, 0);
			assert.match(
				invalid.stderr,
				/Local proxy token must be a Base64URL value/,
			);
			assert.equal(await readFile(outputPath, "utf8"), content);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
