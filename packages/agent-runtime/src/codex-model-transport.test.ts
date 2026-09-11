import { once } from "node:events";
import {
	createServer,
	request as httpRequest,
	IncomingMessage,
	Server,
	ServerResponse,
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
	if (registerDefaultTurn) admitTurn(value, defaultNativeTurn);
	close.push(value.close);
	return value;
}

async function transportWithCredentials(
	endpoint: string,
	credentials: readonly string[],
) {
	const value = await openCodexModelTransport(
		credentials.map((credential, index) => ({
			internalModel:
				index === 0
					? selectedInternalModel
					: `option_${index}/synthetic-selected`,
			model: "synthetic-selected",
			endpoint,
			credential,
		})),
	);
	admitTurn(value, defaultNativeTurn);
	close.push(value.close);
	return value;
}

function admitTurn(
	transport: Awaited<ReturnType<typeof openCodexModelTransport>>,
	turn: CodexNativeTurn,
	internalModel = selectedInternalModel,
) {
	const admission = transport.beginTurnAdmission(
		Date.now() + 1_000,
		internalModel,
		turn.threadId,
		"high",
	);
	expect(transport.recognizeTurn(admission, turn)).toBe(true);
	expect(transport.registerTurn(admission, turn)).toBe(true);
	return admission;
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
	it("does not retain listeners across repeated real response backpressure", async () => {
		const delta = "a".repeat(256 * 1024);
		const body =
			Array.from({ length: 8 }, () =>
				event({ type: "response.output_text.delta", delta }),
			).join("") + completedEvent();
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(body);
			}),
		);
		const value = await transport(target);
		const listenerCounts: { close: number; error: number }[] = [];
		let backpressureCount = 0;
		const original = ServerResponse.prototype.write;
		const writes = vi
			.spyOn(ServerResponse.prototype, "write")
			.mockImplementation(function (
				this: ServerResponse,
				...args: Parameters<ServerResponse["write"]>
			) {
				const isNativeResponse = Boolean(
					this.req.headers["x-codex-turn-metadata"],
				);
				if (isNativeResponse)
					listenerCounts.push({
						close: this.listenerCount("close"),
						error: this.listenerCount("error"),
					});
				const result = Reflect.apply(original, this, args) as boolean;
				if (isNativeResponse && !result) backpressureCount += 1;
				return result;
			});
		try {
			const response = await request(value.modelAccess);
			expect(response.status).toBe(200);
			const output = await response.text();
			expect(output).toContain(delta);
			expect(output).toContain('"type":"response.completed"');
			expect(backpressureCount).toBeGreaterThanOrEqual(4);
			const initial = listenerCounts[0];
			if (!initial) throw new Error("No native response observed");
			for (const counts of listenerCounts) {
				expect(counts.close).toBeLessThanOrEqual(initial.close);
				expect(counts.error).toBeLessThanOrEqual(initial.error);
			}
		} finally {
			writes.mockRestore();
		}
	});
	it("removes its startup error listener after listening", async () => {
		const target = await listen(
			createServer((_request, response) => response.end()),
		);
		const once = vi.spyOn(Server.prototype, "once");
		try {
			await transport(target);
			const calls = once.mock.calls as unknown as [
				string | symbol,
				...unknown[],
			][];
			const errorListenerCall = calls.findIndex(([event]) => event === "error");
			const server = once.mock.instances[errorListenerCall] as
				| Server
				| undefined;

			expect(errorListenerCall).toBeGreaterThanOrEqual(0);
			expect(server).toBeInstanceOf(Server);
			expect(server?.listenerCount("error")).toBe(0);
		} finally {
			once.mockRestore();
		}
	});

	it("binds upstream reasoning to the admitted effort despite a stale native effort", async () => {
		let observed: unknown;
		const target = await listen(
			createServer(async (incoming, response) => {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				observed = JSON.parse(Buffer.concat(chunks).toString()).reasoning;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const value = await transport(target, false);
		const admission = value.beginTurnAdmission(
			Date.now() + 1_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(admission, defaultNativeTurn)).toBe(true);
		expect(value.registerTurn(admission, defaultNativeTurn)).toBe(true);
		const response = await request(value.modelAccess, {
			body: JSON.stringify({
				model: selectedInternalModel,
				reasoning: { effort: "ultra", summary: "auto" },
			}),
		});
		expect(response.status).toBe(200);
		await response.text();
		expect(observed).toEqual({ effort: "high", summary: "auto" });
	});

	it.each([null, [], true])(
		"rejects malformed reasoning %s without forwarding",
		async (reasoning) => {
			let calls = 0;
			const target = await listen(
				createServer((_incoming, response) => {
					calls += 1;
					response.end();
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess, {
				body: JSON.stringify({ model: selectedInternalModel, reasoning }),
			});
			expect(response.status).toBe(400);
			await response.text();
			expect(calls).toBe(0);
		},
	);

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

	it("forwards a near-limit benign stream with the maximum route count", async () => {
		const largeEvent = event({
			type: "response.output_text.delta",
			delta: "x".repeat(1024 * 1024 - 256),
		});
		const stream = largeEvent.repeat(15) + completedEvent();
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(stream);
			}),
		);
		const credentials = Array.from(
			{ length: 128 },
			(_, index) =>
				`synthetic-route-${String(index).padStart(3, "0")}-credential`,
		);
		const value = await transportWithCredentials(target, credentials);
		const response = await request(value.modelAccess);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(stream);
	}, 30_000);

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
			expect(observed).toEqual({
				model: "synthetic-selected",
				stream: true,
				reasoning: { effort: "high" },
			});
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
				credential: "synthetic-credential-one",
			},
			{
				internalModel: "option_two/shared-model",
				model: "shared-model",
				endpoint: second,
				credential: "synthetic-credential-two",
			},
		]);
		close.push(value.close);
		for (const model of [
			"option_one/shared-model",
			"option_two/shared-model",
		]) {
			const turn = { ...defaultNativeTurn, turnId: model.replace("/", "-") };
			admitTurn(value, turn, model);
			const response = await request(
				value.modelAccess,
				{
					body: JSON.stringify({ model }),
				},
				turn,
			);
			expect(response.status).toBe(200);
			await response.text();
		}

		expect(observed).toEqual([
			{
				path: "first",
				authorization: "Bearer synthetic-credential-one",
				model: "shared-model",
			},
			{
				path: "second",
				authorization: "Bearer synthetic-credential-two",
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

	it.each([
		["assistant", 200],
		["system", 502],
		["user", 502],
	] as const)(
		"enforces the pinned output message role for real SSE role %s",
		async (role, expectedStatus) => {
			const outputItem = event({
				type: "response.output_item.done",
				item: {
					type: "message",
					role,
					content: [{ type: "output_text", text: "synthetic answer" }],
				},
			});
			const target = await listen(
				createServer((_incoming, response) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(outputItem + completedEvent());
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess);

			expect(response.status).toBe(expectedStatus);
			expect(await response.text()).toBe(
				role === "assistant"
					? outputItem + completedEvent()
					: '{"error":{"message":"Model request failed"}}',
			);
		},
	);

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

	it.each([
		{ type: "response.output_text.delta" },
		{ type: "response.custom_tool_call_input.delta", item_id: "tool-a" },
		{ type: "response.reasoning_summary_text.delta", summary_index: 0 },
		{ type: "response.reasoning_text.delta", content_index: 0 },
	])(
		"withholds split credentials across %j events and transport chunks",
		async (shape) => {
			const prefix = credential.slice(0, 12);
			const target = await listen(
				createServer(async (_incoming, response) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					const first = event({ ...shape, delta: prefix });
					response.write(first.slice(0, 17));
					await delay(5);
					response.write(first.slice(17));
					await delay(5);
					// An unrelated channel must not clear this channel's pending match.
					response.write(
						event({
							type:
								shape.type === "response.output_text.delta"
									? "response.reasoning_text.delta"
									: "response.output_text.delta",
							content_index: 7,
							delta: "unrelated!",
						}),
					);
					await delay(5);
					response.end(
						event({ ...shape, delta: credential.slice(12) }) + completedEvent(),
					);
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess);
			const text = await response.text();
			expect(response.status).toBe(502);
			expect(text).toBe('{"error":{"message":"Model request failed"}}');
			expect(text).not.toContain(prefix);
		},
	);
	it("never resumes forwarding after a split credential match within one chunk", async () => {
		const prefix = credential.slice(0, 12);
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					event({ type: "response.output_text.delta", delta: prefix }) +
						event({
							type: "response.output_text.delta",
							delta: credential.slice(12),
						}) +
						event({ type: "response.output_text.delta", delta: "ordinary!" }) +
						completedEvent(),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
	});

	it("rejects a split non-first credential through a shared suffix fallback", async () => {
		const sharedCredential = "synthetic-overlap-credential";
		const target = await listen(
			createServer(async (_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(
					event({
						type: "response.output_text.delta",
						delta: "prefix-synthetic-overlap-",
					}),
				);
				await delay(5);
				response.end(
					event({ type: "response.output_text.delta", delta: "credential" }) +
						completedEvent(),
				);
			}),
		);
		const credentials = Array.from(
			{ length: 126 },
			(_, index) =>
				`synthetic-route-${String(index).padStart(3, "0")}-credential`,
		);
		credentials.push(
			sharedCredential,
			`prefix-${sharedCredential}-continuation`,
		);
		const value = await transportWithCredentials(target, credentials);
		const response = await request(value.modelAccess);
		const text = await response.text();

		expect(response.status).toBe(502);
		expect(text).toBe('{"error":{"message":"Model request failed"}}');
		expect(text).not.toContain(sharedCredential);
	});
	it("releases disambiguated prefixes incrementally without changing event order", async () => {
		let finish: (() => void) | undefined;
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const target = await listen(
			createServer(async (_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(
					event({ type: "response.output_text.delta", delta: "synthetic-" }),
				);
				await delay(5);
				response.write(
					event({ type: "response.output_text.delta", delta: "ordinary!" }),
				);
				await done;
				response.end(completedEvent());
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		const reader = response.body?.getReader();
		if (!reader) throw new Error();
		const first = await reader.read();
		const text = new TextDecoder().decode(first.value);
		expect(text).toContain('"delta":"synthetic-"');
		finish?.();
		let rest = "";
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			rest += new TextDecoder().decode(next.value);
		}
		expect(text + rest).toBe(
			event({ type: "response.output_text.delta", delta: "synthetic-" }) +
				event({ type: "response.output_text.delta", delta: "ordinary!" }) +
				completedEvent(),
		);
	});
	it("releases a benign incomplete credential prefix only after successful EOF", async () => {
		const prefix = credential.slice(0, 12);
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					event({ type: "response.output_text.delta", delta: prefix }) +
						completedEvent(),
				);
			}),
		);
		const value = await transport(target);
		expect(await (await request(value.modelAccess)).text()).toBe(
			event({ type: "response.output_text.delta", delta: prefix }) +
				completedEvent(),
		);
	});
	it("fails closed at the pending event cap without releasing a credential prefix", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					event({ type: "response.output_text.delta", delta: "synthetic-" }) +
						event({ type: "response.created", response: {} }).repeat(256) +
						completedEvent(),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
	});
	it("discards a pending credential prefix when the upstream terminates early", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					event({ type: "response.output_text.delta", delta: "synthetic-" }),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
	});
	it("discards held credential fragments when the transport is closed", async () => {
		let sentPrefix: (() => void) | undefined;
		const prefixSent = new Promise<void>((resolve) => {
			sentPrefix = resolve;
		});
		const target = await listen(
			createServer(async (_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(
					event({ type: "response.output_text.delta", delta: "visible!" }),
				);
				await delay(5);
				response.write(
					event({ type: "response.output_text.delta", delta: "synthetic-" }),
				);
				sentPrefix?.();
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		let text = "";
		const content = (async () => {
			try {
				if (!response.body) throw new Error();
				for await (const chunk of response.body)
					text += new TextDecoder().decode(chunk);
			} catch {
				// Driver close is allowed to terminate the downstream socket.
			}
		})();
		await prefixSent;
		await value.close();
		await content;
		expect(text).toContain('"delta":"visible!"');
		expect(text).not.toContain("synthetic-");
		expect(text).not.toContain("response.completed");
	});
	it.each([
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				role: "assistant",
				content: [
					{ type: "output_text", text: credential.slice(0, 12) },
					{ type: "output_text", text: credential.slice(12) },
				],
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "reasoning",
				summary: [{ type: "summary_text", text: credential.slice(0, 12) }],
				content: [{ type: "reasoning_text", text: credential.slice(12) }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "response-a",
				status: "completed",
				output: [
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: credential.slice(0, 12) }],
					},
					{
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: credential.slice(12) }],
					},
				],
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "tool_search_call",
				execution: "client",
				arguments: {
					first: credential.slice(0, 12),
					nested: { second: credential.slice(12) },
				},
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "function_call",
				name: "synthetic",
				call_id: "call-a",
				arguments: JSON.stringify({
					first: credential.slice(0, 12),
					nested: [credential.slice(12)],
				}),
			},
		},
		{
			type: "response.output_item.done",
			item: {
				type: "custom_tool_call",
				name: "synthetic",
				call_id: "call-a",
				input: JSON.stringify([credential.slice(0, 12), credential.slice(12)]),
			},
		},
	])(
		"rejects semantic credential fragments within one event %j",
		async (unsafe) => {
			const target = await listen(
				createServer((_incoming, response) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(
						event(unsafe) +
							(unsafe.type === "response.completed" ? "" : completedEvent()),
					);
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess);
			expect(response.status).toBe(502);
			expect(await response.text()).toBe(
				'{"error":{"message":"Model request failed"}}',
			);
		},
	);
	it("does not let an extra item mask completed output credential fragments", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					event({
						type: "response.completed",
						item: {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: "benign" }],
						},
						response: {
							id: "response-a",
							status: "completed",
							output: [
								{
									type: "message",
									role: "assistant",
									content: [
										{ type: "output_text", text: credential.slice(0, 12) },
										{ type: "output_text", text: credential.slice(12) },
									],
								},
							],
						},
					}),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
	});
	it("does not concatenate protocol identifiers into semantic content", async () => {
		const valid = {
			type: "response.output_item.done",
			item: {
				type: "message",
				id: credential.slice(0, 12),
				role: "assistant",
				content: [{ type: "output_text", text: credential.slice(12) }],
			},
		};
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(event(valid) + completedEvent());
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(event(valid) + completedEvent());
	});
	it("preserves adjacent benign text parts without subsequence matching", async () => {
		const valid = {
			type: "response.output_item.done",
			item: {
				type: "message",
				role: "assistant",
				content: [
					{ type: "output_text", text: credential.slice(0, 12) },
					{ type: "output_text", text: "!" },
					{ type: "output_text", text: credential.slice(12) },
				],
			},
		};
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(event(valid) + completedEvent());
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(event(valid) + completedEvent());
	});
	it("bounds decoded tool argument nesting before native delivery", async () => {
		let nested: unknown = "ordinary";
		for (let i = 0; i < 34; i += 1) nested = { value: nested };
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					event({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							name: "synthetic",
							call_id: "call-a",
							arguments: JSON.stringify(nested),
						},
					}) + completedEvent(),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
	});
	it.each(["message", "function_call", "custom_tool_call", "tool_search_call"])(
		"withholds credentials split across forwarded %s items",
		async (type) => {
			const itemEvent = (text: string) =>
				event({
					type: "response.output_item.done",
					item:
						type === "message"
							? {
									type,
									id: "item-a",
									role: "assistant",
									content: [{ type: "output_text", text }],
								}
							: type === "tool_search_call"
								? {
										type,
										id: "item-a",
										execution: "client",
										arguments: { text },
									}
								: {
										type,
										id: "item-a",
										name: "synthetic",
										call_id: "call-a",
										...(type === "function_call"
											? { arguments: JSON.stringify({ text }) }
											: { input: text }),
									},
				});
			const target = await listen(
				createServer(async (_incoming, response) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.write(itemEvent(credential.slice(0, 12)));
					await delay(5);
					response.write(
						event({
							type: "response.reasoning_text.delta",
							content_index: 0,
							delta: "unrelated!",
						}),
					);
					await delay(5);
					response.end(itemEvent(credential.slice(12)) + completedEvent());
				}),
			);
			const value = await transport(target);
			const response = await request(value.modelAccess);
			expect(response.status).toBe(502);
			expect(await response.text()).toBe(
				'{"error":{"message":"Model request failed"}}',
			);
		},
	);
	it("shares semantic protection across delta and completed item text", async () => {
		const target = await listen(
			createServer(async (_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(
					event({
						type: "response.output_text.delta",
						delta: credential.slice(0, 12),
					}),
				);
				await delay(5);
				response.end(
					event({
						type: "response.output_item.done",
						item: {
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: credential.slice(12) }],
						},
					}) + completedEvent(),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(502);
		expect(await response.text()).toBe(
			'{"error":{"message":"Model request failed"}}',
		);
	});
	it("does not add discarded completed output to the forwarded semantic stream", async () => {
		const first = event({
			type: "response.output_text.delta",
			delta: credential.slice(0, 12),
		});
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					first +
						event({
							type: "response.completed",
							response: {
								id: "response-synthetic",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [
											{ type: "output_text", text: credential.slice(12) },
										],
									},
								],
							},
						}),
				);
			}),
		);
		const value = await transport(target);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(first + completedEvent());
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

	it.each([
		[undefined, "model"],
		["gzip", "model"],
		["zstd", "model"],
		[undefined, "effort"],
		["gzip", "effort"],
		["zstd", "effort"],
	] as const)(
		"keeps the admitted selection with %s encoding despite conflicting %s",
		async (encoding, conflict) => {
			const observed: string[] = [];
			const efforts: string[] = [];
			const target = await listen(
				createServer(async (incoming, response) => {
					const chunks: Buffer[] = [];
					for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
					const bytes = Buffer.concat(chunks);
					const decoded =
						incoming.headers["content-encoding"] === "gzip"
							? gunzipSync(bytes)
							: incoming.headers["content-encoding"] === "zstd"
								? zstdDecompressSync(bytes)
								: bytes;
					efforts.push(JSON.parse(decoded.toString()).reasoning.effort);
					observed.push(incoming.headers.authorization ?? "");
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completedEvent());
				}),
			);
			const alternate = "option_b/synthetic-selected";
			const value = await openCodexModelTransport([
				{
					internalModel: selectedInternalModel,
					model: "synthetic-selected",
					endpoint: target,
					credential,
				},
				{
					internalModel: alternate,
					model: "synthetic-selected",
					endpoint: target,
					credential: "synthetic-alternate-credential",
				},
			]);
			close.push(value.close);
			admitTurn(value, defaultNativeTurn);
			const conflicting = value.beginTurnAdmission(
				Date.now() + 1_000,
				conflict === "model" ? alternate : selectedInternalModel,
				defaultNativeTurn.threadId,
				conflict === "effort" ? "low" : "high",
			);
			expect(value.recognizeTurn(conflicting, defaultNativeTurn)).toBe(true);
			expect(value.registerTurn(conflicting, defaultNativeTurn)).toBe(false);
			const body = Buffer.from(JSON.stringify({ model: alternate }));
			const rejected = await request(value.modelAccess, {
				body:
					encoding === "gzip"
						? gzipSync(body)
						: encoding === "zstd"
							? zstdCompressSync(body)
							: body,
				headers: encoding ? { "content-encoding": encoding } : {},
			});
			expect(rejected.status).toBe(400);
			expect(await rejected.text()).toBe(
				'{"error":{"message":"Model request failed"}}',
			);
			expect(observed).toEqual([]);
			// Recovery can reauthorize the same still-running Turn with its original model.
			admitTurn(value, defaultNativeTurn);
			const accepted = await request(value.modelAccess);
			expect(accepted.status).toBe(200);
			await accepted.text();
			expect(observed).toEqual([`Bearer ${credential}`]);
			expect(efforts).toEqual(["high"]);
		},
	);

	it("rejects an admission for an unconfigured model before recognition", async () => {
		const target = await listen(
			createServer((_incoming, response) => response.end()),
		);
		const value = await transport(target, false);
		const admission = value.beginTurnAdmission(
			Date.now() + 1_000,
			"unknown/model",
			defaultNativeTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(admission, defaultNativeTurn)).toBe(false);
		expect(value.registerTurn(admission, defaultNativeTurn)).toBe(false);
	});

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
		const admission = value.beginTurnAdmission(
			Date.now() + 1_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);
		const pending = request(value.modelAccess);
		await delay(25);
		expect(calls).toBe(0);

		expect(value.recognizeTurn(admission, defaultNativeTurn)).toBe(true);
		expect(value.registerTurn(admission, defaultNativeTurn)).toBe(true);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(completedEvent());
		expect(calls).toBe(1);
	});

	it.each([
		"abandon",
		"expire",
		"cancel",
		"close",
		"other-turn",
		"ambiguous",
	] as const)(
		"rejects a parked request on %s without borrowing a later admission",
		async (failure) => {
			let calls = 0;
			const target = await listen(
				createServer((_incoming, response) => {
					calls += 1;
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(completedEvent());
				}),
			);
			const value = await transport(target, false);
			const admission = value.beginTurnAdmission(
				Date.now() + (failure === "expire" ? 100 : 5_000),
				selectedInternalModel,
				defaultNativeTurn.threadId,
				"high",
			);
			let settled = false;
			const pending = request(value.modelAccess).then(
				(response) => {
					settled = true;
					return response;
				},
				(error: unknown) => {
					if (failure !== "cancel" && failure !== "close") throw error;
					settled = true;
					return undefined;
				},
			);
			await delay(25);
			expect(settled).toBe(false);
			expect(calls).toBe(0);
			if (failure === "abandon") value.abandonTurnAdmission(admission);
			if (failure === "cancel") await value.cancelTurn(defaultNativeTurn);
			if (failure === "close") await value.close();
			if (failure === "other-turn")
				expect(
					value.recognizeTurn(admission, {
						...defaultNativeTurn,
						turnId: "different-turn",
					}),
				).toBe(true);
			if (failure === "ambiguous") {
				const second = value.beginTurnAdmission(
					Date.now() + 5_000,
					selectedInternalModel,
					defaultNativeTurn.threadId,
					"high",
				);
				value.abandonTurnAdmission(second);
				expect(value.recognizeTurn(admission, defaultNativeTurn)).toBe(true);
				expect(value.registerTurn(admission, defaultNativeTurn)).toBe(true);
			}
			const rejected = await pending;
			if (rejected) {
				expect(rejected.status).toBe(409);
				await rejected.text();
			}
			value.abandonTurnAdmission(admission);
			if (failure !== "cancel" && failure !== "close") {
				admitTurn(value, defaultNativeTurn);
				const accepted = await request(value.modelAccess);
				expect(accepted.status).toBe(200);
				await accepted.text();
				expect(calls).toBe(1);
			} else expect(calls).toBe(0);
		},
	);

	it("rejects an unknown Thread despite another Thread's pending admission", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.end();
			}),
		);
		const value = await transport(target, false);
		const admission = value.beginTurnAdmission(
			Date.now() + 5_000,
			selectedInternalModel,
			"another-thread",
			"high",
		);
		const rejected = await request(value.modelAccess);
		expect(rejected.status).toBe(409);
		await rejected.text();
		expect(value.recognizeTurn(admission, defaultNativeTurn)).toBe(false);
		expect(calls).toBe(0);
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
		const admission = value.beginTurnAdmission(
			Date.now() + 50,
			selectedInternalModel,
			expiringTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(admission, expiringTurn)).toBe(true);
		const expiringRequest = request(value.modelAccess, {}, expiringTurn);
		admitTurn(value, unrelatedTurn);

		const unrelatedResponse = await request(
			value.modelAccess,
			{},
			unrelatedTurn,
		);
		expect(unrelatedResponse.status).toBe(200);
		expect(await unrelatedResponse.text()).toBe(completedEvent());
		const expiredResponse = await expiringRequest;
		expect(expiredResponse.status).toBe(409);
		expect(value.registerTurn(admission, expiringTurn)).toBe(false);
		expect(value.recognizeTurn(admission, expiringTurn)).toBe(false);
		const lateResponse = await request(value.modelAccess, {}, expiringTurn);
		expect(lateResponse.status).toBe(409);
		expect(calls).toBe(1);
	});

	it("never reuses concurrent pending admissions after cancellation", async () => {
		let calls = 0;
		const target = await listen(
			createServer((_incoming, response) => {
				calls += 1;
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const value = await transport(target, false);
		const firstAdmission = value.beginTurnAdmission(
			Date.now() + 5_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);
		const secondAdmission = value.beginTurnAdmission(
			Date.now() + 5_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(firstAdmission, defaultNativeTurn)).toBe(true);
		expect(value.recognizeTurn(secondAdmission, defaultNativeTurn)).toBe(true);

		await value.cancelTurn(defaultNativeTurn);

		expect(value.registerTurn(firstAdmission, defaultNativeTurn)).toBe(false);
		expect(value.registerTurn(secondAdmission, defaultNativeTurn)).toBe(false);
		expect(value.recognizeTurn(firstAdmission, defaultNativeTurn)).toBe(false);
		const freshAdmission = value.beginTurnAdmission(
			Date.now() + 5_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(freshAdmission, defaultNativeTurn)).toBe(false);
		expect(value.registerTurn(freshAdmission, defaultNativeTurn)).toBe(false);
		const late = await request(value.modelAccess);
		expect(late.status).toBe(409);
		expect(calls).toBe(0);
	});

	it("never reuses an abandoned admission", async () => {
		const target = await listen(
			createServer((_incoming, response) => response.end()),
		);
		const value = await transport(target, false);
		const admission = value.beginTurnAdmission(
			Date.now() + 5_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);

		value.abandonTurnAdmission(admission);

		expect(value.recognizeTurn(admission, defaultNativeTurn)).toBe(false);
		expect(value.registerTurn(admission, defaultNativeTurn)).toBe(false);
	});

	it("allows a fresh capability after provisional recognition was abandoned", async () => {
		const target = await listen(
			createServer((_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(completedEvent());
			}),
		);
		const value = await transport(target, false);
		const provisional = value.beginTurnAdmission(
			Date.now() + 1_000,
			selectedInternalModel,
			defaultNativeTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(provisional, defaultNativeTurn)).toBe(true);
		value.abandonTurnAdmission(provisional);
		admitTurn(value, defaultNativeTurn);
		const response = await request(value.modelAccess);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(completedEvent());
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
		let sendFailure: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			sendFailure = resolve;
		});
		const target = await listen(
			createServer(async (_incoming, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(event({ type: "response.created", response: {} }));
				await ready;
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
		sendFailure?.();
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
		const cancelledAdmission = value.beginTurnAdmission(
			Date.now() + 1_000,
			selectedInternalModel,
			firstTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(cancelledAdmission, firstTurn)).toBe(true);
		expect(value.registerTurn(cancelledAdmission, firstTurn)).toBe(true);
		admitTurn(value, otherTurn);
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
		expect(value.registerTurn(cancelledAdmission, firstTurn)).toBe(false);
		expect(value.recognizeTurn(cancelledAdmission, firstTurn)).toBe(false);
		const reused = value.beginTurnAdmission(
			Date.now() + 1_000,
			selectedInternalModel,
			firstTurn.threadId,
			"high",
		);
		expect(value.recognizeTurn(reused, firstTurn)).toBe(false);
		expect(value.registerTurn(reused, firstTurn)).toBe(false);

		admitTurn(value, laterTurn);
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

it("revokes late admission before draining only the target Thread", async () => {
	const responses: import("node:http").ServerResponse[] = [];
	const closed: boolean[] = [];
	const target = await listen(
		createServer((_req, res) => {
			const i = responses.length;
			responses.push(res);
			closed.push(false);
			res.once("close", () => {
				closed[i] = true;
			});
			if (i === 0) {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(event({ type: "response.created", response: {} }));
			}
		}),
	);
	const value = await transport(target);
	const other = {
		threadId: "independent-thread",
		turnId: defaultNativeTurn.turnId,
	};
	admitTurn(value, other);
	const first = await request(value.modelAccess);
	const second = request(value.modelAccess, {}, other);
	await vi.waitFor(() => expect(responses).toHaveLength(2));
	value.revokeTurn(defaultNativeTurn);
	expect(closed).toEqual([false, false]);
	const late = await request(value.modelAccess);
	expect(late.status).toBe(409);
	expect(responses).toHaveLength(2);
	expect(closed).toEqual([false, false]);
	await value.cancelTurn(defaultNativeTurn);
	await vi.waitFor(() => expect(closed[0]).toBe(true));
	expect(closed[1]).toBe(false);
	responses[1]?.writeHead(200, { "content-type": "text/event-stream" });
	responses[1]?.end(completedEvent());
	expect(await (await second).text()).toContain("response.completed");
	await first.body?.cancel().catch(() => {});
});

it("fences an admitted request whose body completes after revocation", async () => {
	let calls = 0;
	const target = await listen(
		createServer((_req, res) => {
			calls++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(completedEvent());
		}),
	);
	const value = await transport(target);
	let reading!: () => void;
	const bodyReading = new Promise<void>((resolve) => {
		reading = resolve;
	});
	const iterate = IncomingMessage.prototype[Symbol.asyncIterator];
	const spy = vi
		.spyOn(IncomingMessage.prototype, Symbol.asyncIterator)
		.mockImplementation(function (this: IncomingMessage) {
			if (this.url === "/responses") reading();
			return iterate.call(this);
		});
	const body = JSON.stringify({ model: selectedInternalModel });
	const client = httpRequest(`${value.modelAccess.endpoint}/responses`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${value.modelAccess.credential}`,
			"content-length": Buffer.byteLength(body),
			"x-client-request-id": defaultNativeTurn.threadId,
			"x-codex-turn-metadata": JSON.stringify({
				thread_id: defaultNativeTurn.threadId,
				turn_id: defaultNativeTurn.turnId,
			}),
		},
	});
	const received = new Promise<number | undefined>((resolve, reject) => {
		client.once("response", (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode));
		});
		client.once("error", reject);
	});
	try {
		client.write(body.slice(0, 1));
		await bodyReading;
		value.revokeTurn(defaultNativeTurn);
		client.end(body.slice(1));
		expect(await received).toBe(409);
		expect(calls).toBe(0);
	} finally {
		spy.mockRestore();
		client.destroy();
	}
});
