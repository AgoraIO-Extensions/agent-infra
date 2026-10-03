import { describe, expect, it, vi } from "vitest";
import { createResponsesModelAccessValidatorV1 } from "./access.js";
import { catalogFixture } from "./catalog.fixture.js";
import { ModelEndpointV1Schema } from "./catalog.js";

const encode = (value: string) => new TextEncoder().encode(value);
const completed = {
	type: "response.completed",
	response: {
		status: "completed",
		model: "model-a",
		reasoning: { effort: "medium" },
		output: [
			{
				type: "function_call",
				name: "agent_infra_conformance",
				arguments: "{}",
				status: "completed",
			},
		],
		metadata: { note: "合成数据 🧪" },
	},
};
const frame = `data: ${JSON.stringify(completed)}\n\n`;
const input = {
	endpoint: ModelEndpointV1Schema.parse(catalogFixture().endpoints[0]),
	modelId: "model-a",
	reasoningLevels: ["medium"],
	credential: encode("synthetic-credential-a"),
};

function validateStream(chunks: Uint8Array[], close = true) {
	const cancel = vi.fn();
	const validator = createResponsesModelAccessValidatorV1({
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(chunk);
						if (close) controller.close();
					},
					cancel,
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
	return {
		result: validator.validate(input, {
			signal: AbortSignal.timeout(close ? 1_000 : 30),
		}),
		cancel,
	};
}

describe.each(["whole", "bytes"])("SSE %s chunks", (chunking) => {
	const chunks = (value: string) => {
		const bytes = encode(value);
		return chunking === "whole"
			? [bytes]
			: Array.from(bytes, (byte) => Uint8Array.of(byte));
	};

	it.each(["\n", "\r\n", "\r"])(
		"accepts multiline UTF-8 events ending with %j at EOF",
		async (newline) => {
			const lines = [
				": synthetic keepalive",
				"event: response.completed",
				...JSON.stringify(completed, null, 2)
					.split("\n")
					.map((line) => `data: ${line}`),
				"",
				"",
			];
			await expect(
				validateStream(chunks(lines.join(newline))).result,
			).resolves.toBeUndefined();
		},
	);

	it.each([
		'data: {"type":"response.failed"}\n\n',
		'data: {"type":"response.incomplete"}\n\n',
		'data: {"type":"error"}\n\n',
		frame,
		"data: [DONE]\n\n",
		"data: invalid-json\n\n",
		"garbage\n\n",
		"retry: invalid\n\n",
		"retry: 1000\n\n",
		"data: truncated",
		"data: truncated\r\n",
	])("rejects content after completion: %j", async (suffix) => {
		await expect(validateStream(chunks(frame + suffix)).result).rejects.toThrow(
			/^MODEL_CONFIGURATION_UNAVAILABLE$/,
		);
	});

	it.each(["\n", "\r\n", "\r"])(
		"rejects a completed event missing its blank line with %j",
		async (newline) => {
			await expect(
				validateStream(chunks(`data: ${JSON.stringify(completed)}${newline}`))
					.result,
			).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
		},
	);
});

it("keeps the deadline and cancels a stream that never ends after completion", async () => {
	const { result, cancel } = validateStream([encode(frame)], false);
	await expect(result).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	expect(cancel).toHaveBeenCalledOnce();
});

it("counts bytes after completion against the response limit", async () => {
	await expect(
		validateStream([encode(frame), encode(`:${"x".repeat(1_048_576)}\n\n`)])
			.result,
	).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
});

it.each([Uint8Array.of(0xff), Uint8Array.of(0xe4, 0xb8)])(
	"rejects invalid or unfinished UTF-8 after completion",
	async (tail) => {
		await expect(validateStream([encode(frame), tail]).result).rejects.toThrow(
			/^MODEL_CONFIGURATION_UNAVAILABLE$/,
		);
	},
);

it("cancels an open stream with malformed UTF-8 without exposing its contents", async () => {
	const { result, cancel } = validateStream(
		[
			encode(": synthetic-credential-a https://models.example.test\n"),
			Uint8Array.of(0xff),
		],
		false,
	);
	await expect(result).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
	expect(cancel).toHaveBeenCalledOnce();
});
