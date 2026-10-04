import { once } from "node:events";
import { createServer, type Server } from "node:https";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	createWorkerRuntimeHostClientV1,
	createWorkerRuntimeHostClientV3,
} from "./runtime-host-client.js";
import { createRuntimeTlsTransport } from "./runtime-tls-transport.js";

const request = {
	schemaVersion: 1 as const,
	operation: "turn.stop" as const,
	requestId: "request",
	traceId: "trace",
	agentId: "agent",
	actorId: "actor",
	channelId: "web",
	conversationId: "conversation",
	executionId: "execution",
	turnId: "turn",
	stopRequestId: "stop",
	sessionGeneration: 1,
	deliveryFence: 2,
	executionDeliveryFence: 1,
	hostSessionRef: "host",
	runtimeGrant: {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token: "synthetic.payload.signature",
	},
};

const originalBinding = {
	schemaVersion: 3 as const,
	requestId: "request",
	traceId: "trace",
	principal: { kind: "user" as const, id: "actor" },
	channelId: "web",
	agentId: "agent",
	conversationId: "conversation",
	executionId: "execution",
	turnId: "turn",
	sessionGeneration: 1,
	hostSessionRef: null,
	operation: {
		kind: "execution" as const,
		id: "execution",
		deliveryFence: 2,
		executionDeliveryFence: 1,
	},
	originalOperationDigest: "a".repeat(43),
	grant: {
		schemaVersion: 2 as const,
		format: "runtime-execution-jws" as const,
		token: "synthetic.payload.signature",
	},
};

async function listen(server: Server, port = 0) {
	server.listen(port, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test port");
	return `https://localhost:${address.port}`;
}

async function close(server: Server) {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

describe("Runtime client real TLS transport", () => {
	let material: Awaited<ReturnType<typeof runtimeTlsFixture>>;
	let transport: ReturnType<typeof createRuntimeTlsTransport>;
	beforeAll(async () => {
		material = await runtimeTlsFixture();
		transport = createRuntimeTlsTransport(material.ca);
	});
	afterAll(async () => {
		await transport?.close();
		await material?.cleanup();
	});
	it.each([
		"",
		"not a certificate",
		"-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----",
	])("fails closed on missing or malformed CA material", (ca) => {
		expect(() => createRuntimeTlsTransport(ca)).toThrow(
			"RUNTIME_TLS_CA_INVALID",
		);
	});
	it("does not treat a server leaf as a CA", () => {
		expect(() => createRuntimeTlsTransport(material.cert)).toThrow(
			"RUNTIME_TLS_CA_INVALID",
		);
	});
	it("bases connection lifetime on its verified chain during overlapping CA trust", async () => {
		const previous = await runtimeTlsFixture({ caDays: 1 });
		const current = await runtimeTlsFixture({ caDays: 2, days: 2 });
		const overlap = createRuntimeTlsTransport(`${previous.ca}\n${current.ca}`);
		const server = createServer(current, (_, response) =>
			response.end("current issuer"),
		);
		try {
			const origin = await listen(server);
			// Advance only the application's lifetime calculation. OpenSSL still
			// performs a real valid handshake against the selected current chain.
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 36 * 60 * 60 * 1_000);
			const response = await overlap.fetch(origin);
			expect(await response.text()).toBe("current issuer");
		} finally {
			vi.restoreAllMocks();
			await overlap.close();
			await close(server);
			await previous.cleanup();
			await current.cleanup();
		}
	});
	it("closes an existing SSE connection when its verified leaf expires", async () => {
		const shortLived = await runtimeTlsFixture({
			expiresAt: new Date(Date.now() + 3_500),
		});
		const shortTransport = createRuntimeTlsTransport(shortLived.ca);
		let requests = 0;
		const server = createServer(shortLived, (_, response) => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(": connected\n\n");
		});
		try {
			const origin = await listen(server);
			const response = await shortTransport.fetch(origin);
			await expect(response.text()).rejects.toThrow();
			await expect(shortTransport.fetch(origin)).rejects.toThrow();
			expect(requests).toBe(1);
		} finally {
			await shortTransport.close();
			await close(server);
			await shortLived.cleanup();
		}
	}, 10_000);
	it("withdraws old CA trust and closes its existing streams on transport replacement", async () => {
		const replacement = await runtimeTlsFixture();
		const overlap = createRuntimeTlsTransport(
			`${material.ca}\n${replacement.ca}`,
		);
		const current = createRuntimeTlsTransport(replacement.ca);
		let oldRequests = 0;
		const previousServer = createServer(material, (_, response) => {
			oldRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(": connected\n\n");
		});
		const currentServer = createServer(replacement, (_, response) =>
			response.end("current issuer"),
		);
		try {
			const previousOrigin = await listen(previousServer);
			const currentOrigin = await listen(currentServer);
			const stream = await overlap.fetch(previousOrigin);
			const interrupted = expect(stream.text()).rejects.toThrow();
			expect(await (await overlap.fetch(currentOrigin)).text()).toBe(
				"current issuer",
			);
			// Model the existing deployment restart boundary: discard the old pool
			// before using a new explicitly reduced trust set. No hot reload.
			await overlap.close();
			await interrupted;
			await expect(overlap.fetch(previousOrigin)).rejects.toThrow();
			await expect(current.fetch(previousOrigin)).rejects.toThrow();
			expect(oldRequests).toBe(1);
			expect(await (await current.fetch(currentOrigin)).text()).toBe(
				"current issuer",
			);
		} finally {
			await overlap.close();
			await current.close();
			await close(previousServer);
			await close(currentServer);
			await replacement.cleanup();
		}
	});
	it("accepts a renewed same-identity leaf after Host replacement without replacing the Worker transport", async () => {
		const renewed = await runtimeTlsFixture({
			issuerDirectory: material.directory,
		});
		const previousServer = createServer(material, (_, response) =>
			response.end("previous leaf"),
		);
		const replacementServer = createServer(renewed, (_, response) =>
			response.end("renewed leaf"),
		);
		try {
			expect(renewed.ca).toBe(material.ca);
			expect(renewed.cert).not.toBe(material.cert);
			const origin = await listen(previousServer);
			expect(await (await transport.fetch(origin)).text()).toBe(
				"previous leaf",
			);
			await close(previousServer);
			await listen(replacementServer, Number(new URL(origin).port));
			expect(await (await transport.fetch(origin)).text()).toBe("renewed leaf");
		} finally {
			if (previousServer.listening) await close(previousServer);
			if (replacementServer.listening) await close(replacementServer);
			await renewed.cleanup();
		}
	});
	it("sends the existing token and Grant only through a CA- and hostname-verified connection", async () => {
		let received: { authorization?: string; body: string } | undefined;
		const server = createServer(material, async (incoming, response) => {
			let body = "";
			for await (const chunk of incoming) body += chunk;
			received = { authorization: incoming.headers.authorization, body };
			response.end(
				JSON.stringify({
					schemaVersion: 1,
					hostSessionRef: "host",
					operationId: "execution",
					result: { outcome: "accepted", status: "cancelled" },
				}),
			);
		});
		try {
			const client = createWorkerRuntimeHostClientV1({
				baseUrl: await listen(server),
				serviceToken: "synthetic-service-token",
				fetch: transport.fetch,
			});
			await expect(client.dispatch(request)).resolves.toMatchObject({
				result: { outcome: "accepted" },
			});
			expect(received?.authorization).toBe("Bearer synthetic-service-token");
			expect(JSON.parse(received?.body ?? "{}").grant).toEqual(
				request.runtimeGrant,
			);
		} finally {
			await close(server);
		}
	});
	it.each([
		["untrusted CA", {}],
		["wrong DNS", { dnsNames: ["other.internal"] }],
		["expired leaf", { days: -1 }],
		["wrong purpose", { extendedKeyUsage: "clientAuth" }],
		["CN without DNS SAN", { dnsNames: [], commonName: "localhost" }],
	] as const)("rejects %s before sending a request", async (kind, options) => {
		const invalid = await runtimeTlsFixture(options);
		let requests = 0;
		const invalidTransport = createRuntimeTlsTransport(
			kind === "untrusted CA" ? material.ca : invalid.ca,
		);
		const server = createServer(invalid, (_, response) => {
			requests++;
			response.end();
		});
		try {
			const client = createWorkerRuntimeHostClientV1({
				baseUrl: await listen(server),
				serviceToken: "synthetic-service-token",
				fetch: invalidTransport.fetch,
			});
			await expect(client.dispatch(request)).rejects.toMatchObject({
				code: "RUNTIME_UNAVAILABLE",
			});
			expect(requests).toBe(0);
		} finally {
			await close(server);
			await invalidTransport.close();
			await invalid.cleanup();
		}
	});
	it.each([301, 302, 303, 307, 308])(
		"rejects HTTP %i before the redirect target receives credentials",
		async (status) => {
			let targetRequests = 0;
			const target = createServer(material, (_, response) => {
				targetRequests++;
				response.end("unexpected");
			});
			const targetUrl = await listen(target);
			const source = createServer(material, (_, response) => {
				response.writeHead(status, { location: targetUrl });
				response.end();
			});
			try {
				const client = createWorkerRuntimeHostClientV1({
					baseUrl: await listen(source),
					serviceToken: "synthetic-service-token",
					fetch: transport.fetch,
				});
				await expect(client.dispatch(request)).rejects.toMatchObject({
					code: "RUNTIME_UNAVAILABLE",
				});
				const {
					operation: _operation,
					stopRequestId: _stop,
					executionDeliveryFence: _fence,
					...replay
				} = request;
				await expect(
					client.events(replay)[Symbol.asyncIterator]().next(),
				).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
				const v3 = createWorkerRuntimeHostClientV3({
					baseUrl: `https://localhost:${(source.address() as { port: number }).port}`,
					serviceToken: "synthetic-service-token",
					fetch: transport.fetch,
				});
				await expect(
					v3.readOriginalBinding(originalBinding),
				).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
				const { originalOperationDigest: _digest, ...events } = originalBinding;
				await expect(
					v3
						.events({
							...events,
							hostSessionRef: "host",
							consumer: "platform_worker_persistence",
							afterCursor: null,
						})
						.next(),
				).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
				expect(targetRequests).toBe(0);
			} finally {
				await close(source);
				await close(target);
			}
		},
	);
});
