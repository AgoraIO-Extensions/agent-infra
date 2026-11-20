import { once } from "node:events";
import { createServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	connectionInstallServerExporterV1,
	requestOverConnectionInstallTlsV1,
} from "./connection-install-tls.js";

const host = "sandbox-a.agents.svc";
const label = "EXPORTER-agent-infra-connection-install-channel-v1";
const lookup: LookupFunction = (_hostname, options, callback) => {
	if (typeof options === "object" && options?.all)
		(callback as (e: null, a: { address: string; family: number }[]) => void)(
			null,
			[{ address: "127.0.0.1", family: 4 }],
		);
	else callback(null, "127.0.0.1", 4);
};

let tls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
let other: Awaited<ReturnType<typeof runtimeTlsFixture>>;
beforeAll(async () => {
	tls = await runtimeTlsFixture({ dnsNames: [host] });
	other = await runtimeTlsFixture({ dnsNames: [host] });
});
afterAll(async () => {
	await tls?.cleanup();
	await other?.cleanup();
});

async function serve(
	minVersion: "TLSv1.2" | "TLSv1.3",
	maxVersion: "TLSv1.2" | "TLSv1.3",
) {
	const seen: string[] = [];
	const server = createServer(
		{ key: tls.key, cert: tls.cert, minVersion, maxVersion },
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				try {
					const exporter = connectionInstallServerExporterV1(request.socket);
					seen.push(exporter(label, 32).toString("base64url"));
					response.writeHead(200, { "content-type": "application/json" });
					response.end(Buffer.concat(chunks));
				} catch {
					response.writeHead(503).end();
				}
			});
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		server,
		seen,
		origin: `https://${host}:${(server.address() as AddressInfo).port}/`,
	};
}

describe("connection install TLS transport", () => {
	it("binds both ends to the same TLS 1.3 exporter before writing the body", async () => {
		const { server, seen, origin } = await serve("TLSv1.3", "TLSv1.3");
		try {
			let client = "";
			const response = await requestOverConnectionInstallTlsV1({
				origin,
				path: "/internal/runtime/connection-install/v1/supply",
				ca: tls.ca,
				signal: new AbortController().signal,
				maxResponseBytes: 1024,
				lookup,
				prepare: (exporter) => {
					client = exporter(label, 32).toString("base64url");
					return { body: Buffer.from(JSON.stringify({ client })) };
				},
			});
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body.toString()).client).toBe(client);
			expect(seen).toEqual([client]);
			// A second connection never reuses the first exporter.
			let second = "";
			await requestOverConnectionInstallTlsV1({
				origin,
				path: "/internal/runtime/connection-install/v1/supply",
				ca: tls.ca,
				signal: new AbortController().signal,
				maxResponseBytes: 1024,
				lookup,
				prepare: (exporter) => {
					second = exporter(label, 32).toString("base64url");
					return { body: Buffer.from("{}") };
				},
			});
			expect(second).not.toBe(client);
		} finally {
			server.close();
		}
	});

	it("never prepares a body for an untrusted server, a plaintext origin or TLS 1.2", async () => {
		const { server, origin } = await serve("TLSv1.3", "TLSv1.3");
		const legacy = await serve("TLSv1.2", "TLSv1.2");
		try {
			for (const [target, ca] of [
				[origin, other.ca],
				[origin.replace("https:", "http:"), tls.ca],
				[legacy.origin, tls.ca],
				[`${origin}extra`, tls.ca],
			] as const) {
				let prepared = false;
				await expect(
					requestOverConnectionInstallTlsV1({
						origin: target,
						path: "/internal/runtime/connection-install/v1/supply",
						ca,
						signal: new AbortController().signal,
						maxResponseBytes: 1024,
						lookup,
						prepare: () => {
							prepared = true;
							return { body: Buffer.from("{}") };
						},
					}),
				).rejects.toThrow("CONNECTION_INSTALL_TRANSPORT_UNAVAILABLE");
				expect(prepared).toBe(false);
			}
		} finally {
			server.close();
			legacy.server.close();
		}
	});

	it("bounds the response size", async () => {
		const { server, origin } = await serve("TLSv1.3", "TLSv1.3");
		try {
			await expect(
				requestOverConnectionInstallTlsV1({
					origin,
					path: "/internal/runtime/connection-install/v1/supply",
					ca: tls.ca,
					signal: new AbortController().signal,
					maxResponseBytes: 8,
					lookup,
					prepare: () => ({
						body: Buffer.from(JSON.stringify({ x: "y".repeat(64) })),
					}),
				}),
			).rejects.toThrow("CONNECTION_INSTALL_TRANSPORT_UNAVAILABLE");
		} finally {
			server.close();
		}
	});
});
