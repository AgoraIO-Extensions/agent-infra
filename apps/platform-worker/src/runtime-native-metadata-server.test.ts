import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import {
	startPlatformWorker,
	startPlatformWorkerNativeMetadataGatewayServerV1,
} from "./index.js";

const servers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function listeningPort(
	server: ReturnType<
		typeof startPlatformWorkerNativeMetadataGatewayServerV1
	>["server"],
) {
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	return address.port;
}

describe("Platform Worker native metadata gateway server", () => {
	it("forwards HTTP requests to the deployment-owned fetch app and closes", async () => {
		const gateway = startPlatformWorkerNativeMetadataGatewayServerV1({
			port: 0,
			app: {
				async fetch(request) {
					return Response.json({ path: new URL(request.url).pathname });
				},
			},
		});
		servers.push(gateway);
		const port = await listeningPort(gateway.server);
		const response = await fetch(`http://127.0.0.1:${port}/internal/test`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ path: "/internal/test" });
		await gateway.stop();
		servers.splice(servers.indexOf(gateway), 1);
		expect(gateway.server.listening).toBe(false);
	});

	it("starts the optional server as part of the primary Worker lifecycle", async () => {
		const worker = startPlatformWorker({
			nativeMetadataGateway: {
				port: 0,
				app: { fetch: async () => new Response("ok") },
			},
		});
		const server = worker.nativeMetadataGatewayServer;
		if (!server) throw new Error("Missing gateway server");
		await listeningPort(server);
		await worker.stop();
		expect(server.listening).toBe(false);
	});

	it("rejects invalid deployment input before creating a server", () => {
		expect(() =>
			startPlatformWorkerNativeMetadataGatewayServerV1({
				port: 65_536,
				app: { fetch: async () => new Response("ok") },
			}),
		).toThrow("gateway port is invalid");
	});
});
