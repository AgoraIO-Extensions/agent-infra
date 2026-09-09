import { once } from "node:events";
import {
	createServer,
	request as httpRequest,
	type Server,
	type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
	gunzipSync,
	gzipSync,
	zstdCompressSync,
	zstdDecompressSync,
} from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type CodexNativeTurn,
	openCodexModelTransport,
} from "./codex-model-transport.js";

const credential = "synthetic-model-credential";
const sensitiveMarker = "synthetic-sensitive-model-failure";
const selectedInternalModel = "option_a/synthetic-selected";
const defaultNativeTurn = {
	threadId: "thread-synthetic",
	turnId: "turn-synthetic",
} as const;
const close: (() => Promise<void>)[] = [];

async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	close.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("missing address");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function transport(endpoint: string, registerDefaultTurn = true) {
	const value = await openCodexModelTransport([
		{
			internalModel: selectedInternalModel,
			model: "synthetic-selected",
			endpoint,
			credential,
		},
	]);
	if (registerDefaultTurn) value.registerTurn(defaultNativeTurn);
	close.push(value.close);
	return value;
}

function event(value: unknown) {
	return `data: ${JSON.stringify(value)}\n\n`;
}

function namedEvent(value: { type: string } & Record<string, unknown>) {
	return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function completedEvent() {
	return event({
		type: "response.completed",
		response: { id: "response-synthetic", status: "completed" },
	});
}

function request(
	modelAccess: { endpoint: string; credential: string },
	overrides: RequestInit = {},
	turn: CodexNativeTurn | null = defaultNativeTurn,
) {
	const headers = new Headers(overrides.headers);
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${modelAccess.credential}`);
	}
	if (turn) {
		if (!headers.has("x-client-request-id")) {
			headers.set("x-client-request-id", turn.threadId);
		}
		if (!headers.has("x-codex-turn-metadata")) {
			headers.set(
				"x-codex-turn-metadata",
				JSON.stringify({ thread_id: turn.threadId, turn_id: turn.turnId }),
			);
		}
	}
	return fetch(`${modelAccess.endpoint}/responses`, {
		method: "POST",
		body: JSON.stringify({ model: selectedInternalModel }),
		...overrides,
		headers,
	});
}

afterEach(async () => {
	for (const stop of close.splice(0).reverse()) await stop();
});

describe("Codex model transport", () => {
	it("forwards the selected model and reasoning over the fixed upstream path", async () => {
		let observed: unknown;
		const target = await listen(
			createServer(async (incoming, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				observed = {
					path: incoming.url,
					authorization: incoming.headers.authorization,
					body: JSON.parse(Buffer.concat(chunks).toString()),
				};
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"x-private": credential,
				});
				response.write(
					event({
						type: "response.output_text.delta",
						delta: "synthetic answer",
					}),
				);
				response.end(completedEvent());
			}),
		);
		const value = await transport(`${target}/approved/v1`);
		expect(value.modelAccess.credential).not.toBe(credential);
		const body = {
			model: selectedInternalModel,
			reasoning: { effort: "high" },
			stream: true,
		};
		const response = await request(value.modelAccess, {
			body: JSON.stringify(body),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			`${event({ type: "response.output_text.delta", delta: "synthetic answer" })}${completedEvent()}`,
		);
		expect(response.headers.has("x-private")).toBe(false);
		expect(observed).toEqual({
			path: "/approved/v1/responses",
			authorization: `Bearer ${credential}`,
			body: { ...body, model: "synthetic-selected" },
		});
	});

	it.each([
		["gzip", gzipSync, gunzipSync],
		["zstd", zstdCompressSync, zstdDecompressSync],
	] as const)(
		"routes and rewrites a %s-compressed native request",
		async (encoding, compress, decompress) => {
			let observed: unknown;
			const target = await listen(
				createServer(async (incoming, response) => {
					const chunks: Buffer[] = [];
					for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
					observed = JSON.parse(
						decompress(Buffer.concat(chunks)).toString("utf8"),
					);
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completedEvent());
				}),
			);
			const value = await transport(target);
			const body = compress(
				Buffer.from(
					JSON.stringify({ model: selectedInternalModel, stream: true }),
				),
			);
			const response = await request(value.modelAccess, {
				headers: {
					authorization: `Bearer ${value.modelAccess.credential}`,
					"content-encoding": encoding,
				},
				body,
			});

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(completedEvent());
			expect(observed).toEqual({ model: "synthetic-selected", stream: true });
		},
	);

	it("rejects a compressed request whose expanded JSON exceeds the bound", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.end();
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess, {
			headers: {
				authorization: `Bearer ${value.modelAccess.credential}`,
				"content-encoding": "gzip",
			},
			body: gzipSync(
				Buffer.from(
					JSON.stringify({
						model: selectedInternalModel,
						input: "x".repeat(8 * 1024 * 1024),
					}),
				),
			),
		});

		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
		expect(calls).toBe(0);
	});

	it("routes duplicate real models only by their exact internal aliases", async () => {
		const observed: { path: string; authorization?: string; model?: string }[] =
			[];
		const first = await listen(
			createServer(async (incoming, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				observed.push({
					path: "first",
					authorization: incoming.headers.authorization,
					model: JSON.parse(Buffer.concat(chunks).toString()).model,
				});
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const second = await listen(
			createServer(async (incoming, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				observed.push({
					path: "second",
					authorization: incoming.headers.authorization,
					model: JSON.parse(Buffer.concat(chunks).toString()).model,
				});
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const value = await openCodexModelTransport([
			{
				internalModel: "option_one/shared-model",
				model: "shared-model",
				endpoint: first,
				credential: "credential-one",
			},
			{
				internalModel: "option_two/shared-model",
				model: "shared-model",
				endpoint: second,
				credential: "credential-two",
			},
		]);
		value.registerTurn(defaultNativeTurn);
		close.push(value.close);
		for (const model of [
			"option_one/shared-model",
			"option_two/shared-model",
		]) {
			const response = await request(value.modelAccess, {
				body: JSON.stringify({ model }),
			});
			expect(response.status).toBe(200);
			await response.text();
		}

		expect(observed).toEqual([
			{
				path: "first",
				authorization: "Bearer credential-one",
				model: "shared-model",
			},
			{
				path: "second",
				authorization: "Bearer credential-two",
				model: "shared-model",
			},
		]);
	});

	it("rejects an unknown internal alias without trying another route", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.end();
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess, {
			body: JSON.stringify({ model: "unknown/synthetic-selected" }),
		});

		expect(response.status).toBe(400);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
		expect(calls).toBe(0);
	});

	it("accepts a pinned-Codex named event when it matches the JSON type", async () => {
		const delta = {
			type: "response.output_text.delta",
			delta: "synthetic answer",
			private_detail: sensitiveMarker,
		};
		const completed = {
			type: "response.completed",
			response: { id: "response-synthetic", status: "completed" },
		};
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(`${namedEvent(delta)}${namedEvent(completed)}`);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			`${namedEvent({ type: delta.type, delta: delta.delta })}${namedEvent(completed)}`,
		);
	});

	it("accepts nullable optional fields on a pinned function call item", async () => {
		const item = {
			type: "function_call",
			id: "item-synthetic",
			name: "synthetic_tool",
			arguments: "{}",
			call_id: "call-synthetic",
			namespace: null,
			encrypted_function_args: null,
		};
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`${event({ type: "response.output_item.added", item })}${completedEvent()}`,
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			`${event({
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "item-synthetic",
					name: "synthetic_tool",
					arguments: "{}",
					call_id: "call-synthetic",
				},
			})}${completedEvent()}`,
		);
	});

	it("rejects a named event that does not match the JSON type", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`event: response.created\ndata: ${JSON.stringify({
						type: "response.output_text.delta",
						delta: sensitiveMarker,
					})}\n\n`,
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		const text = await response.text();

		expect(response.status).toBe(502);
		expect(text).not.toContain(sensitiveMarker);
	});

	it.each([
		[
			"unknown event",
			{
				type: "response.private_provider_event",
				delta: sensitiveMarker,
			},
		],
		[
			"wrong field type",
			{
				type: "response.output_text.delta",
				delta: { message: sensitiveMarker },
			},
		],
		[
			"extra error field",
			{
				type: "response.output_text.delta",
				delta: "safe",
				error: { message: sensitiveMarker },
			},
		],
		[
			"nested completed error",
			{
				type: "response.completed",
				response: {
					id: "response-synthetic",
					status: "completed",
					error: { message: sensitiveMarker },
				},
			},
		],
		[
			"credential echo",
			{
				type: "response.output_text.delta",
				delta: `prefix:${credential}:suffix`,
			},
		],
		[
			"credential echo in a nested object key",
			{
				type: "response.output_item.added",
				item: {
					type: "tool_search_call",
					execution: "synthetic",
					arguments: { [credential]: "synthetic" },
				},
			},
		],
	] as const)("rejects a %s before it reaches Codex", async (_name, unsafe) => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					unsafe.type === "response.completed"
						? event(unsafe)
						: `${event(unsafe)}${completedEvent()}`,
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		const text = await response.text();

		expect(response.status).toBe(502);
		expect(text).toBe('{"error":{"message":"Model request failed"}}');
		expect(text).not.toContain(sensitiveMarker);
		expect(text).not.toContain(credential);
	});

	it("drops SSE comments without changing the validated event stream", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(`: keepalive\n\n${completedEvent()}`);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(completedEvent());
	});

	it("rejects the wrong loopback token and caller-controlled paths before upstream contact", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.end();
			}),
		);
		const value = await transport(target);
		const unauthorized = await request(value.modelAccess, {
			headers: { authorization: "Bearer other-agent" },
		});
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
		const wrongPath = await fetch(`${value.modelAccess.endpoint}/arbitrary`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${value.modelAccess.credential}`,
			},
			body: "{}",
		});
		expect(wrongPath.status).toBe(404);
		await wrongPath.text();
		expect(calls).toBe(0);
	});

	it.each([
		["missing metadata", {}, null],
		[
			"malformed metadata",
			{
				"x-client-request-id": defaultNativeTurn.threadId,
				"x-codex-turn-metadata": "{not-json}",
			},
			null,
		],
		[
			"missing native IDs",
			{
				"x-client-request-id": defaultNativeTurn.threadId,
				"x-codex-turn-metadata": "{}",
			},
			null,
		],
		[
			"conflicting client request ID",
			{ "x-client-request-id": "other-thread" },
			defaultNativeTurn,
		],
	] as const)(
		"rejects %s before upstream contact",
		async (_name, headers, turn) => {
			let calls = 0;
			const target = await listen(
				createServer((_incoming, response) => {
					calls += 1;
					response.end();
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess, { headers }, turn);

			expect(response.status).toBe(400);
			expect(await response.text()).toBe(
				'{"error":{"message":"Model request failed"}}',
			);
			expect(calls).toBe(0);
		},
	);

	it("waits for native lifecycle admission when HTTP arrives before JSON-RPC", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const value = await transport(target, false);
		const pending = request(value.modelAccess);
		await delay(25);
		expect(calls).toBe(0);

		value.registerTurn(defaultNativeTurn);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(completedEvent());
		expect(calls).toBe(1);
	});

	it("rejects a well-formed but unknown native Turn", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.end();
			}),
		);
		const value = await transport(target, false);
		const response = await request(value.modelAccess);

		expect(response.status).toBe(409);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
		expect(calls).toBe(0);
	});

	it("blocks an expired recognized Turn without affecting another Thread", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const value = await transport(target, false);
		const expiringTurn = { threadId: "thread-expiring", turnId: "turn-one" };
		const unrelatedTurn = { threadId: "thread-unrelated", turnId: "turn-one" };
		value.recognizeTurn(expiringTurn, Date.now() + 50);
		const expiringRequest = request(value.modelAccess, {}, expiringTurn);
		value.registerTurn(unrelatedTurn);

		const unrelatedResponse = await request(
			value.modelAccess,
			{},
			unrelatedTurn,
		);
		expect(unrelatedResponse.status).toBe(200);
		expect(await unrelatedResponse.text()).toBe(completedEvent());
		const expiredResponse = await expiringRequest;
		expect(expiredResponse.status).toBe(409);
		expect(value.registerTurn(expiringTurn)).toBe(false);
		const lateResponse = await request(value.modelAccess, {}, expiringTurn);
		expect(lateResponse.status).toBe(409);
		expect(calls).toBe(1);
	});

	it.each([
		[401, "application/json", 401],
		[403, "application/json", 403],
		[503, "application/json", 502],
		[302, "text/event-stream", 502],
		[200, "application/json", 502],
	] as const)(
		"normalizes provider HTTP %s with content type %s",
		async (status, contentType, expectedStatus) => {
			let calls = 0;
			const target = await listen(
				createServer((_incoming, response) => {
					calls += 1;
					response.writeHead(status, {
						"content-type": contentType,
						location: `/private/${sensitiveMarker}`,
						"x-private": credential,
					});
					response.end(JSON.stringify({ error: { message: sensitiveMarker } }));
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess);
			const text = await response.text();
			expect(response.status).toBe(expectedStatus);
			expect(text).toBe('{"error":{"message":"Model request failed"}}');
			expect(text).not.toContain(sensitiveMarker);
			expect(response.headers.has("location")).toBe(false);
			expect(response.headers.has("x-private")).toBe(false);
			expect(calls).toBe(1);
		},
	);

	it.each(["response.failed", "response.incomplete", "error"])(
		"suppresses a sensitive HTTP-200 %s event",
		async (type) => {
			const target = await listen(
				createServer((_incoming, response) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(
						event({
							type,
							error: { message: `${sensitiveMarker}:${credential}` },
						}),
					);
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess);
			const text = await response.text();
			expect(response.status).toBe(502);
			expect(text).toBe('{"error":{"message":"Model request failed"}}');
			expect(text).not.toContain(sensitiveMarker);
			expect(text).not.toContain(credential);
		},
	);

	it("replaces a failure after safe events with a sanitized SSE error", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(event({ type: "response.created", response: {} }));
				response.end(
					event({
						type: "response.failed",
						error: { message: sensitiveMarker },
					}),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(text).toContain('"type":"response.created"');
		expect(text).toContain(
			'"type":"error","code":"server_error","message":"Model request failed"',
		);
		expect(text).not.toContain(sensitiveMarker);
	});

	it.each([
		["malformed", "data: {not-json}\n\n"],
		[
			"oversized",
			`data: ${JSON.stringify({
				type: "response.output_text.delta",
				delta: "x".repeat(1024 * 1024),
			})}\n\n`,
		],
		["unterminated", completedEvent().trimEnd()],
		[
			"post-terminal",
			`${completedEvent()}${event({
				type: "response.output_text.delta",
				delta: sensitiveMarker,
			})}`,
		],
	] as const)("rejects a %s SSE stream", async (_name, stream) => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(stream);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		const text = await response.text();
		expect(response.status).toBe(502);
		expect(text).toBe('{"error":{"message":"Model request failed"}}');
		expect(text).not.toContain(sensitiveMarker);
	});

	it("cancels only the exact native Turn and rejects its late requests", async () => {
		const firstTurn = { threadId: "thread-one", turnId: "turn-one" };
		const otherTurn = { threadId: "thread-two", turnId: "turn-one" };
		const laterTurn = { threadId: "thread-one", turnId: "turn-two" };
		const streams = new Map<
			string,
			{ response: ServerResponse; closed: boolean }
		>();
		const target = await listen(
			createServer(async (incoming, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				const tag = JSON.parse(Buffer.concat(chunks).toString()).tag as string;
				const stream = { response, closed: false };
				streams.set(tag, stream);
				response.once("close", () => {
					stream.closed = true;
				});
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(event({ type: "response.created", response: {} }));
			}),
		);
		const value = await transport(target, false);
		value.registerTurn(firstTurn);
		value.registerTurn(otherTurn);
		const firstResponsePromise = request(
			value.modelAccess,
			{
				body: JSON.stringify({ model: selectedInternalModel, tag: "first" }),
			},
			firstTurn,
		);
		const otherResponsePromise = request(
			value.modelAccess,
			{
				body: JSON.stringify({ model: selectedInternalModel, tag: "other" }),
			},
			otherTurn,
		);
		await vi.waitFor(() => expect(streams.size).toBe(2));
		const [firstResponse, otherResponse] = await Promise.all([
			firstResponsePromise,
			otherResponsePromise,
		]);

		await value.cancelTurn(firstTurn);
		await vi.waitFor(() => expect(streams.get("first")?.closed).toBe(true));
		expect(streams.get("other")?.closed).toBe(false);
		await firstResponse.body?.cancel().catch(() => {});
		streams.get("other")?.response.end(completedEvent());
		expect(await otherResponse.text()).toContain('"type":"response.completed"');

		const late = await request(value.modelAccess, {}, firstTurn);
		expect(late.status).toBe(409);
		expect(await late.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);

		value.registerTurn(laterTurn);
		const laterResponsePromise = request(
			value.modelAccess,
			{
				body: JSON.stringify({ model: selectedInternalModel, tag: "later" }),
			},
			laterTurn,
		);
		await vi.waitFor(() => expect(streams.has("later")).toBe(true));
		streams.get("later")?.response.end(completedEvent());
		const laterResponse = await laterResponsePromise;
		expect(laterResponse.status).toBe(200);
		expect(await laterResponse.text()).toContain('"type":"response.completed"');
	});

	it("finishes exact-Turn cancellation while its request body is still open", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.end();
			}),
		);
		const value = await transport(target);
		const client = httpRequest(`${value.modelAccess.endpoint}/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${value.modelAccess.credential}`,
				"content-length": String(1024 * 1024),
				expect: "100-continue",
				"x-client-request-id": defaultNativeTurn.threadId,
				"x-codex-turn-metadata": JSON.stringify({
					thread_id: defaultNativeTurn.threadId,
					turn_id: defaultNativeTurn.turnId,
				}),
			},
		});
		client.on("error", () => {});
		const continued = once(client, "continue");
		const closed = new Promise<void>((resolve) =>
			client.once("close", resolve),
		);
		client.flushHeaders();
		await continued;
		client.write(`{"model":"${selectedInternalModel}","input":"`);
		await delay(25);

		await expect(
			Promise.race([
				value.cancelTurn(defaultNativeTurn),
				delay(1_000).then(() => Promise.reject(new Error("cancel timeout"))),
			]),
		).resolves.toBeUndefined();
		await closed;
		expect(calls).toBe(0);
	});

	it("aborts the upstream request when the native client cancels", async () => {
		let contacted: (() => void) | undefined;
		let upstreamClosed: (() => void) | undefined;
		const contactedPromise = new Promise<void>((resolve) => {
			contacted = resolve;
		});
		const upstreamClosedPromise = new Promise<void>((resolve) => {
			upstreamClosed = resolve;
		});
		const target = await listen(
			createServer((_incoming, response) => {
				contacted?.();
				response.once("close", () => upstreamClosed?.());
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(event({ type: "response.created", response: {} }));
			}),
		);
		const value = await transport(target);
		const controller = new AbortController();
		const response = await request(value.modelAccess, {
			signal: controller.signal,
		});
		await contactedPromise;
		controller.abort();
		await response.body?.cancel().catch(() => {});
		await vi.waitFor(() =>
			expect(upstreamClosedPromise).resolves.toBeUndefined(),
		);
	});

	it("normalizes an upstream stream abort", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(event({ type: "response.created", response: {} }));
				void delay(10).then(() => response.socket?.destroy());
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		const text = await response.text();
		expect(response.status).toBe(200);
		expect(text).toContain("Model request failed");
		expect(text).not.toContain(sensitiveMarker);
	});

	it("aborts active upstream work and revokes the token on close", async () => {
		let contacted: (() => void) | undefined;
		let upstreamClosed: (() => void) | undefined;
		const contactedPromise = new Promise<void>((resolve) => {
			contacted = resolve;
		});
		const upstreamClosedPromise = new Promise<void>((resolve) => {
			upstreamClosed = resolve;
		});
		const target = await listen(
			createServer((_incoming, response) => {
				contacted?.();
				response.once("close", () => upstreamClosed?.());
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(event({ type: "response.created", response: {} }));
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		await contactedPromise;
		await value.close();
		await response.body?.cancel().catch(() => {});
		await expect(upstreamClosedPromise).resolves.toBeUndefined();
		await expect(request(value.modelAccess)).rejects.toThrow();
	});
});
