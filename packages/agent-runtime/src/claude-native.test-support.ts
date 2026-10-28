import { mkdtemp, rm } from "node:fs/promises";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";

export const claudeCommand = (id = "one") => ({
	schemaVersion: 2 as const,
	kind: "submit-turn" as const,
	agentId: "agent-one",
	conversationId: "conversation-one",
	sessionGeneration: 1,
	executionId: `execution-${id}`,
	turnId: `turn-${id}`,
	operationId: `execution-${id}`,
	selection: {
		schemaVersion: 1 as const,
		modelOptionId: "option-one",
		reasoningLevel: "high",
	},
	input: { text: `Synthetic request ${id}. Reply OK.`, attachments: [] },
});
export function completeClaudeResponse(
	response: ServerResponse,
	id: string,
	model: string,
	text = "OK",
	reads: readonly string[] = [],
) {
	completeClaudeToolUses(
		response,
		id,
		model,
		text,
		reads.map((filePath, index) => ({
			id: `read_${index}`,
			name: "Read",
			input: { file_path: filePath },
		})),
	);
}

/** #3217：按固定 Messages 流式格式返回任意原生工具调用。 */
export function completeClaudeToolUses(
	response: ServerResponse,
	id: string,
	model: string,
	text: string,
	uses: readonly {
		readonly id: string;
		readonly name: string;
		readonly input: Record<string, unknown>;
	}[],
) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of [
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		...(uses.length
			? uses.flatMap((use, index) => [
					{
						type: "content_block_start",
						index,
						content_block: {
							type: "tool_use",
							id: use.id,
							name: use.name,
							input: {},
						},
					},
					{
						type: "content_block_delta",
						index,
						delta: {
							type: "input_json_delta",
							partial_json: JSON.stringify(use.input),
						},
					},
					{ type: "content_block_stop", index },
				])
			: [
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text },
					},
					{ type: "content_block_stop", index: 0 },
				]),
		{
			type: "message_delta",
			delta: {
				stop_reason: uses.length ? "tool_use" : "end_turn",
				stop_sequence: null,
			},
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	])
		response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	response.end();
}
export async function claudeNativeFixture() {
	const path = await mkdtemp(join(tmpdir(), "claude-native-"));
	const calls: {
		endpoint: number;
		headers: IncomingHttpHeaders;
		body: Record<string, unknown>;
		response: ServerResponse;
	}[] = [];
	let respond = true;
	const servers = [0, 1].map((endpoint) =>
		createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				const value = JSON.parse(body);
				calls.push({
					endpoint,
					headers: request.headers,
					body: value,
					response,
				});
				if (request.url?.startsWith("/v1/messages/count_tokens")) {
					response.writeHead(200, { "content-type": "application/json" });
					response.end('{"input_tokens":7}');
					return;
				}
				if (respond)
					completeClaudeResponse(response, `msg_${calls.length}`, value.model);
			});
		}),
	);
	for (const server of servers)
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
	const options = {
		path,
		configVersion: "config-one",
		defaultModelOptionId: "option-one",
		defaultReasoningLevel: "high",
		modelOptions: servers.map((server, index) => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error();
			return {
				modelOptionId: index === 0 ? "option-one" : "option-two",
				model: "claude-opus-5",
				reasoningLevels: ["low", "high"],
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: `synthetic-credential-${index}`,
				authentication:
					index === 0 ? ("bearer" as const) : ("api-key" as const),
			};
		}),
	};
	let driver = await ClaudeRuntimeDriver.open(options);
	return {
		path,
		options,
		calls,
		get driver() {
			return driver;
		},
		hold() {
			respond = false;
		},
		release() {
			respond = true;
			for (const call of calls)
				if (!call.response.destroyed && !call.response.writableEnded)
					completeClaudeResponse(
						call.response,
						`msg_${calls.indexOf(call)}`,
						String(call.body.model),
					);
		},
		async settled(ref: string, executionId: string) {
			await vi.waitFor(
				async () => {
					if ((await driver.getStatus(ref, executionId)) !== "completed")
						throw new Error("Waiting for completion");
				},
				{ timeout: 10000 },
			);
		},
		async restart(
			config: Parameters<typeof ClaudeRuntimeDriver.open>[0] = options,
		) {
			await driver.close();
			driver = await ClaudeRuntimeDriver.open(config);
		},
		async close() {
			try {
				await driver.close();
			} finally {
				for (const server of servers) {
					server.closeAllConnections();
					await new Promise<void>((resolve) => server.close(() => resolve()));
				}
				await rm(path, { recursive: true, force: true });
			}
		},
	};
}

// Only Messages requests carry model JSON; native startup also probes this origin.
export async function readClaudeFixtureMessage(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<(Record<string, unknown> & { model: string }) | undefined> {
	if (
		request.method !== "POST" ||
		request.url?.split("?")[0] !== "/v1/messages"
	) {
		request.resume();
		response.writeHead(404).end();
		return;
	}
	try {
		let body = "";
		for await (const chunk of request) {
			body += chunk;
			if (body.length > 1_048_576) {
				response.writeHead(413).end();
				return;
			}
		}
		const value = JSON.parse(body);
		if (
			!value ||
			typeof value.model !== "string" ||
			!Array.isArray(value.messages)
		) {
			response.writeHead(400).end();
			return;
		}
		return value;
	} catch {
		response.writeHead(400).end();
		return;
	}
}
