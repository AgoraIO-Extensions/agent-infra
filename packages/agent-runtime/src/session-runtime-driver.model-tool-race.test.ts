import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

it.each(["completed", "unknown"] as const)(
	"waits for an in-flight %s tool receipt before admitting the next model request",
	async (toolOutcome) => {
		const path = await mkdtemp(join(tmpdir(), "model-tool-race-"));
		let modelAuthorizations = 0;
		let releaseTool = () => {};
		const toolFinished = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let reachedNextRequest = () => {};
		const nextRequest = new Promise<void>((resolve) => {
			reachedNextRequest = resolve;
		});
		const driver = await SessionRuntimeDriver.open({
			path,
			configVersion: "config-one",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: "provider/model",
					reasoningLevels: ["high"],
				},
			],
			cursorPrefix: "model-tool-race",
			modelLifecycleAtTransport: true,
			retireSession: async () => {},
			completionStatus: () => "completed",
			authorizeExternalAction: async (action) => {
				if (action.kind === "model") modelAuthorizations++;
				await driver.validateExternalAction(action);
			},
			openSession: async (callbacks) => ({
				nativeId: "synthetic-native",
				select: async () => {},
				prompt: async () => {
					await callbacks.admit();
					await callbacks.modelRequestIntent?.("messages");
					await callbacks.modelRequestStarted?.();
					await callbacks.toolRequestStarted?.({
						toolCallId: "tool-one",
						name: "read",
						permitted: true,
					});
					await callbacks.modelRequestFinished?.("completed");
					let admitted = false;
					const modelRequest = callbacks
						.modelRequestIntent?.("messages")
						.then(() => {
							admitted = true;
						});
					void modelRequest?.catch(() => {});
					reachedNextRequest();
					await toolFinished;
					expect(admitted).toBe(false);
					await callbacks.toolReceipt?.({
						toolCallId: "tool-one",
						name: "read",
						phase: "started",
					});
					await callbacks.toolReceipt?.({
						toolCallId: "tool-one",
						name: "read",
						phase: toolOutcome,
					});
					if (toolOutcome === "unknown") {
						await expect(modelRequest).rejects.toThrow();
						return { stopReason: "end_turn" };
					}
					await modelRequest;
					await callbacks.modelRequestStarted?.();
					await callbacks.modelRequestFinished?.("completed");
					return { stopReason: "end_turn" };
				},
				cancel: async () => {},
				close: async () => {},
			}),
		});
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
				input: { text: "synthetic input", attachments: [] },
				selection: {
					schemaVersion: 1 as const,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
			};
			const accepted = await driver.execute(command);
			await nextRequest;
			releaseTool();
			await vi.waitFor(async () =>
				expect(
					await driver.getStatus(
						accepted.nativeSessionRef,
						command.executionId,
					),
				).toBe(toolOutcome === "completed" ? "completed" : "unknown"),
			);
			expect(modelAuthorizations).toBe(toolOutcome === "completed" ? 2 : 1);
			const modelPhases = (
				await driver.replayEvents(
					accepted.nativeSessionRef,
					command.executionId,
				)
			).flatMap((event) =>
				event.type === "operation" && event.payload.kind === "model"
					? [event.payload.phase]
					: [],
			);
			expect(modelPhases).toEqual(
				toolOutcome === "completed"
					? ["intent", "started", "completed", "intent", "started", "completed"]
					: ["intent", "started", "completed"],
			);
		} finally {
			releaseTool();
			await driver.close();
			await rm(path, { recursive: true, force: true });
		}
	},
);
