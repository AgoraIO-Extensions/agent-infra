import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { createPinnedProviderFetch } from "@agent-infra/openconnector-adapter/provider-fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("Provider connect-time IP pinning", () => {
	const directory = mkdtempSync(join(tmpdir(), "connection-pinning-"));
	const address = Object.values(networkInterfaces())
		.flat()
		.find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
	if (!address)
		throw new Error("Local network interface required for TLS test");
	let origin: string;
	let requests: {
		host: string | undefined;
		servername: string | undefined;
		body?: string;
	}[];
	let ca: string;
	let server: ReturnType<typeof createServer>;
	beforeAll(async () => {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				join(directory, "key.pem"),
				"-out",
				join(directory, "cert.pem"),
				"-subj",
				"/CN=provider.test",
				"-addext",
				"subjectAltName=DNS:provider.test,DNS:proxy.test",
				"-days",
				"1",
			],
			{ stdio: "ignore" },
		);
		ca = readFileSync(join(directory, "cert.pem"), "utf8");
		server = createServer(
			{ key: readFileSync(join(directory, "key.pem")), cert: ca },
			async (request, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const body = Buffer.concat(chunks).toString();
				requests.push({
					host: request.headers.host,
					servername: (request.socket as TLSSocket).servername || undefined,
					...(body ? { body } : {}),
				});
				if (request.url === "/response-lost") {
					request.socket.destroy();
					return;
				}
				if (request.url === "/http-error") {
					response.writeHead(503);
					response.end();
					return;
				}
				if (request.url === "/redirect") {
					response.writeHead(302, {
						location: "https://other-provider.test/api",
					});
					response.end();
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"ok":true}');
			},
		);
		await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
		const bound = server.address();
		if (!bound || typeof bound === "string")
			throw new Error("Missing test port");
		origin = `https://provider.test:${bound.port}`;
	});
	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(directory, { recursive: true, force: true });
	});

	it("uses exactly the validated address with original Host, SNI and CA verification", async () => {
		requests = [];
		const lookup = vi.fn(async () => [{ address, family: 4 }]);
		const transport = createPinnedProviderFetch({
			origins: [origin],
			privateOrigins: [origin],
			lookup,
			ca,
		});
		try {
			expect(
				await (
					await transport.fetch(`${origin}/api`, {
						headers: { authorization: "Bearer synthetic" },
					})
				).json(),
			).toEqual({ ok: true });
			expect(lookup).toHaveBeenCalledTimes(1);
			expect(requests).toEqual([
				{ host: new URL(origin).host, servername: "provider.test" },
			]);
		} finally {
			await transport.close();
		}
	});

	it("revalidates a new connection and rejects a rebinding answer before sending", async () => {
		requests = [];
		const lookup = vi
			.fn()
			.mockResolvedValueOnce([{ address, family: 4 }])
			.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
		const transport = createPinnedProviderFetch({
			origins: [origin],
			privateOrigins: [origin],
			lookup,
			ca,
		});
		try {
			await (
				await transport.fetch(origin, { headers: { connection: "close" } })
			).text();
			await expect(transport.fetch(origin)).rejects.toThrow();
			expect(lookup).toHaveBeenCalledTimes(2);
			expect(requests).toHaveLength(1);
		} finally {
			await transport.close();
		}
	});

	it("preserves native Request POST bodies without retrying or following redirects", async () => {
		requests = [];
		const transport = createPinnedProviderFetch({
			origins: [origin],
			privateOrigins: [origin],
			lookup: async () => [{ address, family: 4 }],
			ca,
		});
		try {
			await (
				await transport.fetch(
					new Request(origin, { method: "POST", body: "synthetic-write-body" }),
				)
			).text();
			expect(requests).toHaveLength(1);
			expect(requests[0]?.body).toBe("synthetic-write-body");
			const response = await transport.fetch(`${origin}/redirect`, {
				redirect: "follow",
			});
			expect(response.status).toBe(302);
			await response.body?.cancel();
			expect(requests).toHaveLength(2);
		} finally {
			await transport.close();
		}
	});

	it("rejects empty, failed and mixed public/private DNS answers", async () => {
		for (const lookup of [
			async () => [],
			async () => {
				throw new Error("Synthetic DNS failure");
			},
			async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "10.1.2.3", family: 4 },
			],
		]) {
			const transport = createPinnedProviderFetch({
				origins: ["https://provider.example"],
				lookup,
			});
			try {
				await expect(
					transport.fetch("https://provider.example"),
				).rejects.toThrow();
			} finally {
				await transport.close();
			}
		}
	});

	it("rejects unknown origins, routing headers and forbidden literal IPs before DNS", async () => {
		const lookup = vi.fn();
		const transport = createPinnedProviderFetch({
			origins: [origin, "http://127.0.0.1"],
			lookup,
		});
		try {
			await expect(
				transport.fetch("https://other-provider.test/api"),
			).rejects.toThrow("origin");
			await expect(
				transport.fetch(origin, { headers: { host: "other-provider.test" } }),
			).rejects.toThrow("routing headers");
			await expect(
				transport.fetch(origin, {
					headers: { "proxy-authorization": "synthetic" },
				}),
			).rejects.toThrow("routing headers");
			await expect(transport.fetch("http://127.0.0.1")).rejects.toThrow(
				"target address",
			);
			expect(lookup).not.toHaveBeenCalled();
		} finally {
			await transport.close();
		}
	});

	it("rejects an untrusted CA and a mismatched TLS hostname", async () => {
		requests = [];
		for (const wrongHostname of [false, true]) {
			const target = wrongHostname
				? origin.replace("provider.test", "wrong.test")
				: origin;
			const transport = createPinnedProviderFetch({
				origins: [target],
				privateOrigins: [target],
				lookup: async () => [{ address, family: 4 }],
				...(wrongHostname ? { ca } : {}),
			});
			try {
				await expect(transport.fetch(target)).rejects.toThrow();
			} finally {
				await transport.close();
			}
		}
		expect(requests).toHaveLength(0);
	});
	describe("proxy-first pinned CONNECT", () => {
		let proxy: ReturnType<typeof createHttpServer>;
		let proxyOrigin: string;
		let authorities: string[];
		let mode:
			| "tunnel"
			| "unavailable"
			| "forbidden"
			| "reset-tunnel"
			| "stalled";
		const sockets = new Set<Duplex>();
		beforeAll(async () => {
			proxy = createHttpServer();
			proxy.on("connect", (request, client, head) => {
				authorities.push(request.url ?? "");
				sockets.add(client);
				client.on("close", () => sockets.delete(client));
				client.on("error", () => {});
				if (mode === "stalled") return;
				if (mode !== "tunnel") {
					if (mode === "reset-tunnel") {
						client.write("HTTP/1.1 200 Connection established\r\n\r\n");
						client.destroy();
					} else
						client.end(
							`HTTP/1.1 ${mode === "unavailable" ? 503 : 403} Unavailable\r\n\r\n`,
						);
					return;
				}
				const target = new URL(`http://${request.url}`);
				const upstream = connect(
					target.port === "443"
						? Number(new URL(origin).port)
						: Number(target.port),
					target.hostname,
					() => {
						client.write("HTTP/1.1 200 Connection established\r\n\r\n");
						if (head.length) upstream.write(head);
						client.pipe(upstream).pipe(client);
					},
				);
				sockets.add(upstream);
				upstream.on("close", () => sockets.delete(upstream));
				upstream.on("error", () => client.destroy());
				client.on("close", () => upstream.destroy());
			});
			await new Promise<void>((resolve) => proxy.listen(0, "0.0.0.0", resolve));
			const bound = proxy.address();
			if (!bound || typeof bound === "string")
				throw new Error("Missing proxy port");
			proxyOrigin = `http://proxy.test:${bound.port}`;
		});
		afterAll(async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
		});
		const transportFor = (target = origin, trusted = true) => {
			requests = [];
			authorities = [];
			return createPinnedProviderFetch({
				origins: [target, proxyOrigin],
				privateOrigins: [target, proxyOrigin],
				lookup: async () => [{ address, family: 4 }],
				...(trusted ? { ca } : {}),
				proxyUrl: proxyOrigin,
			});
		};
		it("tunnels to the validated IP with original TLS/Host and submits POST once", async () => {
			mode = "tunnel";
			const transport = transportFor();
			try {
				await (
					await transport.fetch(origin, {
						method: "POST",
						body: "synthetic-code",
					})
				).text();
				expect(authorities).toEqual([`${address}:${new URL(origin).port}`]);
				expect(requests).toEqual([
					{
						host: new URL(origin).host,
						servername: "provider.test",
						body: "synthetic-code",
					},
				]);
			} finally {
				await transport.close();
			}
		});
		it("uses port 443 for default HTTPS URLs without falling back to direct", async () => {
			mode = "tunnel";
			const defaultOrigin = "https://provider.test";
			const transport = transportFor(defaultOrigin);
			try {
				await (
					await transport.fetch(defaultOrigin, {
						method: "POST",
						body: "synthetic-code",
					})
				).text();
				expect(authorities).toEqual([`${address}:443`]);
				expect(requests).toEqual([
					{
						host: "provider.test",
						servername: "provider.test",
						body: "synthetic-code",
					},
				]);
			} finally {
				await transport.close();
			}
		});
		it("falls back before submission when CONNECT returns 503, including OAuth POST", async () => {
			mode = "unavailable";
			const transport = transportFor();
			try {
				await (
					await transport.fetch(origin, {
						method: "POST",
						body: "synthetic-code",
					})
				).text();
				expect(authorities).toHaveLength(1);
				expect(requests).toHaveLength(1);
				expect(requests[0]?.body).toBe("synthetic-code");
			} finally {
				await transport.close();
			}
		});
		it("tries the proxy again on the next request after a direct fallback", async () => {
			mode = "unavailable";
			const transport = transportFor();
			try {
				await (
					await transport.fetch(origin, { method: "POST", body: "first" })
				).text();
				mode = "tunnel";
				await (
					await transport.fetch(origin, { method: "POST", body: "second" })
				).text();
				expect(authorities).toHaveLength(2);
				expect(requests.map((request) => request.body)).toEqual([
					"first",
					"second",
				]);
			} finally {
				await transport.close();
			}
		});
		it("falls back once when the proxy TCP port refuses connections", async () => {
			const closed = createHttpServer();
			await new Promise<void>((resolve) =>
				closed.listen(0, "0.0.0.0", resolve),
			);
			const bound = closed.address();
			if (!bound || typeof bound === "string")
				throw new Error("Missing closed port");
			await new Promise<void>((resolve) => closed.close(() => resolve()));
			const closedOrigin = `http://proxy.test:${bound.port}`;
			requests = [];
			const transport = createPinnedProviderFetch({
				origins: [origin, closedOrigin],
				privateOrigins: [origin, closedOrigin],
				lookup: async () => [{ address, family: 4 }],
				ca,
				proxyUrl: closedOrigin,
			});
			try {
				await (
					await transport.fetch(origin, {
						method: "PATCH",
						body: "synthetic-write",
					})
				).text();
				expect(requests).toHaveLength(1);
				expect(requests[0]?.body).toBe("synthetic-write");
			} finally {
				await transport.close();
			}
		});
		it("falls back before submission when CONNECT stalls until its deadline", async () => {
			mode = "stalled";
			const transport = transportFor();
			try {
				await (
					await transport.fetch(origin, {
						method: "POST",
						body: "synthetic-code",
					})
				).text();
				expect(authorities).toHaveLength(1);
				expect(requests).toHaveLength(1);
			} finally {
				await transport.close();
			}
		}, 15_000);
		it("uses the HTTPS proxy hostname for proxy SNI and the provider hostname inside CONNECT", async () => {
			const secureProxy = createServer({
				key: readFileSync(join(directory, "key.pem")),
				cert: ca,
			});
			const proxyServernames: string[] = [];
			const connected: string[] = [];
			secureProxy.on("secureConnection", (socket) =>
				proxyServernames.push(socket.servername || ""),
			);
			secureProxy.on("connect", (request, client) => {
				connected.push(request.url ?? "");
				sockets.add(client);
				client.on("close", () => sockets.delete(client));
				client.on("error", () => {});
				const target = new URL(`http://${request.url}`);
				const upstream = connect(Number(target.port), target.hostname, () => {
					client.write("HTTP/1.1 200 Connection established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				sockets.add(upstream);
				upstream.on("close", () => sockets.delete(upstream));
				upstream.on("error", () => client.destroy());
				client.on("close", () => upstream.destroy());
			});
			await new Promise<void>((resolve) =>
				secureProxy.listen(0, "0.0.0.0", resolve),
			);
			const bound = secureProxy.address();
			if (!bound || typeof bound === "string")
				throw new Error("Missing HTTPS proxy port");
			const secureOrigin = `https://proxy.test:${bound.port}`;
			requests = [];
			const transport = createPinnedProviderFetch({
				origins: [origin, secureOrigin],
				privateOrigins: [origin, secureOrigin],
				ca,
				lookup: async () => [{ address, family: 4 }],
				proxyUrl: secureOrigin,
			});
			try {
				await (
					await transport.fetch(origin, {
						method: "POST",
						body: "synthetic-code",
					})
				).text();
				expect(proxyServernames).toEqual(["proxy.test"]);
				expect(connected).toEqual([`${address}:${new URL(origin).port}`]);
				expect(requests).toEqual([
					{
						host: new URL(origin).host,
						servername: "provider.test",
						body: "synthetic-code",
					},
				]);
			} finally {
				await transport.close();
				await new Promise<void>((resolve) =>
					secureProxy.close(() => resolve()),
				);
			}
		});
		it("does not bypass an HTTPS proxy with an invalid certificate", async () => {
			const invalidProxy = createServer({
				key: readFileSync(join(directory, "key.pem")),
				cert: ca,
			});
			await new Promise<void>((resolve) =>
				invalidProxy.listen(0, "0.0.0.0", resolve),
			);
			const bound = invalidProxy.address();
			if (!bound || typeof bound === "string")
				throw new Error("Missing TLS proxy port");
			const invalidOrigin = `https://wrong-proxy.test:${bound.port}`;
			requests = [];
			const transport = createPinnedProviderFetch({
				origins: [origin, invalidOrigin],
				privateOrigins: [origin, invalidOrigin],
				ca,
				lookup: async () => [{ address, family: 4 }],
				proxyUrl: invalidOrigin,
			});
			try {
				await expect(transport.fetch(origin)).rejects.toThrow();
				expect(requests).toHaveLength(0);
			} finally {
				await transport.close();
				await new Promise<void>((resolve) =>
					invalidProxy.close(() => resolve()),
				);
			}
		});
		it("rejects proxy policy errors without direct fallback", async () => {
			mode = "forbidden";
			const transport = transportFor();
			try {
				await expect(transport.fetch(origin)).rejects.toThrow();
				expect(authorities).toHaveLength(1);
				expect(requests).toHaveLength(0);
			} finally {
				await transport.close();
			}
		});
		it("never retries after CONNECT succeeds but the TLS tunnel resets", async () => {
			mode = "reset-tunnel";
			const transport = transportFor();
			try {
				await expect(
					transport.fetch(origin, { method: "POST", body: "synthetic-code" }),
				).rejects.toThrow();
				expect(authorities).toHaveLength(1);
				expect(requests).toHaveLength(0);
			} finally {
				await transport.close();
			}
		});
		it("does not fallback on TLS certificate/hostname failure", async () => {
			mode = "tunnel";
			for (const target of [
				origin,
				origin.replace("provider.test", "wrong.test"),
			]) {
				const transport = transportFor(target, target !== origin);
				try {
					await expect(transport.fetch(target)).rejects.toThrow();
					expect(authorities).toHaveLength(1);
					expect(requests).toHaveLength(0);
				} finally {
					await transport.close();
				}
			}
		});
		it("does not replay a write after the provider accepts its body and drops the response", async () => {
			mode = "tunnel";
			const transport = transportFor();
			try {
				await expect(
					transport.fetch(`${origin}/response-lost`, {
						method: "POST",
						body: "synthetic-effect",
					}),
				).rejects.toThrow();
				expect(authorities).toHaveLength(1);
				expect(requests).toHaveLength(1);
			} finally {
				await transport.close();
			}
		});
		it("returns provider 503 and redirect responses without changing routes", async () => {
			mode = "tunnel";
			const transport = transportFor();
			try {
				for (const [path, status] of [
					["/http-error", 503],
					["/redirect", 302],
				] as const) {
					const response = await transport.fetch(`${origin}${path}`);
					expect(response.status).toBe(status);
					await response.text();
				}
				expect(requests).toHaveLength(2);
				expect(authorities).toHaveLength(2);
			} finally {
				await transport.close();
			}
		});
		it("rejects forbidden target and proxy DNS before CONNECT", async () => {
			mode = "tunnel";
			for (const badHost of ["provider.test", "proxy.test"]) {
				requests = [];
				authorities = [];
				const transport = createPinnedProviderFetch({
					origins: [origin, proxyOrigin],
					privateOrigins: [origin, proxyOrigin],
					ca,
					proxyUrl: proxyOrigin,
					lookup: async (hostname) => [
						{
							address: hostname === badHost ? "127.0.0.1" : address,
							family: 4,
						},
					],
				});
				try {
					await expect(transport.fetch(origin)).rejects.toThrow();
					expect(authorities).toHaveLength(0);
					expect(requests).toHaveLength(0);
				} finally {
					await transport.close();
				}
			}
		});
	});
});
