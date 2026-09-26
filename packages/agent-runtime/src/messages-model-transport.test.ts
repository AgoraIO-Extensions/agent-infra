import { expect, it } from "vitest";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";

it("admits Pi tool execution only after the token-protected intent callback", async () => {
	const requests: { toolCallId: string; name: string }[] = [];
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-model-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		client: "pi",
		toolRequestStarted: async (tool) => {
			requests.push(tool);
		},
	});
	try {
		const body = JSON.stringify({ toolCallId: "tool-1", name: "read" });
		const denied = await fetch(transport.toolPermit.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(denied.status).toBe(400);
		const admitted = await fetch(transport.toolPermit.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": transport.toolPermit.credential,
			},
			body,
		});
		expect(admitted.status).toBe(204);
		expect(requests).toEqual([
			{ toolCallId: "tool-1", name: "read", executionBoundary: true },
		]);
	} finally {
		await transport.close();
	}
});

function messages(text: string[]) {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_synthetic",
				type: "message",
				role: "assistant",
				model: "claude-opus-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		},
		...text.map((text) => ({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		})),
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	]
		.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
		.join("");
}

it.each(["completed", "failed", "unknown"])(
	"keeps confirmed count failure separate from a %s generation and its tool boundary",
	async (generation) => {
		const receipts: {
			state: string;
			request: string | undefined;
			usage: unknown;
		}[] = [];
		let requests = 0;
		let tools = 0;
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			toolRequestStarted: async () => {
				tools++;
			},
			receipt: async (state, _endTurn, usage, request) => {
				receipts.push({ state, request, usage });
			},
			fetch: async (url) => {
				requests++;
				if (String(url).includes("count_tokens"))
					return new Response("", { status: 403 });
				if (generation === "unknown") throw Error("Synthetic response lost");
				return generation === "failed"
					? new Response("", { status: 403 })
					: new Response(messages(["OK"]), {
							headers: { "content-type": "text/event-stream" },
						});
			},
		});
		try {
			const request = (counting: boolean) =>
				fetch(
					`${transport.modelAccess.endpoint}/v1/messages${counting ? "/count_tokens" : ""}`,
					{
						method: "POST",
						headers: {
							authorization: `Bearer ${transport.modelAccess.credential}`,
						},
						body: JSON.stringify({
							model: "claude-opus-5",
							messages: [],
							...(!counting
								? {
										stream: true,
										thinking: { type: "adaptive" },
										output_config: { effort: "high" },
									}
								: {}),
						}),
					},
				);
			const tool = () =>
				fetch(transport.toolPermit.endpoint, {
					method: "POST",
					headers: { "x-api-key": transport.toolPermit.credential },
					body: JSON.stringify({ toolCallId: "call-one", name: "read" }),
				});
			const count = await request(true);
			expect(count.ok).toBe(false);
			await count.text();
			expect(transport.failure()).toBeUndefined();
			expect(receipts).toEqual([
				{ state: "sent", request: "count_tokens", usage: undefined },
				{ state: "failed", request: "count_tokens", usage: undefined },
			]);
			expect((await tool()).status).toBe(204);
			expect(tools).toBe(1);
			const generated = await request(false);
			await generated.text();
			expect(generated.ok).toBe(generation === "completed");
			expect(requests).toBe(2);
			expect(transport.failure()).toBe(
				generation === "completed" ? undefined : generation,
			);
			expect(receipts.at(-1)).toMatchObject({
				state: generation,
				request: "messages",
			});
			if (generation === "completed")
				expect(receipts.at(-1)?.usage).toEqual({
					inputTokens: 10,
					outputTokens: 2,
				});
			else {
				expect((await tool()).ok).toBe(false);
				expect(tools).toBe(1);
			}
		} finally {
			await transport.close();
		}
	},
);

it("forwards Messages usage without inventing missing counters", async () => {
	const receipts: unknown[] = [];
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-model-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		receipt: async (state, _endTurn, usage) => {
			if (state === "completed") receipts.push(usage);
		},
		fetch: async () =>
			new Response(messages(["OK"]), {
				headers: { "content-type": "text/event-stream" },
			}),
	});
	try {
		const response = await fetch(
			`${transport.modelAccess.endpoint}/v1/messages`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
					stream: true,
					messages: [],
				}),
			},
		);
		await response.text();
		expect(receipts).toEqual([{ inputTokens: 10, outputTokens: 2 }]);
	} finally {
		await transport.close();
	}
});

it.each(["valid", "credential", "late-error", "incomplete"])(
	"forwards a %s Messages stream with errors contained before native persistence",
	async (scenario) => {
		const stream = messages(
			scenario === "credential"
				? ["synthetic-provider-", "credential"]
				: ["O", "K"],
		);
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			fetch: async () =>
				new Response(
					scenario === "late-error"
						? `${stream}event: error\ndata: {"type":"error","error":{"message":"synthetic-provider-error"}}\n\n`
						: scenario === "incomplete"
							? stream.slice(0, -1)
							: stream,
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		try {
			const response = await fetch(
				`${transport.modelAccess.endpoint}/v1/messages`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
					},
					body: JSON.stringify({
						model: "claude-opus-5",
						output_config: { effort: "high" },
						thinking: { type: "adaptive" },
						stream: true,
						messages: [],
					}),
				},
			);
			const body = await response.text();
			if (scenario === "valid") {
				expect(body).toContain('"text":"O"');
				expect(body).toContain('"type":"message_stop"');
				expect(transport.failure()).toBeUndefined();
			} else {
				expect(body).not.toContain('"type":"message_stop"');
				expect(transport.failure()).toBe("unknown");
			}
			expect(body).not.toContain("synthetic-provider");
		} finally {
			await transport.close();
		}
	},
);

it.each(["valid", "credential"])(
	"checks the initial thinking signature together with its deltas: %s",
	async (scenario) => {
		const initial =
			scenario === "credential" ? "synthetic-provider-" : "signed-";
		const suffix = scenario === "credential" ? "credential" : "thinking";
		const values = [
			{
				type: "message_start",
				message: {
					id: "msg_synthetic",
					type: "message",
					role: "assistant",
					model: "claude-opus-5",
					content: [],
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "", signature: initial },
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: suffix },
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 2 },
			},
			{ type: "message_stop" },
		];
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			fetch: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (const value of values)
								controller.enqueue(
									new TextEncoder().encode(
										`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`,
									),
								);
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		});
		try {
			const response = await fetch(
				`${transport.modelAccess.endpoint}/v1/messages`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
					},
					body: JSON.stringify({
						model: "claude-opus-5",
						output_config: { effort: "high" },
						thinking: { type: "adaptive" },
						stream: true,
						messages: [],
					}),
				},
			);
			const body = await response.text();
			if (scenario === "valid") {
				expect(body).toContain(`"signature":"${initial}"`);
				expect(body).toContain(`"signature":"${suffix}"`);
				expect(body).toContain('"type":"message_stop"');
				expect(transport.failure()).toBeUndefined();
			} else {
				expect(body).not.toContain(initial);
				expect(body).not.toContain('"type":"message_stop"');
				expect(transport.failure()).toBe("unknown");
			}
		} finally {
			await transport.close();
		}
	},
);

it("admits the bound option before sending and prevents a native retry after a provider error", async () => {
	let admitted = false;
	let calls = 0;
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test/team",
		credential: "synthetic-provider-credential",
		authentication: "api-key",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {
			admitted = true;
		},
		fetch: async (url, init) => {
			expect(admitted).toBe(true);
			expect(url).toBe("https://model.example.test/team/v1/messages?beta=true");
			expect(new Headers(init?.headers).get("x-api-key")).toBe(
				"synthetic-provider-credential",
			);
			calls++;
			return new Response(
				"synthetic-provider-error synthetic-provider-credential",
				{ status: 400 },
			);
		},
	});
	try {
		const request = () =>
			fetch(`${transport.modelAccess.endpoint}/v1/messages?beta=true`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
					stream: true,
					messages: [{ role: "user", content: "synthetic prompt" }],
				}),
			});
		expect(await (await request()).text()).not.toContain("synthetic-provider");
		expect(await (await request()).text()).not.toContain("synthetic-provider");
		expect(calls).toBe(1);
		expect(transport.failure()).toBe("failed");
	} finally {
		await transport.close();
	}
});

it.each([200, 404, 501, 401])(
	"contains token-count responses with status %s",
	async (status) => {
		let admitted = false;
		const receipts: string[] = [];
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {
				admitted = true;
			},
			receipt: async (state) => {
				receipts.push(state);
			},
			fetch: async () =>
				new Response(
					status === 200
						? '{"input_tokens":100,"diagnostic":"synthetic-provider-credential"}'
						: "synthetic-provider-error",
					{ status },
				),
		});
		try {
			const response = await fetch(
				`${transport.modelAccess.endpoint}/v1/messages/count_tokens`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
						"anthropic-beta": "token-counting-2024-11-01",
					},
					body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
				},
			);
			expect(admitted).toBe(true);
			expect(await response.text()).not.toContain("synthetic-provider");
			expect(transport.failure()).toBeUndefined();
			expect(receipts).toEqual([
				"sent",
				status === 404 || status === 401 ? "failed" : "unknown",
			]);
		} finally {
			await transport.close();
		}
	},
);

it("does not deliver escaped credentials in streamed tool arguments to the native process", async () => {
	const values = [
		{
			type: "message_start",
			message: {
				id: "msg_synthetic",
				type: "message",
				role: "assistant",
				model: "claude-opus-5",
				content: [],
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "tool_use",
				id: "tool_synthetic",
				name: "Write",
				input: {},
			},
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: '{"content":"synthetic-provi',
			},
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: 'der-\\u0063redential"}',
			},
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 10 },
		},
		{ type: "message_stop" },
	];
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-provider-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		fetch: async () =>
			new Response(
				values
					.map((v) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
	try {
		const response = await fetch(
			`${transport.modelAccess.endpoint}/v1/messages`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
					stream: true,
					messages: [],
				}),
			},
		);
		const body = await response.text();
		expect(body).not.toContain("synthetic-provi");
		expect(transport.failure()).toBe("unknown");
	} finally {
		await transport.close();
	}
});

it.each(["admission", "unknown-beta", "durable-intent"])(
	"blocks count_tokens before upstream side effects on %s failure",
	async (reason) => {
		let requests = 0;
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {
				if (reason === "admission")
					throw Error("synthetic persistence failure");
			},
			beforeSend: async () => {
				if (reason === "durable-intent")
					throw Error("synthetic intent persistence failure");
			},
			fetch: async () => {
				requests++;
				return new Response('{"input_tokens":3}');
			},
		});
		try {
			const response = await fetch(
				`${transport.modelAccess.endpoint}/v1/messages/count_tokens`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
						...(reason === "unknown-beta"
							? { "anthropic-beta": "unverified-capability" }
							: {}),
					},
					body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
				},
			);
			expect(response.ok).toBe(false);
			expect(requests).toBe(0);
		} finally {
			await transport.close();
		}
	},
);

it("contains persistent receipt failures without an upstream retry or unhandled rejection", async () => {
	let requests = 0;
	let writes = 0;
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		receipt: async () => {
			writes++;
			throw Error("synthetic storage failure");
		},
		fetch: async () => {
			requests++;
			return new Response();
		},
	});
	try {
		const response = await fetch(
			`${transport.modelAccess.endpoint}/v1/messages`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
					stream: true,
					messages: [],
				}),
			},
		);
		expect(response.ok).toBe(false);
		expect(await response.text()).not.toContain("synthetic");
		expect(requests).toBe(0);
		expect(writes).toBe(2);
		expect(transport.failure()).toBe("unknown");
	} finally {
		await transport.close();
	}
});

it("blocks a second model request when its durable intent cannot be prepared", async () => {
	let preparations = 0;
	let upstreamRequests = 0;
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		beforeSend: async () => {
			preparations++;
			if (preparations === 2)
				throw Error("synthetic intent persistence failure");
		},
		fetch: async () => {
			upstreamRequests++;
			return new Response(messages(["OK"]), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		const request = () =>
			fetch(`${transport.modelAccess.endpoint}/v1/messages`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
					stream: true,
					messages: [],
				}),
			});
		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(400);
		expect(preparations).toBe(2);
		expect(upstreamRequests).toBe(1);
	} finally {
		await transport.close();
	}
});

it.each([
	"completed",
	"failed",
	"unknown",
	"malformed",
	"started-write",
	"result-write",
])(
	"records count_tokens %s without treating the estimate as billed usage or retrying",
	async (outcome) => {
		const phases: string[] = [];
		let requests = 0;
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			beforeSend: async (request) => {
				phases.push(`intent:${request}`);
			},
			started: async (request) => {
				phases.push(`started:${request}`);
				if (outcome === "started-write") throw Error("synthetic write failure");
			},
			receipt: async (state, endTurn, usage, request) => {
				expect(endTurn).toBeUndefined();
				expect(usage).toBeUndefined();
				phases.push(`${state}:${request}`);
				if (state === "completed" && outcome === "result-write")
					throw Error("synthetic write failure");
			},
			fetch: async () => {
				requests++;
				expect(phases).toEqual(["intent:count_tokens", "sent:count_tokens"]);
				if (outcome === "unknown") throw Error("synthetic lost response");
				return new Response(
					outcome === "malformed"
						? '{"input_tokens":-1}'
						: '{"input_tokens":123}',
					{ status: outcome === "failed" ? 400 : 200 },
				);
			},
		});
		try {
			const request = () =>
				fetch(`${transport.modelAccess.endpoint}/v1/messages/count_tokens`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
						"anthropic-beta": "token-counting-2024-11-01",
					},
					body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
				});
			const response = await request();
			expect(response.ok).toBe(outcome === "completed");
			if (outcome === "completed")
				expect(await response.json()).toEqual({ input_tokens: 123 });
			else if (outcome !== "failed") expect((await request()).ok).toBe(false);
			expect(transport.failure()).toBeUndefined();
			expect(requests).toBe(1);
			expect(phases).toEqual([
				"intent:count_tokens",
				"sent:count_tokens",
				"started:count_tokens",
				...(outcome === "result-write" ? ["completed:count_tokens"] : []),
				`${outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "unknown"}:count_tokens`,
			]);
		} finally {
			await transport.close();
		}
	},
);
