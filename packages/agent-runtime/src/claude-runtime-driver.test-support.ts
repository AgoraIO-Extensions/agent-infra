import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { vi } from "vitest";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";
import type { RuntimeDriverCommand } from "./driver.js";

export async function openClaudeRuntimeDriverConformanceFixture(
	path: string,
	loseFirstResult = false,
) {
	let loseResult = loseFirstResult;
	let calls = 0;
	const selections: {
		schemaVersion: 1;
		modelOptionId: string;
		reasoningLevel: string;
	}[] = [];
	const responses = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const value = JSON.parse(body);
			calls++;
			selections.push({
				schemaVersion: 1,
				modelOptionId:
					value.model === "claude-opus-5"
						? "model-option-primary"
						: "model-option-alternate",
				reasoningLevel: value.output_config.effort,
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(
				encode({
					type: "message_start",
					message: {
						id: `msg_${calls}`,
						type: "message",
						role: "assistant",
						model: value.model,
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				}),
			);
			responses.add(response);
			response.on("close", () => responses.delete(response));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const options = {
		path,
		configVersion: "conformance-1",
		defaultModelOptionId: "model-option-primary",
		defaultReasoningLevel: "high",
		modelOptions: ["primary", "alternate"].map((id) => ({
			modelOptionId: `model-option-${id}`,
			model: id === "primary" ? "claude-opus-5" : "claude-sonnet-4-6",
			reasoningLevels: ["low", "high"],
			endpoint: `http://127.0.0.1:${address.port}`,
			credential: `synthetic-${id}-credential`,
			authentication: "bearer" as const,
		})),
	};
	let raw = await ClaudeRuntimeDriver.open(options);
	const commands: { command: RuntimeDriverCommand; ref: string }[] = [];
	function decorate() {
		const execute = raw.execute.bind(raw);
		raw.execute = async (command) => {
			const previousCalls = calls;
			const record = await execute(command);
			if (
				record.result.outcome === "accepted" &&
				command.kind === "submit-turn" &&
				!commands.some(
					(entry) => entry.command.operationId === command.operationId,
				)
			) {
				commands.push({ command, ref: record.nativeSessionRef });
				await vi.waitFor(
					() => {
						if (calls <= previousCalls)
							throw new Error("Waiting for native model request");
					},
					{ timeout: 10_000 },
				);
				if (loseResult) {
					loseResult = false;
					await forgetResult(command.operationId);
					throw new Error("Synthetic lost acceptance response");
				}
			}
			return record;
		};
	}
	async function forgetResult(operationId: string) {
		// Simulate loss of the durable acceptance acknowledgement at the filesystem boundary.
		await raw.close();
		for (const directory of await readdir(path, { withFileTypes: true })) {
			if (!directory.isDirectory()) continue;
			const file = join(path, directory.name, "state.json");
			const state = JSON.parse(await readFile(file, "utf8"));
			for (const operation of state.operations)
				if (operation.record?.operationId === operationId)
					delete operation.record;
			await writeFile(file, JSON.stringify(state), { mode: 0o600 });
		}
	}
	decorate();
	let closed = false;
	const fixture = {
		get driver() {
			return raw;
		},
		recoveryStatus: "unknown" as const,
		emitRunningEvent: async () => {},
		submitWithPreStartEvent: async <T>(submit: () => Promise<T>) => submit(),
		completeStopAsCancelled: () => {},
		async completeStopAsCompleted() {
			for (const response of responses) {
				for (const event of [
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "synthetic completion" },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 2 },
					},
					{ type: "message_stop" },
				])
					response.write(encode(event));
				response.end();
			}
			await vi.waitFor(
				async () => {
					for (const { command, ref } of commands)
						if ((await raw.getStatus(ref, command.executionId)) !== "completed")
							throw new Error("Waiting for completion");
				},
				{ timeout: 10_000 },
			);
		},
		createdTurnCount: async () => calls,
		turnSelections: () => structuredClone(selections),
		rejectNextSelectedTurn: () => {},
		async restart() {
			await raw.close();
			raw = await ClaudeRuntimeDriver.open(options);
			decorate();
			return fixture;
		},
		makeOperationUnknown: forgetResult,
		delegatedToolWasDeniedAndRedacted: async () => false,
		async close() {
			if (closed) return;
			closed = true;
			await raw.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
	return fixture;
}

function encode(value: unknown) {
	return `data: ${JSON.stringify(value)}\n\n`;
}
