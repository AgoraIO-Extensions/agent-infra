import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { createParser } from "eventsource-parser";
import { createCredentialMatcher } from "./model-credential-matcher.js";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
	throw new Error("RUNTIME_MODEL_STREAM_INVALID");
}
class CompleteStream extends Error {}
async function write(
	response: ServerResponse,
	value: string,
	signal: AbortSignal,
) {
	if (response.destroyed) invalid();
	if (!response.headersSent)
		response.writeHead(200, { "content-type": "text/event-stream" });
	if (!response.write(value)) await once(response, "drain", { signal });
}

/** SSE framing uses eventsource-parser; this function only validates the fixed Messages profile. */
export async function forwardClaudeMessages(
	body: ReadableStream<Uint8Array>,
	response: ServerResponse,
	model: string,
	protectedValues: readonly string[],
	signal: AbortSignal,
	verified: (
		stopReason: string,
		usage: {
			inputTokens?: number;
			outputTokens?: number;
			cachedInputTokens?: number;
		},
	) => Promise<void> = async () => {},
	serverSearch = false,
) {
	const matcher = createCredentialMatcher(protectedValues);
	const channels = new Map<string, number>();
	const blocks = new Map<number, string>();
	const toolArguments = new Map<number, string>();
	let started = false;
	let delta = false;
	let terminal = "";
	let stopReason = "";
	let nextIndex = 0;
	let bytes = 0;
	let ending = "";
	let pending: string[] = [];
	let queued: string[] = [];
	let pendingBytes = 0;
	const searchIds = new Set<string>();
	const completedSearchIds = new Set<string>();
	const usage: {
		inputTokens?: number;
		outputTokens?: number;
		cachedInputTokens?: number;
	} = {};
	const captureUsage = (value: Record<string, unknown>) => {
		for (const [source, target] of [
			["input_tokens", "inputTokens"],
			["output_tokens", "outputTokens"],
			["cache_read_input_tokens", "cachedInputTokens"],
		] as const) {
			if (value[source] === undefined) continue;
			if (!Number.isSafeInteger(value[source]) || (value[source] as number) < 0)
				invalid();
			usage[target] = value[source] as number;
		}
	};
	const scan = (value: unknown): void => {
		if (typeof value === "string" && matcher.contains(value)) invalid();
		if (Array.isArray(value)) for (const item of value) scan(item);
		else if (record(value))
			for (const [key, child] of Object.entries(value)) {
				if ((key === "error" && child !== null) || matcher.contains(key))
					invalid();
				scan(child);
			}
	};
	const payload = (index: number, kind: string, value: unknown) => {
		if (typeof value !== "string") invalid();
		for (const channel of ["all", kind, `${index}:${kind}`]) {
			const next = matcher.advance(channels.get(channel) ?? 0, value);
			if (next.matched) invalid();
			if (next.state) channels.set(channel, next.state);
			else channels.delete(channel);
		}
	};
	const parser = createParser({
		maxBufferSize: 1_048_576,
		onError: invalid,
		onRetry: invalid,
		onEvent: ({ data, event }) => {
			const value: unknown = JSON.parse(data);
			if (
				!record(value) ||
				terminal ||
				typeof value.type !== "string" ||
				(event && event !== value.type)
			)
				invalid();
			scan(value);
			let projected: Record<string, unknown>;
			if (value.type === "ping") return;
			if (value.type === "message_start") {
				const message = value.message;
				if (
					started ||
					!record(message) ||
					message.type !== "message" ||
					message.role !== "assistant" ||
					typeof message.id !== "string" ||
					(message.model !== model &&
						!(
							typeof message.model === "string" &&
							message.model.startsWith(`${model}-`)
						)) ||
					!Array.isArray(message.content) ||
					message.content.length ||
					!record(message.usage)
				)
					invalid();
				started = true;
				captureUsage(message.usage);
				projected = {
					type: value.type,
					message: {
						id: message.id,
						type: "message",
						role: "assistant",
						model: message.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: message.usage,
					},
				};
			} else {
				if (!started || (delta && value.type !== "message_stop")) invalid();
				const index = value.index;
				switch (value.type) {
					case "content_block_start": {
						const block = value.content_block;
						if (
							index !== nextIndex ||
							!record(block) ||
							typeof block.type !== "string"
						)
							invalid();
						nextIndex++;
						blocks.set(index as number, block.type);
						let content: Record<string, unknown>;
						if (block.type === "text") {
							payload(index as number, "text", block.text);
							content = { type: block.type, text: block.text };
						} else if (block.type === "thinking") {
							payload(index as number, "thinking", block.thinking);
							payload(index as number, "signature", block.signature ?? "");
							content = {
								type: block.type,
								thinking: block.thinking,
								signature: block.signature ?? "",
							};
						} else if (
							block.type === "redacted_thinking" &&
							typeof block.data === "string"
						)
							content = { type: block.type, data: block.data };
						else if (
							block.type === "tool_use" &&
							typeof block.id === "string" &&
							typeof block.name === "string" &&
							record(block.input)
						)
							content = {
								type: block.type,
								id: block.id,
								name: block.name,
								input: block.input,
							};
						else if (
							serverSearch &&
							block.type === "server_tool_use" &&
							block.name === "web_search" &&
							typeof block.id === "string" &&
							/^srvtoolu_[A-Za-z0-9_-]{1,200}$/.test(block.id) &&
							!searchIds.has(block.id) &&
							!completedSearchIds.has(block.id) &&
							record(block.input)
						) {
							searchIds.add(block.id);
							content = {
								type: block.type,
								id: block.id,
								name: block.name,
								input: block.input,
							};
						} else if (
							serverSearch &&
							block.type === "web_search_tool_result" &&
							typeof block.tool_use_id === "string" &&
							searchIds.delete(block.tool_use_id)
						) {
							completedSearchIds.add(block.tool_use_id);
							if (
								record(block.content) &&
								block.content.type === "web_search_tool_result_error" &&
								[
									"invalid_tool_input",
									"unavailable",
									"max_uses_exceeded",
									"too_many_requests",
									"query_too_long",
								].includes(String(block.content.error_code)) &&
								Object.keys(block.content).every((key) =>
									["type", "error_code"].includes(key),
								)
							) {
								content = {
									type: block.type,
									tool_use_id: block.tool_use_id,
									content: {
										type: block.content.type,
										error_code: block.content.error_code,
									},
								};
							} else {
								if (!Array.isArray(block.content) || block.content.length > 100)
									invalid();
								const results = block.content.map((result: unknown) => {
									if (
										!record(result) ||
										result.type !== "web_search_result" ||
										typeof result.url !== "string" ||
										!/^https?:\/\//.test(result.url) ||
										typeof result.title !== "string" ||
										typeof result.encrypted_content !== "string" ||
										result.title.length > 8192 ||
										result.encrypted_content.length > 262144
									)
										invalid();
									return {
										type: "web_search_result",
										url: result.url,
										title: result.title,
										encrypted_content: result.encrypted_content,
										...(typeof result.page_age === "string"
											? { page_age: result.page_age }
											: {}),
									};
								});
								content = {
									type: block.type,
									tool_use_id: block.tool_use_id,
									content: results,
								};
							}
						} else invalid();
						if (block.type === "tool_use" || block.type === "server_tool_use")
							toolArguments.set(index as number, "");
						projected = { type: value.type, index, content_block: content };
						break;
					}
					case "content_block_delta": {
						const update = value.delta;
						if (
							typeof index !== "number" ||
							!blocks.has(index) ||
							!record(update)
						)
							invalid();
						const field =
							update.type === "text_delta" && blocks.get(index) === "text"
								? "text"
								: update.type === "thinking_delta" &&
										blocks.get(index) === "thinking"
									? "thinking"
									: update.type === "signature_delta" &&
											blocks.get(index) === "thinking"
										? "signature"
										: update.type === "input_json_delta" &&
												["tool_use", "server_tool_use"].includes(
													blocks.get(index) ?? "",
												)
											? "partial_json"
											: undefined;
						if (!field) invalid();
						payload(index, field, update[field]);
						if (field === "partial_json")
							toolArguments.set(
								index,
								(toolArguments.get(index) ?? "") + update[field],
							);
						projected = {
							type: value.type,
							index,
							delta: { type: update.type, [field]: update[field] },
						};
						break;
					}
					case "content_block_stop":
						if (typeof index !== "number" || !blocks.delete(index)) invalid();
						if (toolArguments.has(index)) {
							const argumentsJson = toolArguments.get(index);
							if (argumentsJson === undefined) invalid();
							if (argumentsJson) {
								const args: unknown = JSON.parse(argumentsJson);
								if (!record(args)) invalid();
								scan(args);
							}
							toolArguments.delete(index);
						}
						projected = { type: value.type, index };
						break;
					case "message_delta":
						if (
							blocks.size ||
							!record(value.delta) ||
							![
								"end_turn",
								"tool_use",
								"max_tokens",
								"stop_sequence",
								"refusal",
								"pause_turn",
								"model_context_window_exceeded",
							].includes(String(value.delta.stop_reason)) ||
							!record(value.usage)
						)
							invalid();
						stopReason = String(value.delta.stop_reason);
						captureUsage(value.usage);
						delta = true;
						projected = {
							type: value.type,
							delta: {
								stop_reason: value.delta.stop_reason,
								stop_sequence: value.delta.stop_sequence ?? null,
							},
							usage: value.usage,
						};
						break;
					case "message_stop":
						if (!delta || blocks.size) invalid();
						terminal = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
						throw new CompleteStream();
					default:
						invalid();
				}
			}
			const encoded = `event: ${value.type}\ndata: ${JSON.stringify(projected)}\n\n`;
			pending.push(encoded);
			pendingBytes += Buffer.byteLength(encoded);
			if (pendingBytes > 2_097_152 || pending.length > 1024) invalid();
			if (!channels.size && !toolArguments.size) {
				queued.push(...pending);
				pending = [];
				pendingBytes = 0;
			}
		},
	});
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let completed = false;
	for await (const chunk of body) {
		signal.throwIfAborted();
		bytes += chunk.byteLength;
		if (bytes > 67_108_864) invalid();
		const decoded = decoder.decode(chunk, { stream: true });
		ending = `${ending}${decoded}`.slice(-4);
		try {
			parser.feed(decoded);
		} catch (error) {
			if (error instanceof CompleteStream) {
				completed = true;
				break;
			}
			throw error;
		}
		for (const encoded of queued) await write(response, encoded, signal);
		queued = [];
	}
	if (!completed) {
		parser.feed(decoder.decode());
		if (ending.endsWith("\r")) parser.feed("\n");
	}
	if (
		!terminal ||
		(!completed && !ending.replace(/\r\n?/g, "\n").endsWith("\n\n"))
	)
		invalid();
	if (searchIds.size) invalid();
	await verified(stopReason, usage);
	for (const encoded of [...queued, ...pending, terminal])
		await write(response, encoded, signal);
	response.end();
	if (completed) await body.cancel().catch(() => {});
}
