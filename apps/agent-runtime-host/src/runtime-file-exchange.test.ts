import {
	type RuntimeFileExchangeEvidenceV1,
	RuntimeFileResultUnconfirmedError,
} from "@agent-infra/agent-runtime";
import { expect, it, vi } from "vitest";
import { readRuntimeFileExchangeOptions } from "./configuration.js";
import {
	createRuntimeFileBridgeFactoryV1,
	isRuntimeFileExchangeOriginV1,
} from "./runtime-file-exchange.js";

const binding = {
	actorId: "actor-1",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 1,
	grantId: "grant-1",
	expiresAt: Date.now() + 60_000,
	inputFileIds: ["input-1"],
} as const;

const grant = {
	schemaVersion: 1 as const,
	format: "compact-jws" as const,
	token: "a.b.c",
};

const evidence: RuntimeFileExchangeEvidenceV1 = {
	executionGrant: {
		schemaVersion: 4,
		format: "runtime-execution-jws",
		token: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhY3Rvci0xIn0.c2lnbmF0dXJl",
	},
};

function response(
	file: Record<string, unknown>,
	path = "/api/v1/conversations/conversation-1/files/file-1/content",
	expiresAt = "2099-01-01T00:00:00Z",
) {
	return new Response(
		JSON.stringify({
			schemaVersion: 1,
			accessId: "access-1",
			file,
			path,
			expiresAt,
			grant,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

it("exchanges V4 binding for a bounded input stream without exposing the grant", async () => {
	const fetcher = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("runtime-exchange"))
				return response({
					schemaVersion: 1,
					fileId: "input-1",
					kind: "attachment",
					descriptor: {
						name: "input.png",
						mediaType: "image/png",
						sizeBytes: 3,
						sha256: "a".repeat(64),
					},
					status: "available",
					createdAt: "2026-01-01T00:00:00Z",
					expiresAt: "2099-01-01T00:00:00Z",
				});
			if (url.endsWith("/content"))
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "image/png", "content-length": "3" },
				});
			throw new Error(
				`unexpected request ${url} ${JSON.stringify(init?.headers)}`,
			);
		},
	);
	const factory = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	});
	const input = await factory(binding, evidence).readInput("input-1");
	expect(new Uint8Array(await new Response(input.body).arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	const exchange = fetcher.mock.calls[0]?.[1];
	expect(JSON.stringify(exchange)).not.toContain("a.b.c");
	const body = JSON.parse(String(exchange?.body));
	expect(body).toEqual({
		schemaVersion: 2,
		executionGrant: evidence.executionGrant,
		operation: "read",
		fileId: "input-1",
		idempotencyKey: expect.any(String),
	});
	// No V1 self-reported authority travels on the wire.
	for (const field of [
		"actorId",
		"agentId",
		"channelId",
		"conversationId",
		"executionId",
		"sessionGeneration",
		"grantId",
		"expiresAt",
	])
		expect(body).not.toHaveProperty(field);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects a file outside the execution binding before network access", async () => {
	const fetcher = vi.fn();
	const factory = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	});
	await expect(
		factory(binding, evidence).readInput("other-file"),
	).rejects.toThrow("RUNTIME_FILE_INPUT_NOT_AUTHORIZED");
	expect(fetcher).not.toHaveBeenCalled();
});

it("keeps result idempotency stable when descriptor property order changes", async () => {
	const descriptor = {
		name: "result.txt",
		mediaType: "text/plain",
		sizeBytes: 3,
		sha256: "a".repeat(64),
	};
	const reordered = {
		sha256: descriptor.sha256,
		sizeBytes: descriptor.sizeBytes,
		mediaType: descriptor.mediaType,
		name: descriptor.name,
	};
	const resultFile = {
		schemaVersion: 1,
		fileId: "result-1",
		kind: "result",
		descriptor,
		status: "available",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
	};
	const fetcher = vi.fn(
		async (input: string | URL | Request, _init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("runtime-exchange"))
				return response(
					resultFile,
					"/api/v1/conversations/conversation-1/files/result-1/content",
				);
			if (url.endsWith("/complete"))
				return new Response(JSON.stringify(resultFile), { status: 200 });
			throw new Error(`unexpected request ${url}`);
		},
	);
	const bridge = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	})(binding, evidence);
	await bridge.writeResult(descriptor, new ReadableStream<Uint8Array>());
	await bridge.writeResult(reordered, new ReadableStream<Uint8Array>());
	const keys = fetcher.mock.calls
		.filter(([input]) => String(input).endsWith("runtime-exchange"))
		.map(([, init]) => {
			if (!init) throw new Error("missing exchange request init");
			return (init.headers as Record<string, string>)["Idempotency-Key"];
		});
	expect(keys).toHaveLength(2);
	expect(keys[0]).toBe(keys[1]);
});

it("rejects an expired access response before content transfer", async () => {
	const fetcher = vi.fn(async (input: string | URL | Request) => {
		if (String(input).endsWith("runtime-exchange"))
			return response(
				{
					schemaVersion: 1,
					fileId: "input-1",
					kind: "attachment",
					descriptor: {
						name: "input.png",
						mediaType: "image/png",
						sizeBytes: 1,
						sha256: "a".repeat(64),
					},
					status: "available",
					createdAt: "2026-01-01T00:00:00Z",
					expiresAt: "2026-01-01T00:00:00Z",
				},
				undefined,
				"2026-01-01T00:00:00Z",
			);
		throw new Error("content transfer must not start");
	});
	const bridge = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	})(binding, evidence);
	await expect(bridge.readInput("input-1")).rejects.toThrow(
		"RUNTIME_FILE_EXCHANGE_EXPIRED",
	);
	expect(fetcher).toHaveBeenCalledOnce();
});

it("bounds result upload streams before completing the file", async () => {
	const descriptor = {
		name: "result.txt",
		mediaType: "text/plain",
		sizeBytes: 2,
		sha256: "a".repeat(64),
	};
	const pending = {
		schemaVersion: 1,
		fileId: "result-1",
		kind: "result",
		descriptor,
		status: "pending",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2099-01-01T00:00:00Z",
	};
	const fetcher = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("runtime-exchange"))
				return response(
					pending,
					"/api/v1/conversations/conversation-1/files/result-1/content",
				);
			if (url.endsWith("/content")) {
				await new Response(init?.body).arrayBuffer();
				return new Response(null, { status: 204 });
			}
			throw new Error("completion must not start");
		},
	);
	const bridge = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	})(binding, evidence);
	await expect(
		bridge.writeResult(
			descriptor,
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]));
					controller.close();
				},
			}),
		),
	).rejects.toThrow("RUNTIME_FILE_RESULT_SIZE_MISMATCH");
	expect(fetcher).toHaveBeenCalledTimes(2);
});

const referencedDescriptor = {
	name: "chart.png",
	mediaType: "image/png",
	sizeBytes: 2,
	sha256: "b".repeat(64),
};

const referencedFile = {
	schemaVersion: 1,
	fileId: "result-2",
	kind: "result",
	descriptor: referencedDescriptor,
	status: "available",
	createdAt: "2026-01-01T00:00:00Z",
	expiresAt: "2099-01-01T00:00:00Z",
};

function twoBytes() {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2]));
			controller.close();
		},
	});
}

function resultFetcher(complete: () => Promise<Response>) {
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("runtime-exchange"))
			return response(
				{ ...referencedFile, status: "pending" },
				"/api/v1/conversations/conversation-1/files/result-2/content",
			);
		if (url.endsWith("/content")) {
			await new Response(init?.body).arrayBuffer();
			return new Response(null, { status: 204 });
		}
		if (url.endsWith("/complete")) return complete();
		throw new Error(`unexpected request ${url}`);
	});
}

function resultBridge(fetcher: ReturnType<typeof resultFetcher>) {
	return createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken: "s".repeat(32),
		fetch: fetcher,
	})(binding, evidence);
}

it("sends the workspace reference with the result exchange and binds it into idempotency (#3226)", async () => {
	const fetcher = resultFetcher(
		async () => new Response(JSON.stringify(referencedFile), { status: 200 }),
	);
	const bridge = resultBridge(fetcher);
	await expect(
		bridge.writeResult(referencedDescriptor, twoBytes(), {
			workspaceReference: "out/chart.png",
		}),
	).resolves.toMatchObject({
		projection: { fileId: "result-2", status: "available" },
	});
	await bridge.writeResult(referencedDescriptor, twoBytes(), {
		workspaceReference: "out/chart.png",
	});
	await bridge.writeResult(referencedDescriptor, twoBytes(), {
		workspaceReference: "out/copy.png",
	});
	await bridge.writeResult(referencedDescriptor, twoBytes());
	const exchanges = fetcher.mock.calls
		.filter(([input]) => String(input).endsWith("runtime-exchange"))
		.map(([, init]) => {
			if (!init) throw new Error("missing exchange request init");
			return {
				key: (init.headers as Record<string, string>)["Idempotency-Key"],
				body: JSON.parse(String(init.body)),
			};
		});
	expect(exchanges.map(({ body }) => body.workspaceReference)).toEqual([
		"out/chart.png",
		"out/chart.png",
		"out/copy.png",
		undefined,
	]);
	expect(exchanges[0]?.body).toEqual({
		schemaVersion: 2,
		executionGrant: evidence.executionGrant,
		operation: "result",
		descriptor: referencedDescriptor,
		workspaceReference: "out/chart.png",
		idempotencyKey: exchanges[0]?.key,
	});
	expect(exchanges[3]?.body).not.toHaveProperty("workspaceReference");
	expect(exchanges[0]?.key).toBe(exchanges[1]?.key);
	expect(new Set(exchanges.map(({ key }) => key)).size).toBe(3);
});

it.each([
	[
		"a transport failure",
		async (): Promise<Response> => {
			throw new TypeError("fetch failed");
		},
	],
	["a 5xx response", async () => new Response("unavailable", { status: 503 })],
	[
		"an unparseable response",
		async () => new Response("not json", { status: 200 }),
	],
	[
		"a different confirmed descriptor",
		async () =>
			new Response(
				JSON.stringify({
					...referencedFile,
					descriptor: { ...referencedDescriptor, sizeBytes: 3 },
				}),
				{ status: 200 },
			),
	],
])(
	"reports an unconfirmed result after %s on completion (#3226)",
	async (_name, complete) => {
		const bridge = resultBridge(resultFetcher(complete));
		await expect(
			bridge.writeResult(referencedDescriptor, twoBytes(), {
				workspaceReference: "out/chart.png",
			}),
		).rejects.toBeInstanceOf(RuntimeFileResultUnconfirmedError);
	},
);

it("reports a platform rejection of completion as a definite failure (#3226)", async () => {
	const bridge = resultBridge(
		resultFetcher(async () => new Response("conflict", { status: 409 })),
	);
	const failure = bridge.writeResult(referencedDescriptor, twoBytes(), {
		workspaceReference: "out/chart.png",
	});
	await expect(failure).rejects.toThrow("RUNTIME_FILE_RESULT_COMPLETE_FAILED");
	await expect(failure).rejects.not.toBeInstanceOf(
		RuntimeFileResultUnconfirmedError,
	);
});

it("assembles the bridge from parsed configuration with an in-cluster http origin (#3255)", async () => {
	// 回归：配置读取放行的集群内 http origin，FileBridge 也必须接受，否则 Runtime 启动即退出。
	const options = readRuntimeFileExchangeOptions({
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN:
			"http://agent-infra-e2e-native-metadata-api:3000",
		AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: "s".repeat(32),
	});
	if (!options) throw new Error("expected file exchange options");
	const fetcher = vi.fn<typeof fetch>(async () => {
		throw new Error("network");
	});
	const factory = createRuntimeFileBridgeFactoryV1({
		...options,
		fetch: fetcher,
	});
	await expect(
		factory(binding, evidence).readInput("input-1"),
	).rejects.toThrow();
	expect(String(fetcher.mock.calls[0]?.[0])).toBe(
		"http://agent-infra-e2e-native-metadata-api:3000/internal/v1/files/runtime-exchange",
	);
});

it("shares one origin rule between configuration and the bridge (#3255)", () => {
	const accepted = [
		"https://files.example.test",
		"https://10.0.0.1:8443",
		"http://platform-api:3000",
		"http://platform-api.agent-infra.svc.cluster.local:3000",
	];
	const rejected = [
		"http://10.0.0.1:3000",
		"http://[::1]:3000",
		"https://user:pass@files.example.test",
		"https://files.example.test/path",
		"https://files.example.test?x=1",
		"https://files.example.test#x",
		"ftp://files.example.test",
		"not a url",
	];
	for (const origin of accepted) {
		expect(isRuntimeFileExchangeOriginV1(origin)).toBe(true);
		expect(() =>
			createRuntimeFileBridgeFactoryV1({
				origin,
				serviceToken: "s".repeat(32),
			}),
		).not.toThrow();
	}
	for (const origin of rejected) {
		expect(isRuntimeFileExchangeOriginV1(origin)).toBe(false);
		expect(() =>
			readRuntimeFileExchangeOptions({
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN: origin,
				AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN: "s".repeat(32),
			}),
		).toThrow("RUNTIME_CONFIGURATION_INVALID");
		expect(() =>
			createRuntimeFileBridgeFactoryV1({
				origin,
				serviceToken: "s".repeat(32),
			}),
		).toThrow("RUNTIME_FILE_EXCHANGE_CONFIGURATION_INVALID");
	}
});

it("authenticates every execution data-plane request with the service identity (#3281)", async () => {
	// 执行数据面同时要求 File Grant 与服务身份（工程 Spec §15.4.2）；只带 Grant 会被平台以 404 拒绝。
	const serviceToken = "s".repeat(32);
	const dataPlane = (calls: [string | URL | Request, RequestInit?][]) =>
		calls
			.filter(([input]) => !String(input).endsWith("runtime-exchange"))
			.map(([input, init]) => ({
				path: new URL(String(input)).pathname,
				headers: init?.headers as Record<string, string>,
			}));
	const inputFetcher = vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("runtime-exchange"))
			return response({
				schemaVersion: 1,
				fileId: "input-1",
				kind: "attachment",
				descriptor: {
					name: "input.txt",
					mediaType: "text/plain",
					sizeBytes: 3,
					sha256: "a".repeat(64),
				},
				status: "available",
				createdAt: "2026-01-01T00:00:00Z",
				expiresAt: "2099-01-01T00:00:00Z",
			});
		return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
	});
	const input = await createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken,
		fetch: inputFetcher,
	})(binding, evidence).readInput("input-1");
	await new Response(input.body).arrayBuffer();
	const resultFetch = resultFetcher(
		async () => new Response(JSON.stringify(referencedFile), { status: 200 }),
	);
	await resultBridge(resultFetch).writeResult(
		referencedDescriptor,
		twoBytes(),
		{
			workspaceReference: "out/chart.png",
		},
	);
	const requests = [
		...dataPlane(inputFetcher.mock.calls),
		...dataPlane(resultFetch.mock.calls),
	];
	expect(requests.map(({ path }) => path)).toEqual([
		"/api/v1/conversations/conversation-1/files/file-1/content",
		"/api/v1/conversations/conversation-1/files/result-2/content",
		"/api/v1/conversations/conversation-1/files/result-2/complete",
	]);
	for (const { headers } of requests) {
		expect(headers.Authorization).toBe(`Bearer ${serviceToken}`);
		expect(headers["X-Platform-File-Grant"]).toBe(grant.token);
	}
});

it("keeps the service token out of data-plane failures (#3281)", async () => {
	const serviceToken = `sentinel-${"t".repeat(32)}`;
	const bridge = createRuntimeFileBridgeFactoryV1({
		origin: "https://files.example.test",
		serviceToken,
		fetch: resultFetcher(async () => new Response("denied", { status: 404 })),
	})(binding, evidence);
	const failure = await bridge
		.writeResult(referencedDescriptor, twoBytes())
		.catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(Error);
	expect(String((failure as Error).message)).not.toContain(serviceToken);
	expect(JSON.stringify(failure)).not.toContain(serviceToken);
});
