/** A complete Messages SSE stream that calls the conformance tool once. */
export function messagesStreamFixture(
	message: unknown = {
		id: "msg_conformance",
		type: "message",
		role: "assistant",
		model: "claude-opus-5",
		content: [],
		usage: { input_tokens: 100, output_tokens: 1 },
	},
) {
	return [
		{ type: "message_start", message },
		{
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "tool_use",
				id: "tool_conformance",
				name: "agent_infra_conformance",
				input: {},
			},
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: "{}" },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 10 },
		},
		{ type: "message_stop" },
	]
		.map((v) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`)
		.join("");
}
