import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const frame = "event: probe\ndata: fixed-marker\n\n";

// Run the production Nginx configuration against a controlled upstream. The
// upstream deliberately omits X-Accel-Buffering so the Web guard is independent
// of the API header. It owns an isolated network and two named local containers.
test("Web Nginx delivers small SSE frames before EOF and keeps ordinary API buffering", {
	timeout: 90_000,
}, async (t) => {
	const directory = await mkdtemp(join(fileURLToPath(root), ".tmp-sse-proxy-"));
	const name = `agent-infra-sse-proxy-${randomUUID()}`;
	const network = `${name}-network`;
	const upstreamName = `${name}-upstream`;
	const upstreamScript = `
		const { createServer } = require("node:http");
		const pending = new Map();
		createServer((request, response) => {
			if (request.url === "/api/health") return response.end("ready");
			if (request.url.startsWith("/api/probe-state?")) {
				const path = new URL(request.url, "http://probe").searchParams.get("path");
				response.setHeader("Content-Type", "application/json");
				return response.end(JSON.stringify({ open: pending.has(path) && !pending.get(path).writableEnded }));
			}
			if (request.url === "/api/release") {
				pending.get("/api/buffered").end('"fixed"}');
				return response.end("released");
			}
			response.setHeader("Content-Type", request.url === "/api/buffered" ? "application/json" : "text/event-stream");
			if (request.url.endsWith("?fixed=1")) response.setHeader("Content-Length", "65536");
			response.flushHeaders();
			response.write(request.url === "/api/buffered" ? '{"marker":' : ': connected\\n\\n');
			const timer = request.url === "/api/buffered" ? null : setTimeout(() => response.write(${JSON.stringify(frame)}), 100);
			pending.set(request.url, response);
			response.on("close", () => { clearTimeout(timer); pending.delete(request.url); });
		}).listen(3000, "0.0.0.0");
	`;
	try {
		await chmod(directory, 0o755);
		const dockerfile = await read("apps/web/Dockerfile");
		const image = dockerfile.match(/^FROM (nginx:[^ ]+) AS runner$/m)?.[1];
		assert.ok(image, "use the Web Dockerfile's immutable Nginx runtime");
		const config = (await read("apps/web/nginx.conf"))
			.replaceAll("__PLATFORM_PROXY_TOKEN__", "synthetic-proxy-marker")
			.replaceAll("__PLATFORM_PROXY_SCHEME__", "http");
		await writeFile(join(directory, "default.conf"), config);
		await writeFile(
			join(directory, "nginx.conf"),
			await read("apps/web/nginx-main.conf"),
		);
		const nodeImage = dockerfile.match(/^FROM (node:[^ ]+) AS builder$/m)?.[1];
		assert.ok(nodeImage);
		await exec("docker", ["network", "create", network]);
		await exec(
			"docker",
			[
				"run",
				"--detach",
				"--rm",
				"--name",
				upstreamName,
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
				"--entrypoint",
				"node",
				nodeImage,
				"-e",
				upstreamScript,
			],
			{ timeout: 60_000 },
		);
		await exec(
			"docker",
			[
				"run",
				"--detach",
				"--rm",
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
				`type=bind,src=${directory}/nginx.conf,dst=/etc/nginx/nginx.conf,readonly`,
				"--mount",
				`type=bind,src=${directory}/default.conf,dst=/tmp/nginx-conf/default.conf,readonly`,
				"--entrypoint",
				"nginx",
				image,
				"-g",
				"daemon off;",
			],
			{ timeout: 60_000 },
		);
		const { stdout } = await exec("docker", ["port", name, "8080/tcp"]);
		const origin = `http://${stdout.trim()}`;
		let ready = false;
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const health = await fetch(`${origin}/api/health`, {
					signal: AbortSignal.timeout(500),
				});
				if ((await health.text()) === "ready") {
					ready = true;
					break;
				}
			} catch {
				/* Wait only for this newly created local proxy. */
			}
			await delay(100);
		}
		if (!ready) t.diagnostic((await exec("docker", ["logs", name])).stderr);
		assert.equal(
			ready,
			true,
			"controlled upstream and production proxy started",
		);
		for (const path of [
			"/api/v1/conversations/probe/events",
			"/api/v2/conversations/probe/events",
			"/api/v1/conversations/probe/tasks/probe/events",
		].flatMap((path) => [path, `${path}?fixed=1`])) {
			await t.test(path, async () => {
				const controller = new AbortController();
				const deadline = setTimeout(() => controller.abort(), 5_000);
				try {
					const response = await fetch(`${origin}${path}`, {
						signal: controller.signal,
					});
					assert.equal(response.status, 200);
					const reader = response.body.getReader();
					let received = "";
					while (!received.includes(frame)) {
						const next = await reader.read();
						assert.equal(next.done, false);
						received += new TextDecoder().decode(next.value);
					}
					assert.equal(received, `: connected\n\n${frame}`);
					assert.equal(response.headers.get("x-accel-buffering"), "no");
					assert.deepEqual(
						await (
							await fetch(
								`${origin}/api/probe-state?path=${encodeURIComponent(path)}`,
							)
						).json(),
						{ open: true },
					);
					await reader.cancel();
				} finally {
					clearTimeout(deadline);
					controller.abort();
				}
			});
		}
		await t.test("ordinary API responses remain buffered", async () => {
			let arrived = false;
			const response = fetch(`${origin}/api/buffered`, {
				signal: AbortSignal.timeout(5_000),
			}).then((value) => {
				arrived = true;
				return value;
			});
			await delay(300);
			assert.deepEqual(
				await (
					await fetch(`${origin}/api/probe-state?path=/api/buffered`)
				).json(),
				{ open: true },
			);
			assert.equal(arrived, false);
			await (await fetch(`${origin}/api/release`)).text();
			assert.deepEqual(await (await response).json(), { marker: "fixed" });
		});
	} finally {
		await exec("docker", ["rm", "--force", name, upstreamName]).catch(() => {});
		await exec("docker", ["network", "rm", network]).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});
