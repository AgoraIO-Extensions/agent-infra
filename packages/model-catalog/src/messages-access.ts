import { createParser } from "eventsource-parser";
import type { ModelAccessValidatorV1 } from "./access.js";
import { validateModelAccessPolicyV1 } from "./access.js";
import { ModelConfigurationErrorV1, modelOperationV1 } from "./catalog.js";

// Fixed Claude SDK 0.3.246 / CLI 2.1.246 Messages profile, also exercised by native conformance.
const betas =
	"claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01";
const efforts = ["low", "medium", "high", "xhigh", "max"];

async function boundedBody(response: Response, signal: AbortSignal) {
	if (!response.body) throw new ModelConfigurationErrorV1();
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let body = "";
	try {
		while (true) {
			const chunk = await modelOperationV1(signal, () => reader.read());
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 1_048_576) throw new ModelConfigurationErrorV1();
			body += decoder.decode(chunk.value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		void reader.cancel().catch(() => {});
	}
}

function verifyCompletion(body: string, model: string) {
	let started = false;
	let stopped = false;
	let toolCompleted = false;
	let stopReason = false;
	const blocks = new Map<number, { tool: boolean; json: string }>();
	const fail = (): never => {
		throw new ModelConfigurationErrorV1();
	};
	const parser = createParser({
		onError: fail,
		onRetry: fail,
		onEvent: ({ data, event }) => {
			const value = JSON.parse(data);
			if (
				stopped ||
				!value ||
				typeof value !== "object" ||
				(event && event !== value.type)
			)
				fail();
			if (value.type === "ping") return;
			if (value.type === "message_start") {
				if (
					started ||
					(value.message?.model !== model &&
						!value.message?.model?.startsWith(`${model}-`))
				)
					fail();
				started = true;
			} else {
				if (!started) fail();
				if (stopReason && value.type !== "message_stop") fail();
				switch (value.type) {
					case "content_block_start":
						if (
							!Number.isInteger(value.index) ||
							value.index < 0 ||
							blocks.has(value.index)
						)
							fail();
						if (
							value.content_block?.type === "tool_use" &&
							JSON.stringify(value.content_block.input) !== "{}"
						)
							fail();
						blocks.set(value.index, {
							tool:
								value.content_block?.type === "tool_use" &&
								value.content_block.name === "agent_infra_conformance",
							json: "",
						});
						break;
					case "content_block_delta": {
						const block = blocks.get(value.index) ?? fail();
						if (value.delta?.type === "input_json_delta") {
							if (typeof value.delta.partial_json !== "string") fail();
							block.json += value.delta.partial_json;
						}
						break;
					}
					case "content_block_stop": {
						const block = blocks.get(value.index) ?? fail();
						if (block?.tool) {
							const args = JSON.parse(block?.json || "{}");
							if (
								!args ||
								Array.isArray(args) ||
								typeof args !== "object" ||
								Object.keys(args).length
							)
								fail();
							toolCompleted = true;
						}
						blocks.delete(value.index);
						break;
					}
					case "message_delta":
						if (
							blocks.size ||
							stopReason ||
							value.delta?.stop_reason !== "tool_use"
						)
							fail();
						stopReason = true;
						break;
					case "message_stop":
						if (!toolCompleted || !stopReason || blocks.size) fail();
						stopped = true;
						break;
					default:
						fail();
				}
			}
		},
	});
	parser.feed(body);
	if (body.endsWith("\r")) parser.feed("\n");
	if (!body.replace(/\r\n?/g, "\n").endsWith("\n\n") || !stopped) fail();
}

/** Synthetic capability validation; no conversation data and no tool execution. */
export function createMessagesModelAccessValidatorV1(
	options: { readonly fetch?: typeof fetch } = {},
): ModelAccessValidatorV1 {
	const fetcher = options.fetch ?? globalThis.fetch;
	return {
		async validate(input, { signal }) {
			const credential = validateModelAccessPolicyV1(input);
			if (
				input.endpoint.protocol !== "anthropic-messages-v1" ||
				input.reasoningLevels.some((level) => !efforts.includes(level))
			)
				throw new ModelConfigurationErrorV1();
			await modelOperationV1(signal, async () => {
				const headers = {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
					"anthropic-beta": betas,
					"user-agent":
						"claude-cli/2.1.246 (external, sdk-ts, agent-sdk/0.3.246)",
					"x-app": "cli",
					...(input.endpoint.authentication === "bearer"
						? { authorization: `Bearer ${credential}` }
						: { "x-api-key": credential }),
				};
				const base = input.endpoint.baseUrl.replace(/\/$/, "");
				const prompt = {
					model: input.modelId,
					messages: [
						{
							role: "user",
							content: "Call agent_infra_conformance with no arguments.",
						},
					],
					tools: [
						{
							name: "agent_infra_conformance",
							description: "Configuration conformance; no side effects.",
							input_schema: {
								type: "object",
								properties: {},
								required: [],
								additionalProperties: false,
							},
						},
					],
				};
				const count = await fetcher(
					`${base}/v1/messages/count_tokens?beta=true`,
					{
						method: "POST",
						headers,
						redirect: "error",
						signal,
						body: JSON.stringify(prompt),
					},
				);
				if (!count.ok) {
					void count.body?.cancel().catch(() => {});
					throw new ModelConfigurationErrorV1(
						count.status === 429 || count.status >= 500,
					);
				}
				const value = JSON.parse(await boundedBody(count, signal));
				if (!Number.isSafeInteger(value.input_tokens) || value.input_tokens < 0)
					throw new ModelConfigurationErrorV1();
				for (const level of input.reasoningLevels) {
					const response = await fetcher(`${base}/v1/messages?beta=true`, {
						method: "POST",
						headers: { ...headers, accept: "text/event-stream" },
						redirect: "error",
						signal,
						body: JSON.stringify({
							...prompt,
							stream: true,
							max_tokens: 2048,
							thinking: { type: "adaptive" },
							output_config: { effort: level },
							tool_choice: { type: "auto" },
						}),
					});
					if (
						!response.ok ||
						!/^text\/event-stream(?:;|$)/i.test(
							response.headers.get("content-type") ?? "",
						)
					) {
						void response.body?.cancel().catch(() => {});
						throw new ModelConfigurationErrorV1(
							response.status === 429 || response.status >= 500,
						);
					}
					verifyCompletion(await boundedBody(response, signal), input.modelId);
				}
			});
		},
	};
}
