import { expect, it } from "vitest";
import { openClaudeModelTransport } from "./claude-model-transport.js";

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
		const transport = await openClaudeModelTransport({
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
		const transport = await openClaudeModelTransport({
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
	const transport = await openClaudeModelTransport({
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
		const transport = await openClaudeModelTransport({
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
	const transport = await openClaudeModelTransport({
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
		const transport = await openClaudeModelTransport({
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
	const transport = await openClaudeModelTransport({
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
