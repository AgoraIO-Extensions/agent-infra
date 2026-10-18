import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";
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
	it("aborts a completed-body request when its caller disconnects before the response", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		let nativeCalls = 0;
		const gateway = startPlatformWorkerNativeMetadataGatewayServerV1({
			port: 0,
			app: {
				async fetch(request) {
					await request.text();
					signal = request.signal;
					entered.resolve();
					await release.promise;
					if (!request.signal.aborted) nativeCalls++;
					finished.resolve();
					return new Response("done");
				},
			},
		});
		servers.push(gateway);
		const port = await listeningPort(gateway.server);
		const client = httpRequest({
			host: "127.0.0.1",
			port,
			method: "POST",
			path: "/probe",
		});
		client.on("error", () => {});
		client.end("{}");
		try {
			await entered.promise;
			client.destroy();
			await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
				timeout: 1_000,
			});
			release.resolve();
			await finished.promise;
			expect(nativeCalls).toBe(0);
		} finally {
			client.destroy();
			release.resolve();
		}
	});

	it("keeps a fully read request live while awaiting a normal response", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const gateway = startPlatformWorkerNativeMetadataGatewayServerV1({
			port: 0,
			app: {
				async fetch(request) {
					await request.text();
					signal = request.signal;
					entered.resolve();
					await release.promise;
					return new Response(request.signal.aborted ? "cancelled" : "ok");
				},
			},
		});
		servers.push(gateway);
		const port = await listeningPort(gateway.server);
		const response = fetch(`http://127.0.0.1:${port}/probe`, {
			method: "POST",
			body: "{}",
		});
		try {
			await entered.promise;
			await delay(30);
			expect(signal?.aborted).toBe(false);
			release.resolve();
			expect(await (await response).text()).toBe("ok");
		} finally {
			release.resolve();
		}
	});

	it("aborts active requests when the gateway stops", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const gateway = startPlatformWorkerNativeMetadataGatewayServerV1({
			port: 0,
			app: {
				async fetch(request) {
					await request.text();
					signal = request.signal;
					entered.resolve();
					await release.promise;
					return new Response("done");
				},
			},
		});
		servers.push(gateway);
		const port = await listeningPort(gateway.server);
		const client = httpRequest({
			host: "127.0.0.1",
			port,
			method: "POST",
			path: "/probe",
		});
		client.on("error", () => {});
		client.end("{}");
		await entered.promise;
		const stopping = gateway.stop();
		try {
			await vi.waitFor(() => expect(signal?.aborted).toBe(true), {
				timeout: 1_000,
			});
		} finally {
			client.destroy();
			release.resolve();
			await stopping;
		}
	});

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

	it("closes deployment-owned resources with the listener", async () => {
		const close = vi.fn(async () => undefined);
		const gateway = startPlatformWorkerNativeMetadataGatewayServerV1({
			port: 0,
			app: { fetch: async () => new Response("ok") },
			close,
		});
		servers.push(gateway);
		await gateway.stop();
		expect(close).toHaveBeenCalledOnce();
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

	it("shares one listener for native metadata and model-directory gateways", async () => {
		const worker = startPlatformWorker({
			nativeMetadataGateway: {
				port: 0,
				app: { fetch: async () => new Response("native") },
			},
			modelDirectoryGateway: {
				port: 0,
				app: { fetch: async () => new Response("model") },
			},
			savedKeyCandidatesGateway: {
				port: 0,
				app: { fetch: async () => new Response("saved-key") },
			},
		});
		const nativeServer = worker.nativeMetadataGatewayServer;
		const modelServer = worker.modelDirectoryGatewayServer;
		if (!nativeServer || !modelServer)
			throw new Error("Missing gateway server");
		expect(modelServer).toBe(nativeServer);
		const port = await listeningPort(nativeServer);
		const nativeResponse = await fetch(
			`http://127.0.0.1:${port}/internal/platform-worker/v1/native-metadata`,
		);
		expect(await nativeResponse.text()).toBe("native");
		const modelResponse = await fetch(
			`http://127.0.0.1:${port}/internal/worker/v1/model-directory`,
		);
		expect(await modelResponse.text()).toBe("model");
		const savedKeyResponse = await fetch(
			`http://127.0.0.1:${port}/internal/worker/v1/saved-key-candidates`,
		);
		expect(await savedKeyResponse.text()).toBe("saved-key");
		await worker.stop();
	});

	it("rejects invalid deployment input before creating a server", () => {
		expect(() =>
			startPlatformWorkerNativeMetadataGatewayServerV1({
				port: 65_536,
				app: { fetch: async () => new Response("ok") },
			}),
		).toThrow("gateway port is invalid");
		expect(() =>
			startPlatformWorker({
				nativeMetadataGateway: {
					port: 3_004,
					app: { fetch: async () => new Response("native") },
				},
				modelDirectoryGateway: {
					port: 3_005,
					app: { fetch: async () => new Response("model") },
				},
			}),
		).toThrow("PORT_MISMATCH");
	});
});
