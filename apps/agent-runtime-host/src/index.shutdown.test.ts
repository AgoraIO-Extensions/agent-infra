import { once } from "node:events";
import { createServer, get } from "node:http";

import { describe, expect, it } from "vitest";

import { closeRuntimeHost } from "./index.js";

async function listen(server: ReturnType<typeof createServer>) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	return `http://127.0.0.1:${address.port}`;
}

describe("RuntimeHost shutdown", () => {
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
