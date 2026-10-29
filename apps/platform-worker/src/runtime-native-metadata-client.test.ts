import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type PlatformNativeMetadataReadRequestV1,
	RuntimeNativeMetadataReadRequestV1Schema,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntimeNativeMetadataClientV1 } from "./runtime-native-metadata-client.js";
import { createWorkerRuntimeNativeMetadataGatewayV1 } from "./runtime-native-metadata-gateway.js";

const request = {
	schemaVersion: 1,
	readId: "http-read",
	selector: "status",
	scope: {
		schemaVersion: 1,
		principal: { kind: "user", id: "http-user" },
		agentId: "http-agent",
		channelId: "web",
		conversationId: "http-conversation",
		executionId: "http-execution",
		sessionGeneration: 2,
		authorizationRevision: "http-revision",
	},
	readStartedAt: 1_000,
	expiresAt: 20_000,
	requestId: "http-request",
	traceId: "http-trace",
	apiRequestSourceRef: "request-local-source",
} as const satisfies PlatformNativeMetadataReadRequestV1;

async function fixture(
	selector: "status" | "commands" | "skills",
	alter: (response: Record<string, unknown>) => unknown = (value) => value,
	status = 200,
) {
	const input = { ...request, selector };
	const { apiRequestSourceRef: _source, ...identity } = input;
	const binding = { ...identity, originalHostScopeRef: "http-original-host" };
	const projection =
		selector === "status"
			? { selector, status: "active", readAt: "2026-10-18T00:00:00.000Z" }
			: { selector, revision: "a".repeat(64), capabilities: [] };
	const seen: unknown[] = [];
	const server = createServer(async (incoming, outgoing) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		seen.push({
			url: incoming.url,
			authorization: incoming.headers.authorization,
			request: RuntimeNativeMetadataReadRequestV1Schema.parse(
				JSON.parse(Buffer.concat(chunks).toString("utf8")),
			),
		});
		outgoing.writeHead(status, { "content-type": "application/json" });
		outgoing.end(JSON.stringify(alter({ ...binding, projection })));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const client = createWorkerRuntimeNativeMetadataClientV1({
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		serviceToken: "http-service-token",
	});
	const current = vi.fn(async () => ({
		outcome: "allowed" as const,
		request: { ...binding, phase: "read_metadata" as const },
	}));
	const gateway = createWorkerRuntimeNativeMetadataGatewayV1({
		binding: { resolve: async () => binding },
		current: { check: current },
		proofIssuer: {
			issue: async () => ({
				schemaVersion: 1,
				format: "native-metadata-jws",
				token: "http-proof",
			}),
		},
		transport: { resolve: async () => client },
	});
	return {
		input,
		binding,
		projection,
		current,
		seen,
		client,
		gateway,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

describe("Worker native metadata gateway with its real HTTP client", () => {
	it.each(["status", "commands", "skills"] as const)(
		"accepts a strict %s response without echoing the request source ref",
		async (selector) => {
			const f = await fixture(selector);
			try {
				await expect(
					f.gateway.read(f.input, new AbortController().signal),
				).resolves.toEqual({ ...f.binding, projection: f.projection });
				expect(f.seen).toEqual([
					{
						url: "/internal/runtime/v1/native-metadata",
						authorization: "Bearer http-service-token",
						request: {
							...f.binding,
							apiRequestSourceRef: f.input.apiRequestSourceRef,
							proof: {
								schemaVersion: 1,
								format: "native-metadata-jws",
								token: "http-proof",
							},
						},
					},
				]);
				expect(f.current).toHaveBeenCalledTimes(2);
			} finally {
				await f.close();
			}
		},
	);

	it.each([
		["read id", { readId: "substituted" }],
		["scope", { scope: { ...request.scope, executionId: "substituted" } }],
		["selector", { selector: "commands" }],
		[
			"extra response field",
			{ apiRequestSourceRef: request.apiRequestSourceRef },
		],
	] as const)("rejects a substituted %s", async (_label, patch) => {
		const f = await fixture("status", (value) => ({ ...value, ...patch }));
		try {
			await expect(
				f.gateway.read(f.input, new AbortController().signal),
			).rejects.toThrow("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
			expect(f.current).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});

	it.each([403, 503])(
		"rejects HTTP %i even with a valid body",
		async (status) => {
			const f = await fixture("status", undefined, status);
			try {
				await expect(
					f.gateway.read(f.input, new AbortController().signal),
				).rejects.toThrow("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
			} finally {
				await f.close();
			}
		},
	);

	it("rejects cancellation before native I/O", async () => {
		const f = await fixture("status");
		try {
			await expect(
				f.gateway.read(f.input, AbortSignal.abort()),
			).rejects.toThrow("RUNTIME_NATIVE_METADATA_UNAVAILABLE");
			expect(f.seen).toEqual([]);
		} finally {
			await f.close();
		}
	});

	it("discards the HTTP response when the original signal aborts during I/O", async () => {
		const controller = new AbortController();
		const f = await fixture("status", (value) => {
			controller.abort();
			return value;
		});
		try {
			await expect(f.gateway.read(f.input, controller.signal)).rejects.toThrow(
				"RUNTIME_NATIVE_METADATA_UNAVAILABLE",
			);
			expect(f.seen).toHaveLength(1);
			expect(f.current).toHaveBeenCalledTimes(1);
		} finally {
			await f.close();
		}
	});

	it("retains the response-binding positive control without an optional source ref", async () => {
		const f = await fixture("status");
		try {
			await expect(
				f.client.read({
					...f.binding,
					proof: {
						schemaVersion: 1,
						format: "native-metadata-jws",
						token: "http-proof",
					},
				}),
			).resolves.toEqual({ ...f.binding, projection: f.projection });
		} finally {
			await f.close();
		}
	});
});

it.each(["text/plain", "application/json"])(
	"preserves Host media policy and base pathname for %s",
	async (media) => {
		const f = await fixture("status");
		try {
			let target = "";
			const client = createWorkerRuntimeNativeMetadataClientV1({
				baseUrl: "http://host/prefix",
				serviceToken: "token",
				fetch: async (url) => {
					target = String(url);
					return new Response(
						JSON.stringify({ ...f.binding, projection: f.projection }),
						{ headers: { "content-type": media } },
					);
				},
			});
			const result = client.read({
				...f.binding,
				proof: {
					schemaVersion: 1,
					format: "native-metadata-jws",
					token: "proof",
				},
			});
			if (media === "application/json")
				await expect(result).resolves.toEqual({
					...f.binding,
					projection: f.projection,
				});
			else
				await expect(result).rejects.toThrow(
					"RUNTIME_NATIVE_METADATA_UNAVAILABLE",
				);
			expect(target).toBe(
				"http://host/prefix/internal/runtime/v1/native-metadata",
			);
		} finally {
			await f.close();
		}
	},
);
