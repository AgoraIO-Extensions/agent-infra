import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

/** Keep SDK diagnostics free of peer data. Framing and request correlation remain in the SDK. */
export function acpStream(
	output: WritableStream<Uint8Array>,
	input: ReadableStream<Uint8Array>,
): Stream {
	const requests = new Set<string | number>();
	let bytes = 0;
	const bounded = input.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				for (const byte of chunk) {
					bytes = byte === 10 ? 0 : bytes + 1;
					if (bytes > 1_048_576) throw new Error("RUNTIME_ACP_FRAME_INVALID");
				}
				controller.enqueue(chunk);
			},
		}),
	);
	const encoded = new TransformStream<Uint8Array, Uint8Array>();
	// ndJsonStream also emits protocol errors itself. Strip their peer-derived data.
	const writer = output.getWriter();
	void encoded.readable
		.pipeTo(
			new WritableStream({
				async write(bytes) {
					const frame = JSON.parse(new TextDecoder().decode(bytes));
					if (frame.error)
						frame.error = { code: -32600, message: "Invalid ACP message" };
					await writer.write(
						new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
					);
				},
			}),
		)
		.catch(() => {});
	const stream = ndJsonStream(encoded.writable, bounded);
	const outbound = stream.writable.getWriter();
	return {
		writable: new WritableStream({
			async write(frame) {
				if ("method" in frame && "id" in frame && frame.id !== null)
					requests.add(frame.id);
				await outbound.write(frame);
			},
		}),
		readable: stream.readable.pipeThrough(
			new TransformStream({
				transform(frame, controller) {
					if (
						!frame ||
						Array.isArray(frame) ||
						typeof frame !== "object" ||
						frame.jsonrpc !== "2.0"
					)
						return;
					if ("method" in frame) {
						if (typeof frame.method !== "string") return;
						if (!("id" in frame)) {
							if (frame.method !== "session/update") return;
							const notification = sessionNotification(frame.params);
							if (notification)
								controller.enqueue({
									jsonrpc: "2.0",
									method: frame.method,
									params: notification,
								});
							return;
						}
						controller.enqueue(frame);
					} else if (
						"id" in frame &&
						frame.id !== null &&
						requests.delete(frame.id)
					) {
						if ("error" in frame)
							controller.enqueue({
								jsonrpc: "2.0",
								id: frame.id,
								error: { code: -32603, message: "Runtime ACP request failed" },
							});
						else controller.enqueue(frame);
					}
				},
			}),
		),
	};
}

function sessionNotification(value: unknown) {
	if (
		!value ||
		typeof value !== "object" ||
		!("sessionId" in value) ||
		typeof value.sessionId !== "string" ||
		!("update" in value)
	)
		return;
	const update = value.update;
	if (!update || typeof update !== "object" || !("sessionUpdate" in update))
		return;
	if (update.sessionUpdate === "agent_message_chunk" && "content" in update) {
		const content = update.content;
		if (
			!content ||
			typeof content !== "object" ||
			!("type" in content) ||
			content.type !== "text" ||
			!("text" in content) ||
			typeof content.text !== "string"
		)
			return;
		return {
			sessionId: value.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: content.text },
			},
		};
	}
	if (
		["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) &&
		"toolCallId" in update &&
		typeof update.toolCallId === "string"
	) {
		const kind =
			"kind" in update &&
			[
				"read",
				"edit",
				"delete",
				"move",
				"search",
				"execute",
				"think",
				"fetch",
				"switch_mode",
				"other",
			].includes(String(update.kind))
				? update.kind
				: undefined;
		const status =
			"status" in update &&
			["pending", "in_progress", "completed", "failed"].includes(
				String(update.status),
			)
				? update.status
				: undefined;
		return {
			sessionId: value.sessionId,
			update: {
				sessionUpdate: update.sessionUpdate,
				toolCallId: update.toolCallId,
				title: "Runtime tool",
				...(kind ? { kind } : {}),
				...(status ? { status } : {}),
				...("rawInput" in update ? { rawInput: update.rawInput } : {}),
			},
		};
	}
}
