import { expect, it, vi } from "vitest";
import {
	openRuntimeMessagesTransport,
	type RuntimeMessagesTransportDiagnostic,
} from "./messages-model-transport.js";

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
						? stream.replace(
								'event: message_stop\ndata: {"type":"message_stop"}\n\n',
								'event: error\ndata: {"type":"error","error":{"message":"synthetic-provider-error"}}\n\n' +
									'event: message_stop\ndata: {"type":"message_stop"}\n\n',
							)
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

it("completes when the provider keeps the HTTP stream open after message_stop", async () => {
	const stream = messages(["O", "K"]);
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
						controller.enqueue(new TextEncoder().encode(stream));
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
		expect(await response.text()).toContain('"type":"message_stop"');
		expect(transport.failure()).toBeUndefined();
	} finally {
		await transport.close();
	}
});

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
	const diagnostics: RuntimeMessagesTransportDiagnostic[] = [];
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test/team",
		credential: "synthetic-provider-credential",
		authentication: "api-key",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {
			admitted = true;
		},
		receipt: async (_state, _endTurn, diagnostic) => {
			if (diagnostic) diagnostics.push(diagnostic);
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
		expect(diagnostics.at(-1)).toMatchObject({
			stage: "upstream_http",
			sent: true,
			statusCode: 400,
			statusClass: "4xx",
		});
	} finally {
		await transport.close();
	}
});

it("records a bounded content-type diagnostic without exposing upstream data", async () => {
	const diagnostics: RuntimeMessagesTransportDiagnostic[] = [];
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-provider-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		receipt: async (_state, _endTurn, diagnostic) => {
			if (diagnostic) diagnostics.push(diagnostic);
		},
		fetch: async () =>
			new Response("synthetic-provider-secret", {
				status: 200,
				headers: { "content-type": "application/json" },
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
		const body = await response.text();
		expect(body).not.toContain("synthetic-provider-secret");
		expect(transport.failure()).toBe("unknown");
		expect(diagnostics.at(-1)).toMatchObject({
			stage: "upstream_content_type",
			sent: true,
		});
		expect(diagnostics.at(-1)).not.toHaveProperty("statusCode");
	} finally {
		await transport.close();
	}
});

it("resolves a request-local execution credential immediately before upstream I/O", async () => {
	let resolved = 0;
	let upstreamCredential = "";
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test/team",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		resolveCredential: async () => {
			resolved += 1;
			return "synthetic-execution-key";
		},
		admit: async () => {},
		fetch: async (_url, init) => {
			upstreamCredential =
				new Headers(init?.headers).get("authorization") ?? "";
			return new Response(messages(["ok"]), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		const response = await fetch(
			`${transport.modelAccess.endpoint}/v1/messages`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
					"content-type": "application/json",
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
		expect(resolved).toBe(1);
		expect(upstreamCredential).toBe("Bearer synthetic-execution-key");
	} finally {
		await transport.close();
	}
});

it.each([200, 404, 501, 401])(
	"contains token-count responses with status %s",
	async (status) => {
		let admitted = false;
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {
				admitted = true;
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
					},
					body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
				},
			);
			expect(admitted).toBe(true);
			expect(await response.text()).not.toContain("synthetic-provider");
			expect(transport.failure()).toBeDefined();
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

it.each(["admission", "unknown-beta"])(
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

it("refreshes the OpenCode execution key when a native ACP session is reused", async () => {
	let admissions = 0;
	let resolutions = 0;
	const upstreamCredentials: string[] = [];
	const transport = await openRuntimeMessagesTransport({
		client: "opencode",
		endpoint: "https://model.example.test",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {
			admissions++;
		},
		resolveCredential: async () => `synthetic-execution-key-${++resolutions}`,
		fetch: async (_url, init) => {
			upstreamCredentials.push(
				new Headers(init?.headers).get("authorization") ?? "",
			);
			return new Response(messages(["ok"]), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const request = () =>
		fetch(`${transport.modelAccess.endpoint}/v1/messages`, {
			method: "POST",
			headers: { "x-api-key": transport.modelAccess.credential },
			body: JSON.stringify({
				model: "claude-opus-5",
				output_config: { effort: "high" },
				thinking: { type: "adaptive" },
				stream: true,
				messages: [],
			}),
		});
	try {
		expect((await request()).ok).toBe(true);
		transport.beginTurn();
		expect((await request()).ok).toBe(true);
		expect(admissions).toBe(2);
		expect(resolutions).toBe(2);
		expect(upstreamCredentials).toEqual([
			"Bearer synthetic-execution-key-1",
			"Bearer synthetic-execution-key-2",
		]);
	} finally {
		await transport.close();
	}
});

it.each(["allowed", "no-permit", "intent-failed", "revoked", "unknown"])(
	"gates each auxiliary request before upstream send: %s",
	async (scenario) => {
		const order: string[] = [];
		let sends = 0;
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openRequest: async (purpose) => {
				order.push(purpose);
				if (scenario === "no-permit" || scenario === "intent-failed")
					throw Error();
				order.push("intent");
				return {
					resolveCredential: async () => {
						order.push("current-key");
						if (scenario === "revoked") throw Error();
						return "synthetic-provider-credential";
					},
					receipt: async (phase, _end, diagnostic) => {
						order.push(phase);
						if (phase === "completed")
							expect(diagnostic?.usage).toEqual({
								inputTokens: 10,
								outputTokens: 2,
							});
					},
				};
			},
			fetch: async () => {
				sends++;
				order.push("fetch");
				if (scenario === "unknown") throw Error();
				return new Response(messages(["synthetic auxiliary answer"]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const invoke = () =>
				fetch(transport.modelAccess.endpoint + "/v1/messages", {
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
					},
					body: JSON.stringify({
						model: "claude-opus-5",
						messages: [],
						stream: true,
						output_config: { effort: "high" },
						thinking: { type: "disabled" },
						tools: [],
					}),
				});
			const response = await invoke();
			await response.text();
			if (scenario === "allowed") {
				expect(sends).toBe(1);
				expect(order).toEqual([
					"web-fetch",
					"intent",
					"current-key",
					"sent",
					"fetch",
					"completed",
				]);
			} else if (scenario === "unknown") {
				expect(sends).toBe(1);
				expect(transport.failure()).toBe("unknown");
				await (await invoke()).text();
				expect(sends).toBe(1);
			} else {
				expect(sends).toBe(0);
				expect(transport.failure()).toBe("failed");
			}
		} finally {
			await transport.close();
		}
	},
);

it.each([
	"valid",
	"foreign-id",
	"truncated",
	"credential",
	"unexpected-block",
	"provider-unavailable",
	"unknown-provider-error",
])(
	"validates the exact provider search response lifecycle: %s",
	async (scenario) => {
		const base = messages(["search result"]);
		const prefix = base.slice(0, base.indexOf("event: content_block_start"));
		const resultId =
			scenario === "foreign-id" ? "srvtoolu_foreign" : "srvtoolu_search";
		const events = [
			{
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "server_tool_use",
					id: "srvtoolu_search",
					name: scenario === "unexpected-block" ? "other" : "web_search",
					input: {},
				},
			},
			{
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: '{"query":"synthetic"}',
				},
			},
			{ type: "content_block_stop", index: 0 },
			{
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "web_search_tool_result",
					tool_use_id: resultId,
					content: [
						{
							type: "web_search_result",
							url: "https://fixture.invalid",
							title:
								scenario === "credential"
									? "synthetic-provider-credential"
									: "synthetic",
							encrypted_content: "encrypted",
						},
					],
				},
			},
			{ type: "content_block_stop", index: 1 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 3 },
			},
			{ type: "message_stop" },
		];
		if (
			scenario === "provider-unavailable" ||
			scenario === "unknown-provider-error"
		) {
			const result = events[3] as { content_block: { content: unknown } };
			result.content_block.content = {
				type: "web_search_tool_result_error",
				error_code:
					scenario === "provider-unavailable" ? "unavailable" : "arbitrary",
			};
		}
		let stream =
			prefix +
			events
				.map(
					(event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
				)
				.join("");
		if (scenario === "truncated")
			stream = stream.slice(0, stream.lastIndexOf("event: message_stop"));
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openRequest: async (purpose) => {
				expect(purpose).toBe("web-search");
				return {};
			},
			fetch: async () =>
				new Response(stream, {
					headers: { "content-type": "text/event-stream" },
				}),
		});
		try {
			const response = await fetch(
				transport.modelAccess.endpoint + "/v1/messages",
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
					},
					body: JSON.stringify({
						model: "claude-opus-5",
						messages: [],
						stream: true,
						output_config: { effort: "high" },
						thinking: { type: "disabled" },
						tools: [{ type: "web_search_20250305", name: "web_search" }],
						tool_choice: { type: "tool", name: "web_search" },
					}),
				},
			);
			const text = await response.text();
			expect(text).not.toContain("synthetic-provider-credential");
			if (scenario === "valid" || scenario === "provider-unavailable") {
				expect(text).toContain("web_search_tool_result");
				expect(transport.failure()).toBeUndefined();
			} else {
				expect(transport.failure()).toBe("unknown");
				expect(text).not.toContain("event: message_stop");
			}
		} finally {
			await transport.close();
		}
	},
);

it.each([401, 403, 429, 500])(
	"seals an auxiliary authorization or uncertain provider failure without fallback: %s",
	async (status) => {
		let sends = 0;
		const receipts: string[] = [];
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openRequest: async () => ({
				receipt: async (phase) => {
					receipts.push(phase);
				},
			}),
			fetch: async () => {
				sends++;
				return new Response("private-provider-body", { status });
			},
		});
		try {
			const send = (thinking: string) =>
				fetch(transport.modelAccess.endpoint + "/v1/messages", {
					method: "POST",
					headers: {
						authorization: `Bearer ${transport.modelAccess.credential}`,
					},
					body: JSON.stringify({
						model: "claude-opus-5",
						stream: true,
						messages: [],
						thinking: { type: thinking },
						output_config: { effort: "high" },
						tools: [],
					}),
				});
			const response = await send("disabled");
			expect(await response.text()).not.toContain("private-provider-body");
			await (await send("adaptive")).text();
			expect(sends).toBe(1);
			expect(receipts).toEqual(["sent", status >= 500 ? "unknown" : "failed"]);
			expect(transport.failure()).toBe(status >= 500 ? "unknown" : "failed");
		} finally {
			await transport.close();
		}
	},
);

it("revalidates after persisted dispatch receipt and before upstream fetch", async () => {
	let current = true;
	let sends = 0;
	const facts: { phase: string; sent: boolean | undefined }[] = [];
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-provider-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		openRequest: async () => ({
			revalidate: () => {
				if (!current) throw Error("revoked");
			},
			receipt: async (phase, _end, diagnostic) => {
				facts.push({ phase, sent: diagnostic?.sent });
				if (phase === "sent") {
					await Promise.resolve();
					current = false;
				}
			},
		}),
		fetch: async () => {
			sends++;
			return new Response(messages(["not reached"]), {
				headers: { "content-type": "text/event-stream" },
			});
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
					messages: [],
					stream: true,
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
				}),
			},
		);
		await response.text();
		expect(sends).toBe(0);
		expect(facts).toEqual([
			{ phase: "sent", sent: false },
			{ phase: "failed", sent: false },
		]);
		expect(transport.failure()).toBe("failed");
	} finally {
		await transport.close();
	}
});

it.each(["credential", "receipt", "request-admission"] as const)(
	"seals every pending request after a concurrent uncertain send at %s",
	async (boundary) => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let ids = 0;
		let sends = 0;
		const facts: { id: number; phase: string; sent: boolean | undefined }[] =
			[];
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openRequest: async () => {
				const id = ++ids;
				const block = async () => {
					entered();
					await held;
				};
				if (id === 1 && boundary === "request-admission") await block();
				return {
					resolveCredential: async () => {
						if (id === 1 && boundary === "credential") await block();
						return "synthetic-provider-credential";
					},
					receipt: async (phase, _end, diagnostic) => {
						facts.push({ id, phase, sent: diagnostic?.sent });
						if (id === 1 && boundary === "receipt" && phase === "sent")
							await block();
					},
				};
			},
			fetch: async () => {
				sends++;
				throw Error("disconnect");
			},
		});
		const invoke = () =>
			fetch(`${transport.modelAccess.endpoint}/v1/messages`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					messages: [],
					stream: true,
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
				}),
			}).then((response) => response.text());
		try {
			const first = invoke();
			await ready;
			await invoke();
			expect(sends).toBe(1);
			expect(transport.failure()).toBe("unknown");
			release();
			await first;
			expect(sends).toBe(1);
			expect(facts.filter((fact) => fact.id === 1).at(-1)).toEqual({
				id: 1,
				phase: "failed",
				sent: false,
			});
			expect(transport.failure()).toBe("unknown");
		} finally {
			release();
			await transport.close();
		}
	},
);

it.each(["abort", "close"] as const)(
	"retires a held credential request on %s without upstream send",
	async (mode) => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let sends = 0;
		const facts: { phase: string; sent: boolean | undefined }[] = [];
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openRequest: async () => ({
				resolveCredential: async () => {
					entered();
					await held;
					return "synthetic-provider-credential";
				},
				receipt: async (phase, _end, diagnostic) => {
					facts.push({ phase, sent: diagnostic?.sent });
				},
			}),
			fetch: async () => {
				sends++;
				return new Response(messages(["never"]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		const controller = new AbortController();
		const request = fetch(`${transport.modelAccess.endpoint}/v1/messages`, {
			method: "POST",
			signal: controller.signal,
			headers: { authorization: `Bearer ${transport.modelAccess.credential}` },
			body: JSON.stringify({
				model: "claude-opus-5",
				messages: [],
				stream: true,
				output_config: { effort: "high" },
				thinking: { type: "adaptive" },
			}),
		})
			.then((response) => response.text())
			.catch(() => undefined);
		try {
			await ready;
			expect(() => transport.beginTurn()).toThrow();
			if (mode === "abort") {
				controller.abort();
				await request;
				await new Promise((resolve) => setTimeout(resolve, 20));
				release();
			} else {
				const closed = transport.close();
				release();
				await closed;
			}
			await request;
			await transport.close();
			expect(sends).toBe(0);
			expect(facts.at(-1)).toEqual({ phase: "failed", sent: false });
		} finally {
			release();
			await transport.close();
		}
	},
);

it.each([500, 401])(
	"seals a non-success upstream response before awaiting its failure receipt: %s",
	async (status) => {
		let releaseCredential = () => {};
		const credentialHeld = new Promise<void>((resolve) => {
			releaseCredential = resolve;
		});
		let credentialEntered = () => {};
		const credentialReady = new Promise<void>((resolve) => {
			credentialEntered = resolve;
		});
		let releaseReceipt = () => {};
		const receiptHeld = new Promise<void>((resolve) => {
			releaseReceipt = resolve;
		});
		let failureEntered = () => {};
		const failureReady = new Promise<void>((resolve) => {
			failureEntered = resolve;
		});
		let requests = 0;
		let sends = 0;
		const facts: { id: number; phase: string; sent: boolean | undefined }[] =
			[];
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openRequest: async () => {
				const id = ++requests;
				return {
					resolveCredential: async () => {
						if (id === 1) {
							credentialEntered();
							await credentialHeld;
						}
						return "synthetic-provider-credential";
					},
					receipt: async (phase, _end, diagnostic) => {
						facts.push({ id, phase, sent: diagnostic?.sent });
						if (id === 2 && phase !== "sent") {
							failureEntered();
							await receiptHeld;
						}
					},
				};
			},
			fetch: async () => {
				sends++;
				return new Response("synthetic rejected", { status });
			},
		});
		const invoke = () =>
			fetch(`${transport.modelAccess.endpoint}/v1/messages`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${transport.modelAccess.credential}`,
				},
				body: JSON.stringify({
					model: "claude-opus-5",
					messages: [],
					stream: true,
					output_config: { effort: "high" },
					thinking: { type: "adaptive" },
				}),
			}).then((response) => response.text());
		let first: Promise<string> | undefined;
		let second: Promise<string> | undefined;
		try {
			first = invoke();
			await credentialReady;
			second = invoke();
			await failureReady;
			releaseCredential();
			await first;
			expect(sends).toBe(1);
			expect(transport.failure()).toBe(status === 500 ? "unknown" : "failed");
			expect(facts.filter((fact) => fact.id === 1).at(-1)).toEqual({
				id: 1,
				phase: "failed",
				sent: false,
			});
			releaseReceipt();
			await second;
			expect(transport.failure()).toBe(status === 500 ? "unknown" : "failed");
		} finally {
			releaseCredential();
			releaseReceipt();
			await Promise.allSettled([first, second]);
			await transport.close();
		}
	},
);

async function diagnosticRequest(
	transport: Awaited<ReturnType<typeof openRuntimeMessagesTransport>>,
	counting = false,
) {
	const response = await fetch(
		`${transport.modelAccess.endpoint}/v1/messages${counting ? "/count_tokens" : ""}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${transport.modelAccess.credential}` },
			body: JSON.stringify({
				model: "claude-opus-5",
				messages: [],
				...(counting
					? {}
					: {
							output_config: { effort: "high" },
							thinking: { type: "adaptive" },
							stream: true,
						}),
			}),
		},
	);
	return { status: response.status, text: await response.text() };
}

it.each(["factory-throw", "sink-reject", "sink-hang"])(
	"diagnostic %s cannot change a successful response or block close",
	async (mode) => {
		let sends = 0;
		let observations = 0;
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {},
			openDiagnosticReceipt: () => {
				if (mode === "factory-throw") throw Error("synthetic-private-failure");
				return async () => {
					observations++;
					if (mode === "sink-reject") throw Error("synthetic-private-failure");
					await new Promise<void>(() => {});
				};
			},
			fetch: async () => {
				sends++;
				return new Response(messages(["OK"]), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const response = await diagnosticRequest(transport);
			expect(response.status).toBe(200);
			expect(response.text).toContain('"type":"message_stop"');
			expect(response.text).not.toContain("synthetic-private");
			expect(sends).toBe(1);
			expect(transport.failure()).toBeUndefined();
			expect(observations).toBe(mode === "factory-throw" ? 0 : 2);
			await transport.close();
		} finally {
			await transport.close();
		}
	},
);

it("bounds detached diagnostic work and never associates count_tokens with a Turn", async () => {
	let opens = 0;
	let pending = 0;
	let sends = 0;
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-provider-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		openDiagnosticReceipt: () => {
			opens++;
			return async () => {
				pending++;
				await new Promise<void>(() => {});
			};
		},
		fetch: async (url) => {
			sends++;
			return String(url).includes("count_tokens")
				? new Response('{"input_tokens":3}', {
						headers: { "content-type": "application/json" },
					})
				: new Response(messages(["OK"]), {
						headers: { "content-type": "text/event-stream" },
					});
		},
	});
	try {
		expect((await diagnosticRequest(transport, true)).status).toBe(200);
		expect(opens).toBe(0);
		for (let index = 0; index < 12; index++)
			expect((await diagnosticRequest(transport)).status).toBe(200);
		expect(sends).toBe(13);
		expect(opens).toBe(12);
		expect(pending).toBe(16);
		expect(transport.failure()).toBeUndefined();
	} finally {
		await transport.close();
	}
});

it("freezes the diagnostic sink at HTTP start without increasing the original one-request limit", async () => {
	let current = "original";
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const events: { binding: string; state: string }[] = [];
	let sends = 0;
	const transport = await openRuntimeMessagesTransport({
		endpoint: "https://model.example.test",
		credential: "synthetic-provider-credential",
		authentication: "bearer",
		model: "claude-opus-5",
		effort: "high",
		admit: async () => {},
		openDiagnosticReceipt: () => {
			const binding = current;
			return async (state) => {
				events.push({ binding, state });
			};
		},
		fetch: async () => {
			sends++;
			entered();
			await held;
			return new Response(messages(["OK"]), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const first = diagnosticRequest(transport);
	try {
		await ready;
		current = "following";
		expect((await diagnosticRequest(transport)).status).toBe(400);
		expect(sends).toBe(1);
		release();
		expect((await first).status).toBe(200);
		expect(events).toEqual([
			{ binding: "original", state: "sent" },
			{ binding: "original", state: "completed" },
		]);
		transport.beginTurn();
		expect((await diagnosticRequest(transport)).status).toBe(200);
		expect(events.slice(2)).toEqual([
			{ binding: "following", state: "sent" },
			{ binding: "following", state: "completed" },
		]);
	} finally {
		release();
		await first;
		await transport.close();
	}
});

it.each(["request", "admission", "credential", "transport", "abort"] as const)(
	"observes the %s failure without changing sending or unknown semantics",
	async (stage) => {
		const diagnostics: RuntimeMessagesTransportDiagnostic[] = [];
		let sends = 0;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const transport = await openRuntimeMessagesTransport({
			endpoint: "https://model.example.test",
			credential: "synthetic-provider-credential",
			authentication: "bearer",
			model: "claude-opus-5",
			effort: "high",
			admit: async () => {
				if (stage === "admission") throw Error("synthetic-private-admission");
			},
			...(stage === "credential"
				? {
						resolveCredential: async () => {
							throw Error("synthetic-private-key");
						},
					}
				: {}),
			openDiagnosticReceipt: () => async (_state, _end, diagnostic) => {
				diagnostics.push(diagnostic);
			},
			fetch: async (_url, options) => {
				sends++;
				started();
				if (stage === "transport")
					throw Error("https://synthetic-key@private.invalid");
				return new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(Error("synthetic abort")),
						{ once: true },
					);
				});
			},
		});
		const controller = new AbortController();
		const request = fetch(`${transport.modelAccess.endpoint}/v1/messages`, {
			method: "POST",
			signal: controller.signal,
			headers: { authorization: `Bearer ${transport.modelAccess.credential}` },
			body:
				stage === "request"
					? "not-json"
					: JSON.stringify({
							model: "claude-opus-5",
							messages: [],
							stream: true,
							thinking: { type: "adaptive" },
							output_config: { effort: "high" },
						}),
		})
			.then((response) => response.text())
			.catch(() => "");
		try {
			if (stage === "abort") {
				await ready;
				controller.abort();
			}
			const body = await request;
			await vi.waitFor(() => expect(diagnostics.at(-1)?.stage).toBe(stage));
			expect(diagnostics.at(-1)?.sent).toBe(
				stage === "transport" || stage === "abort",
			);
			expect(sends).toBe(stage === "transport" || stage === "abort" ? 1 : 0);
			expect(transport.failure()).toBe(
				stage === "transport" || stage === "abort" ? "unknown" : "failed",
			);
			expect(JSON.stringify(diagnostics) + body).not.toMatch(
				/synthetic-private|synthetic-key|private.invalid/,
			);
		} finally {
			controller.abort();
			await request;
			await transport.close();
		}
	},
);
