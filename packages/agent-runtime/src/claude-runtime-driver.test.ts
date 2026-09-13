import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ClaudeRuntimeDriver } from "./claude-runtime-driver.js";

it("runs a native Claude Turn, durably replays its result and resumes the original Session", async () => {
	const path = await mkdtemp(join(tmpdir(), "claude-driver-conformance-"));
	let calls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (b) => {
			body += b;
		});
		req.on("end", () => {
			const value = JSON.parse(body);
			expect(value.model).toBe("claude-opus-5");
			expect(value.output_config.effort).toBe("high");
			calls++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{
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
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: `OK-${calls}` },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 2 },
				},
				{ type: "message_stop" },
			])
				res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const options = {
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				model: "claude-opus-5",
				reasoningLevels: ["high"],
				authentication: "bearer" as const,
				endpoint: `http://127.0.0.1:${address.port}`,
				credential: "synthetic-model-credential",
			},
		],
	};
	let driver = await ClaudeRuntimeDriver.open(options);
	try {
		const command = {
			schemaVersion: 2 as const,
			kind: "submit-turn" as const,
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
			input: { text: "Reply with OK.", attachments: [] },
		};
		const accepted = await driver.execute(command);
		expect(accepted.result).toEqual({ outcome: "accepted", status: "running" });
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(
			(
				await driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				)
			)
				.filter((event) => event.type === "text")
				.map((event) => event.payload.delta)
				.join(""),
		).toBe("OK-1");
		await driver.close();
		driver = await ClaudeRuntimeDriver.open(options);
		expect(await driver.execute(command)).toEqual(accepted);
		const next = {
			...command,
			operationId: "operation-b",
			executionId: "execution-b",
			turnId: "turn-b",
			nativeSessionRef: accepted.nativeSessionRef,
		};
		const resumed = await driver.execute(next);
		expect(resumed.nativeSessionRef).toBe(accepted.nativeSessionRef);
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(resumed.nativeSessionRef, next.executionId),
				).toBe("completed"),
			{ timeout: 10000 },
		);
		expect(calls).toBe(2);
		await driver.close();
		await rm(join(path, accepted.nativeSessionRef, "state.json"));
		driver = await ClaudeRuntimeDriver.open(options);
		await expect(
			driver.getStatus(accepted.nativeSessionRef, command.executionId),
		).rejects.toThrow("Runtime session could not be recovered");
		await expect(
			driver.execute({
				...next,
				operationId: "operation-c",
				executionId: "execution-c",
				turnId: "turn-c",
			}),
		).rejects.toThrow("Runtime session could not be recovered");
		expect(calls).toBe(2);
	} finally {
		await driver.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
}, 30000);
