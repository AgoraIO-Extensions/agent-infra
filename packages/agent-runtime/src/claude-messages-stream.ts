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
	verified: (stopReason: string) => Promise<void> = async () => {},
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
						else invalid();
						if (block.type === "tool_use")
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
												blocks.get(index) === "tool_use"
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
							const argumentsJson = toolArguments.get(index)!;
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
						return;
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
	for await (const chunk of body) {
		signal.throwIfAborted();
		bytes += chunk.byteLength;
		if (bytes > 67_108_864) invalid();
		const decoded = decoder.decode(chunk, { stream: true });
		ending = `${ending}${decoded}`.slice(-4);
		parser.feed(decoded);
		for (const encoded of queued) await write(response, encoded, signal);
		queued = [];
	}
	parser.feed(decoder.decode());
	if (ending.endsWith("\r")) parser.feed("\n");
	if (!terminal || !ending.replace(/\r\n?/g, "\n").endsWith("\n\n")) invalid();
	await verified(stopReason);
	for (const encoded of [...queued, ...pending, terminal])
		await write(response, encoded, signal);
	response.end();
}
