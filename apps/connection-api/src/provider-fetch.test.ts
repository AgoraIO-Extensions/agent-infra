import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPinnedProviderFetch } from "./provider-fetch";

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
				"subjectAltName=DNS:provider.test",
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
});
