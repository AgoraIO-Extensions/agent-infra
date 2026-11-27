import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const requireApi = createRequire(
	new URL("apps/platform-api/package.json", root),
);
const read = (path) => readFile(new URL(path, root), "utf8");

const context = process.env.PLATFORM_LOCAL_DOCKER_CONTEXT;
const docker = (args, options) =>
	exec("docker", ["--context", context, ...args], options);

// Real production Nginx and Node HTTP adapter, with only synthetic claim/Host ports.
for (const [authority, callbackPath] of [
	["platform.test", "/api/connection-installations/callback"],
	["platform.test:8443", "/custom/oauth-callback"],
]) {
	test(`Web callback proxy preserves ${authority}${callbackPath} and redacts only its logs`, {
		skip: !context && "PLATFORM_LOCAL_DOCKER_CONTEXT is required",
		timeout: 120_000,
	}, async () => {
		const directory = await mkdtemp(
			join(fileURLToPath(root), ".tmp-callback-proxy-"),
		);
		const name = `agent-infra-callback-${randomUUID()}`;
		const upstream = `${name}-api`;
		const network = `${name}-network`;
		const volume = `${name}-fixture`;
		const preparation = `${name}-preparation`;
		const publicOrigin = `https://${authority}`;
		const query = `?code=synthetic-callback-code-marker&iss=https%3A%2F%2Fconnection.test%2F&state=${"a".repeat(64)}`;
		try {
			await chmod(directory, 0o755);
			await build({
				entryPoints: [
					new URL("tests/fixtures/connection-callback/server.ts", root)
						.pathname,
				],
				outfile: join(directory, "server.cjs"),
				plugins: [
					{
						name: "fixture-hono",
						setup(build) {
							build.onResolve({ filter: /^hono(?:\/|$)/ }, ({ path }) => ({
								path: requireApi.resolve(path),
							}));
						},
					},
				],
				bundle: true,
				platform: "node",
				format: "cjs",
				target: "node24",
			});
			const dockerfile = await read("apps/web/Dockerfile");
			const nginx = dockerfile.match(/^FROM (nginx:[^ ]+) AS runner$/m)?.[1];
			const node = dockerfile.match(/^FROM (node:[^ ]+) AS builder$/m)?.[1];
			assert.ok(nginx && node);
			await writeFile(
				join(directory, "nginx.conf"),
				(await read("apps/web/nginx-main.conf")).replace(
					"include /tmp/nginx-conf/*.conf",
					"include /fixture/default.conf",
				),
			);
			const template = join(directory, "template.conf");
			const rendered = join(directory, "rendered");
			await writeFile(template, await read("apps/web/nginx.conf"));
			const entry = join(directory, "entry.sh");
			await writeFile(
				entry,
				(await read("apps/web/ack-web-entrypoint.sh"))
					.replaceAll("/tmp/nginx-conf", rendered)
					.replaceAll("/etc/nginx/conf.d/default.conf.template", template),
			);
			await exec("sh", [entry, "true"], {
				env: {
					...process.env,
					PLATFORM_PROXY_TOKEN: "s".repeat(43),
					PLATFORM_PROXY_TOKEN_REQUIRED: "true",
					PLATFORM_PROXY_SCHEME: "https",
					PLATFORM_CONNECTION_CALLBACK_PATH: callbackPath,
				},
			});
			await writeFile(
				join(directory, "default.conf"),
				await readFile(join(rendered, "default.conf")),
			);

			await docker(["network", "create", network]);
			await docker(["volume", "create", volume]);
			await docker([
				"create",
				"--name",
				preparation,
				"--network",
				"none",
				"--mount",
				`type=volume,src=${volume},dst=/fixture`,
				node,
				"true",
			]);
			for (const file of ["server.cjs", "nginx.conf", "default.conf"])
				await docker([
					"cp",
					join(directory, file),
					`${preparation}:/fixture/${file}`,
				]);
			await docker(["rm", preparation]);
			await docker(
				[
					"create",
					"--name",
					upstream,
					"--network",
					network,
					"--network-alias",
					"agent-infra-api",
					"--user",
					"node",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--mount",
					`type=volume,src=${volume},dst=/fixture,readonly`,
					"--env",
					`FIXTURE_PUBLIC_ORIGIN=${publicOrigin}`,
					"--env",
					`FIXTURE_CALLBACK_PATH=${callbackPath}`,
					"--entrypoint",
					"node",
					node,
					"/fixture/server.cjs",
				],
				{ timeout: 60_000 },
			);
			await docker(
				[
					"create",
					"--name",
					name,
					"--network",
					network,
					"--publish",
					"127.0.0.1::8080",
					"--user",
					"nginx",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"--tmpfs",
					"/tmp",
					"--mount",
					`type=volume,src=${volume},dst=/fixture,readonly`,
					"--entrypoint",
					"nginx",
					nginx,
					"-c",
					"/fixture/nginx.conf",
					"-g",
					"daemon off;",
				],
				{ timeout: 60_000 },
			);
			await docker(["start", upstream]);
			await docker(["start", name]);
			const { stdout } = await docker(["port", name, "8080/tcp"]);
			const origin = `http://${stdout.trim()}`;
			const get = (path, headers = {}) =>
				new Promise((resolve, reject) => {
					const req = request(origin + path, { headers }, (res) => {
						let body = "";
						res.setEncoding("utf8");
						res.on("data", (chunk) => {
							body += chunk;
						});
						res.on("end", () => resolve({ status: res.statusCode, body }));
					});
					req.on("error", reject);
					req.setTimeout(3_000, () => req.destroy(Error("SYNTHETIC_DEADLINE")));
					req.end();
				});
			let ready = false;
			for (let i = 0; i < 50; i++) {
				try {
					if ((await get("/api/fixture-health")).status === 200) {
						ready = true;
						break;
					}
				} catch {
					/* only wait for our own new containers */
				}
				await delay(100);
			}
			assert.ok(ready, "synthetic upstream and production Nginx became ready");
			assert.equal(
				(
					await get(callbackPath + query, {
						host: "foreign.test",
						"x-forwarded-host": "platform.test",
						forwarded: "host=platform.test;proto=https",
						"x-forwarded-proto": "https",
					})
				).status,
				400,
			);
			assert.deepEqual(JSON.parse((await get("/api/fixture-health")).body), {
				claims: 0,
				forwards: 0,
				delivered: 0,
				exactPayload: false,
			});
			for (const wrong of [
				"platform.test:9443",
				authority === "platform.test" ? "platform.test:8443" : "platform.test",
			]) {
				assert.equal(
					(
						await get(callbackPath + query, {
							host: wrong,
							"x-forwarded-proto": "https",
						})
					).status,
					400,
				);
			}
			const ordinary = await get("/api/fixture-proxy?ordinary-query-marker=1", {
				host: authority,
				"x-forwarded-proto": "http",
			});
			assert.deepEqual(JSON.parse(ordinary.body), {
				scheme: "http",
				authority: "platform.test",
			});
			const login = await get("/auth/oidc/login", { host: authority });
			assert.equal(login.status, 200);
			assert.deepEqual(JSON.parse(login.body), { scheme: "https", authority });
			// Nginx owns these markers; caller-supplied token/scheme cannot override them.
			assert.equal(
				(
					await get(callbackPath + query, {
						host: authority,
						"x-platform-proxy-token": "forged-client-marker",
						"x-forwarded-proto": "http",
						"x-forwarded-host": "foreign.test",
					})
				).status,
				204,
			);
			assert.equal(
				(
					await get(callbackPath + query, {
						host: authority,
					})
				).status,
				404,
			);
			assert.deepEqual(JSON.parse((await get("/api/fixture-health")).body), {
				claims: 2,
				forwards: 1,
				delivered: 1,
				exactPayload: true,
			});
			// Include an upstream failure: default Nginx error logs would also echo the query.
			assert.equal((await get("/api/fixture-close")).status, 204);
			await delay(100);
			assert.equal(
				(
					await get(callbackPath + query, {
						host: authority,
					})
				).status,
				502,
			);
			assert.equal(
				(await get("/api/fixture-proxy?ordinary-error-marker=1")).status,
				502,
			);
			const logs = await docker(["logs", name]);
			assert.ok(logs.stdout.includes(`GET ${callbackPath} HTTP/1.1" 204`));
			assert.ok(logs.stdout.includes(`GET ${callbackPath} HTTP/1.1" 502`));
			assert.ok(
				logs.stdout.includes("/api/fixture-proxy?ordinary-query-marker=1"),
			);
			assert.ok(logs.stderr.includes("ordinary-error-marker=1"));

			assert.doesNotMatch(
				logs.stdout + logs.stderr,
				/synthetic-callback-code-marker|state=|code=|binding_id=|forged-client-marker|ssssssssss/,
			);
		} finally {
			await Promise.allSettled([
				docker(["rm", "--force", name]),
				docker(["rm", "--force", upstream]),
				docker(["rm", "--force", preparation]),
			]);
			await docker(["network", "rm", network]).catch(() => {});
			await docker(["volume", "rm", volume]).catch(() => {});
			await rm(directory, { recursive: true, force: true });
		}
	});
}
