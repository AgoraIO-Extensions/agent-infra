import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
test("callback path rendering is literal and rejects malformed deployment paths before Nginx", async () => {
	const directory = await mkdtemp(join(tmpdir(), "callback-entrypoint-"));
	try {
		const template = join(directory, "template.conf");
		const output = join(directory, "rendered");
		const entry = join(directory, "entry.sh");
		await writeFile(
			template,
			await readFile(new URL("apps/web/nginx.conf", root)),
		);
		await writeFile(
			entry,
			(await readFile(new URL("apps/web/ack-web-entrypoint.sh", root), "utf8"))
				.replaceAll("/tmp/nginx-conf", output)
				.replaceAll("/etc/nginx/conf.d/default.conf.template", template),
		);
		const run = (path) =>
			spawnSync("sh", [entry, "true"], {
				encoding: "utf8",
				env: {
					...process.env,
					PLATFORM_PROXY_TOKEN: "synthetic",
					PLATFORM_PROXY_SCHEME: "https",
					PLATFORM_PROXY_TOKEN_REQUIRED: "true",
					PLATFORM_CONNECTION_CALLBACK_PATH: path,
				},
			});
		for (const [path, literal] of [
			["/custom/oauth-callback", "/custom/oauth-callback"],
			[
				"/callback/__PLATFORM_PROXY_SCHEME__/__PLATFORM_PROXY_TOKEN__",
				"/callback/__PLATFORM_PROXY_SCHEME__/__PLATFORM_PROXY_TOKEN__",
			],
			["/custom/oauth%2Dcallback", "/custom/oauth-callback"],
			["/callback/%22%5C%26%7C", '/callback/\\"\\\\&|'],
		]) {
			const result = run(path);
			assert.equal(result.status, 0, result.stderr);
			const config = await readFile(join(output, "default.conf"), "utf8");
			assert.ok(
				config.includes(`location = "${literal}" {`),
				"registered path stays one literal location",
			);
			assert.doesNotMatch(config, /__PLATFORM_CONNECTION_CALLBACK_PATH__/);
		}
		for (const path of [
			"relative",
			"/callback?code=x",
			"/callback#x",
			"/callback\n",
			"/callback%0a",
			"/callback%00",
			"/callback%zz",
			"/callback%a",
		]) {
			const result = run(path);
			assert.notEqual(result.status, 0);
			assert.match(
				result.stderr,
				/^invalid PLATFORM_CONNECTION_CALLBACK_PATH\n$/,
			);
			assert.ok(
				!result.stderr.includes(path),
				"invalid configuration is never echoed",
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
