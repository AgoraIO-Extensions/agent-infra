// @vitest-environment node
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let upstreamOrigin: string;
let proxyOrigin: string;
let cacheDirectory: string;
let proxy: ViteDevServer;
const cookies: (string | undefined)[] = [];
const upstream = createHttpServer((request, response) => {
	cookies.push(request.headers.cookie);
	if (request.url === "/api/json") {
		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ state: "controlled" }));
		return;
	}
	if (request.url === "/api/error") {
		response.writeHead(503, { "Content-Type": "application/json" });
		response.end(JSON.stringify({ code: "DEPENDENCY_UNAVAILABLE" }));
		return;
	}
	response.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		"X-Controlled-Upstream": "preserved",
	});
	response.flushHeaders();
	if (request.url === "/api/events") {
		response.end("id: original-cursor\ndata: controlled-event\n\n");
	}
});

beforeAll(async () => {
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	vi.stubEnv("PLATFORM_API_PROXY_TARGET", upstreamOrigin);
	cacheDirectory = await mkdtemp(join(tmpdir(), "web-vite-proxy-"));
	proxy = await createServer({
		configFile: resolve(import.meta.dirname, "../vite.config.ts"),
		cacheDir: cacheDirectory,
		server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	await proxy.listen();
	const address = proxy.httpServer?.address();
	if (!address || typeof address === "string")
		throw new Error("Vite did not bind a TCP port");
	proxyOrigin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	upstream.closeAllConnections();
	await proxy?.close();
	await new Promise<void>((resolveClose) =>
		upstream.close(() => resolveClose()),
	);
	vi.unstubAllEnvs();
	if (cacheDirectory)
		await rm(cacheDirectory, { recursive: true, force: true });
});

it("delivers idle SSE headers through the actual Vite proxy before any body", async () => {
	const direct = await fetch(`${upstreamOrigin}/api/idle`, {
		signal: AbortSignal.timeout(2_000),
	});
	expect(direct.status).toBe(200);
	await direct.body?.cancel();
	const response = await fetch(`${proxyOrigin}/api/idle`, {
		headers: { Cookie: "fixture=controlled" },
		signal: AbortSignal.timeout(2_000),
	});
	try {
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/event-stream; charset=utf-8",
		);
		expect(response.headers.get("x-controlled-upstream")).toBe("preserved");
		expect(cookies.at(-1)).toBe("fixture=controlled");
	} finally {
		await response.body?.cancel();
	}
});

it("preserves the original SSE body and cursor", async () => {
	const response = await fetch(`${proxyOrigin}/api/events`);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(
		"id: original-cursor\ndata: controlled-event\n\n",
	);
});

it.each([
	["json", 200, { state: "controlled" }],
	["error", 503, { code: "DEPENDENCY_UNAVAILABLE" }],
])("preserves non-SSE %s status and body", async (path, status, body) => {
	const response = await fetch(`${proxyOrigin}/api/${path}`);
	expect(response.status).toBe(status);
	expect(response.headers.get("content-type")).toBe("application/json");
	expect(await response.json()).toEqual(body);
});
