import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

it("waits for a durable tool result before admitting the next model request", async () => {
	const path = await mkdtemp(join(tmpdir(), "session-model-after-tool-"));
	let settledBeforeTool = false;
	let driver: SessionRuntimeDriver;
	driver = await SessionRuntimeDriver.open({
		path,
		configVersion: "configuration-a",
		defaultModelOptionId: "primary",
		defaultReasoningLevel: "high",
		modelOptions: [
			{
				modelOptionId: "primary",
				nativeModelId: "provider/model",
				reasoningLevels: ["high"],
			},
		],
		cursorPrefix: "acp",
		modelLifecycleAtTransport: true,
		toolLifecycleAtBoundary: true,
		completionStatus: () => "completed",
		retireSession: async () => {},
		authorizeExternalAction: (action) => driver.validateExternalAction(action),
		openSession: async (options) => ({
			nativeId: "synthetic-native-session",
			select: async () => {},
			cancel: async () => {},
			close: async () => {},
			prompt: async () => {
				await options.admit();
				await options.modelRequestIntent?.();
				await options.modelRequestStarted?.();
				await options.modelRequestFinished?.("completed");
				await options.toolRequestStarted?.({
					toolCallId: "tool-a",
					name: "edit",
					executionBoundary: true,
				});
				await options.toolReceipt?.({
					toolCallId: "tool-a",
					name: "edit",
					phase: "started",
				});
				let resolved = false;
				const nextIntent = options.modelRequestIntent?.().then(
					() => {
						resolved = true;
						return true;
					},
					() => {
						resolved = true;
						return false;
					},
				);
				await new Promise((resolve) => setTimeout(resolve, 20));
				settledBeforeTool = resolved;
				await options.toolReceipt?.({
					toolCallId: "tool-a",
					name: "edit",
					phase: "completed",
				});
				if (!(await nextIntent))
					throw new Error("next model request was denied");
				await options.modelRequestStarted?.();
				await options.modelRequestFinished?.("completed");
				return { stopReason: "end_turn" };
			},
		}),
	});
	try {
		const accepted = await driver.execute({
			schemaVersion: 2,
			kind: "submit-turn",
			agentId: "agent-a",
			conversationId: "conversation-a",
			sessionGeneration: 1,
			executionId: "execution-a",
			turnId: "turn-a",
			operationId: "operation-a",
			input: { text: "edit", attachments: [] },
			selection: {
				schemaVersion: 1,
				modelOptionId: "primary",
				reasoningLevel: "high",
			},
		});
		await vi.waitFor(
			async () =>
				expect(
					await driver.getStatus(accepted.nativeSessionRef, "execution-a"),
				).toBe("completed"),
			{ timeout: 3000 },
		);
		expect(settledBeforeTool).toBe(false);
		const phases = (
			await driver.replayEvents(accepted.nativeSessionRef, "execution-a")
		)
			.filter((event) => event.type === "operation")
			.map((event) => `${event.payload.kind}:${event.payload.phase}`);
		expect(phases).toEqual([
			"model:intent",
			"model:started",
			"model:completed",
			"tool:intent",
			"tool:started",
			"tool:completed",
			"model:intent",
			"model:started",
			"model:completed",
		]);
	} finally {
		await driver.close();
		await rm(path, { recursive: true, force: true });
	}
});
