import { once } from "node:events";
import { createServer, get } from "node:http";
import { createServer as createTlsServer, get as getTls } from "node:https";

import { describe, expect, it } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";

import { closeRuntimeHost } from "./index.js";

async function listen(server: ReturnType<typeof createServer>) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	return `http://127.0.0.1:${address.port}`;
}

describe("RuntimeHost shutdown", () => {
	it.each([false, true])(
		"drains or bounds a verified TLS connection before releasing Runtime, deadline=%s",
		async (deadline) => {
			const material = await runtimeTlsFixture();
			const server = createTlsServer(material);
			try {
				server.listen(0, "127.0.0.1");
				await once(server, "listening");
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Missing port");
				const incoming = once(server, "request");
				const response = new Promise<string>((resolve, reject) => {
					getTls(
						`https://localhost:${address.port}`,
						{ ca: material.ca },
						(res) => {
							let body = "";
							res.on("data", (chunk) => {
								body += chunk;
							});
							res.once("end", () => resolve(body));
							res.once("error", reject);
						},
					).once("error", reject);
				});
				const outcome = deadline
					? expect(response).rejects.toThrow()
					: expect(response).resolves.toBe("persisted");
				const [, res] = await incoming;
				let runtimeClosed = false;
				const shutdown = closeRuntimeHost(
					server,
					async () => {
						runtimeClosed = true;
					},
					deadline ? 20 : 1000,
				);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(runtimeClosed).toBe(false);
				if (!deadline) res.end("persisted");
				await outcome;
				await shutdown;
				expect(runtimeClosed).toBe(true);
				expect(server.listening).toBe(false);
			} finally {
				server.closeAllConnections();
				if (server.listening)
					await new Promise<void>((resolve) => server.close(() => resolve()));
				await material.cleanup();
			}
		},
	);
	it("drains an in-flight response before closing the runtime", async () => {
		const server = createServer();
		const url = await listen(server);
		const incoming = once(server, "request");
		const response = new Promise<string>((resolve, reject) => {
			get(url, (res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve(body));
			}).on("error", reject);
		});
		const [, res] = await incoming;
		let closed = false;
		const shutdown = closeRuntimeHost(server, async () => {
			closed = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		res.end("persisted");
		expect(await response).toBe("persisted");
		await shutdown;
		expect(closed).toBe(true);
	});

	it("forces a hung request closed after the drain deadline", async () => {
		const server = createServer();
		const url = await listen(server);
		const incoming = once(server, "request");
		const request = get(url);
		const disconnected = once(request, "error");
		await incoming;
		let closed = false;
		await closeRuntimeHost(
			server,
			async () => {
				closed = true;
			},
			20,
		);
		await disconnected;
		expect(closed).toBe(true);
		expect(server.listening).toBe(false);
	});

	it("cleans up the runtime even when the server was not listening", async () => {
		let closed = false;
		await expect(
			closeRuntimeHost(createServer(), async () => {
				closed = true;
			}),
		).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
		expect(closed).toBe(true);
	});
});
