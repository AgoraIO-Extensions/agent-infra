import { expect, it, vi } from "vitest";
import { catalogFixture } from "./catalog.fixture.js";
import { ModelEndpointV1Schema } from "./catalog.js";
import {
	createMessagesModelAccessValidatorV1,
	probeMessagesModelV1,
} from "./messages-access.js";
import { messagesStreamFixture } from "./messages-stream.fixture.js";

it.each(["api-key", "bearer"])(
	"preflights Messages with explicit %s authentication, tool completion and each effort",
	async (authentication) => {
		const efforts: string[] = [];
		const validator = createMessagesModelAccessValidatorV1({
			fetch: async (url, init) => {
				const headers = new Headers(init?.headers);
				expect(
					headers.get(
						authentication === "bearer" ? "authorization" : "x-api-key",
					),
				).toBe(
					authentication === "bearer"
						? "Bearer synthetic-credential-a"
						: "synthetic-credential-a",
				);
				expect(
					headers.has(
						authentication === "bearer" ? "x-api-key" : "authorization",
					),
				).toBe(false);
				expect(headers.get("anthropic-version")).toBe("2023-06-01");
				expect(headers.get("anthropic-beta")?.split(",")).toContain(
					"fallback-credit-2026-06-01",
				);
				expect(init?.redirect).toBe("error");
				if (String(url).endsWith("/count_tokens?beta=true"))
					return Response.json({ input_tokens: 100 });
				expect(String(url)).toBe(
					"https://models.example.test/team-a/v1/messages?beta=true",
				);
				const request = JSON.parse(String(init?.body));
				expect(request.model).toBe("claude-opus-5");
				expect(request.thinking).toEqual({ type: "adaptive" });
				efforts.push(request.output_config.effort);
				return new Response(messagesStreamFixture(), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		await validator.validate(
			{
				endpoint: ModelEndpointV1Schema.parse({
					...catalogFixture().endpoints[0],
					baseUrl: "https://models.example.test/team-a",
					protocol: "anthropic-messages-v1",
					authentication,
				}),
				modelId: "claude-opus-5",
				reasoningLevels: ["medium", "high"],
				credential: new TextEncoder().encode("synthetic-credential-a"),
			},
			{ signal: AbortSignal.timeout(1000) },
		);
		expect(efforts).toEqual(["medium", "high"]);
	},
);

it.each([
	{ type: undefined },
	{ type: "completion" },
	{ role: "user" },
	{ id: undefined },
	{ id: 1 },
	{ content: undefined },
	{ content: [{ type: "text", text: "unexpected" }] },
	{ usage: undefined },
	{ usage: null },
	{ usage: [] },
])("rejects malformed message_start %j before activation", async (patch) => {
	const validator = createMessagesModelAccessValidatorV1({
		fetch: async (url) =>
			String(url).includes("count_tokens")
				? Response.json({ input_tokens: 100 })
				: new Response(
						messagesStreamFixture({
							id: "msg_conformance",
							type: "message",
							role: "assistant",
							model: "claude-opus-5",
							content: [],
							usage: { input_tokens: 100, output_tokens: 1 },
							...patch,
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
	});
	await expect(
		validator.validate(
			{
				endpoint: ModelEndpointV1Schema.parse({
					...catalogFixture().endpoints[0],
					protocol: "anthropic-messages-v1",
					authentication: "bearer",
				}),
				modelId: "claude-opus-5",
				reasoningLevels: ["high"],
				credential: new TextEncoder().encode("synthetic-credential-a"),
			},
			{ signal: AbortSignal.timeout(1000) },
		),
	).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
});

it.each([
	"error",
	"wrong-model",
	"truncated",
	"missing-tool",
	"tool-arguments",
	"initial-tool-arguments",
	"late-block",
	"oversized",
	"stalled",
	"count-auth",
	"count-invalid",
	"redirect",
	"wrong-protocol",
	"unsupported-effort",
])("rejects %s before activating a Messages option", async (failure) => {
	const validator = createMessagesModelAccessValidatorV1({
		fetch: async (url) => {
			if (String(url).includes("count_tokens")) {
				if (failure === "count-auth")
					return new Response("synthetic-provider-error", { status: 401 });
				return Response.json({
					input_tokens: failure === "count-invalid" ? "100" : 100,
				});
			}
			if (failure === "redirect") return new Response(null, { status: 302 });
			if (failure === "stalled")
				return new Response(new ReadableStream(), {
					headers: { "content-type": "text/event-stream" },
				});
			let body = messagesStreamFixture();
			if (failure === "error")
				body +=
					'event: error\ndata: {"type":"error","error":{"message":"synthetic-provider-error"}}\n\n';
			if (failure === "wrong-model")
				body = body.replace("claude-opus-5", "wrong-model");
			if (failure === "truncated") body = body.slice(0, -1);
			if (failure === "missing-tool")
				body = body.replace("agent_infra_conformance", "different-tool");
			if (failure === "tool-arguments")
				body = body.replace('"partial_json":"{}"', '"partial_json":"[]"');
			if (failure === "initial-tool-arguments")
				body = body.replace('"input":{}', '"input":{"unexpected":true}');
			if (failure === "late-block")
				body = body.replace(
					"event: message_stop",
					'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\nevent: message_stop',
				);
			if (failure === "oversized")
				body = `:${"x".repeat(1_048_576)}\n\n${body}`;
			return new Response(body, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	await expect(
		validator.validate(
			{
				endpoint: ModelEndpointV1Schema.parse({
					...catalogFixture().endpoints[0],
					protocol:
						failure === "wrong-protocol"
							? "openai-responses-v1"
							: "anthropic-messages-v1",
					authentication: "bearer",
					capabilities: {
						streaming: true,
						tools: true,
						reasoningLevels: ["high", "unsupported"],
					},
				}),
				modelId: "claude-opus-5",
				reasoningLevels: [
					failure === "unsupported-effort" ? "unsupported" : "high",
				],
				credential: new TextEncoder().encode("synthetic-credential-a"),
			},
			{ signal: AbortSignal.timeout(100) },
		),
	).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
});

// ADR-0029：保存时用 Agent 默认 Key 对每个模型与档位发一次真实 Messages 请求。
const messagesEndpoint = (authentication: "api-key" | "bearer") =>
	ModelEndpointV1Schema.parse({
		...catalogFixture().endpoints[0],
		baseUrl: "https://models.example.test/team-a",
		protocol: "anthropic-messages-v1",
		authentication,
	});

it.each(["api-key", "bearer"] as const)(
	"verifies one model and level with a single %s Messages request",
	async (authentication) => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(messagesStreamFixture(), {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		await expect(
			probeMessagesModelV1({
				endpoint: messagesEndpoint(authentication),
				credential: "synthetic-credential-a",
				modelId: "claude-opus-5",
				reasoningLevel: "low",
				signal: AbortSignal.timeout(1000),
				fetch: fetcher,
			}),
		).resolves.toBe("verified");
		// 不做 count_tokens 预检，也不受端点登记的档位约束（端点只登记了 medium/high）。
		expect(fetcher).toHaveBeenCalledOnce();
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://models.example.test/team-a/v1/messages?beta=true",
		);
		expect(init?.redirect).toBe("error");
		const headers = new Headers(init?.headers);
		expect(
			authentication === "bearer"
				? headers.get("authorization")
				: headers.get("x-api-key"),
		).toBe(
			authentication === "bearer"
				? "Bearer synthetic-credential-a"
				: "synthetic-credential-a",
		);
		const body = JSON.parse(String(init?.body));
		expect([body.model, body.output_config.effort]).toEqual([
			"claude-opus-5",
			"low",
		]);
	},
);

it.each([
	[401, "key_invalid"],
	[403, "key_invalid"],
	[400, "incompatible"],
	[404, "incompatible"],
	[429, "unavailable"],
	[503, "unavailable"],
] as const)("classifies Messages HTTP %i as %s", async (status, outcome) => {
	await expect(
		probeMessagesModelV1({
			endpoint: messagesEndpoint("bearer"),
			credential: "synthetic-credential-a",
			modelId: "claude-opus-5",
			reasoningLevel: "high",
			signal: AbortSignal.timeout(1000),
			fetch: async () => Response.json({}, { status }),
		}),
	).resolves.toBe(outcome);
});

it("treats a stream without the conformance tool call as incompatible", async () => {
	await expect(
		probeMessagesModelV1({
			endpoint: messagesEndpoint("bearer"),
			credential: "synthetic-credential-a",
			modelId: "claude-opus-5",
			reasoningLevel: "high",
			signal: AbortSignal.timeout(1000),
			fetch: async () =>
				new Response(
					`event: message_start\ndata: ${JSON.stringify({ type: "message_start" })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		}),
	).resolves.toBe("incompatible");
});

it("rejects a level outside the fixed Claude profile without a request", async () => {
	const fetcher = vi.fn<typeof fetch>();
	await expect(
		probeMessagesModelV1({
			endpoint: messagesEndpoint("bearer"),
			credential: "synthetic-credential-a",
			modelId: "claude-opus-5",
			reasoningLevel: "minimal",
			signal: AbortSignal.timeout(1000),
			fetch: fetcher,
		}),
	).resolves.toBe("incompatible");
	expect(fetcher).not.toHaveBeenCalled();
});
