import { describe, expect, it } from "vitest";
import {
	ConversationBrowserActionExecutionError,
	conversationBrowserActionFactV1,
	createConversationBrowserActionAttemptV1,
	executeConversationBrowserActionV1,
	persistConversationBrowserActionV1,
} from "./conversation-browser-action.js";
import type { ConversationEventUseCaseV1 } from "./conversation-events.js";

const browser = {
	actionId: "browser-action-1",
	capabilityVersion: 1,
	pageRevision: 2,
	sessionGeneration: 3,
	resourceFence: 4,
	sideEffect: true,
} as const;

const input = {
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 3,
	deliveryFence: 4,
	runtimeCursor: "browser-cursor-1",
	occurredAt: "2026-10-06T12:00:00.000Z",
	adapterEventKey: "browser-action-1:intent",
	attempt: { operationRef: "operation-1", attemptRef: "attempt-1" },
	phase: "intent" as const,
	toolId: "browser.click",
	browser,
};

describe("Conversation Browser action adapter", () => {
	it("allocates independent operation and attempt references", () => {
		const values = ["operation-1", "attempt-1"];
		const next = () => {
			const value = values.shift();
			if (!value) throw new Error("test id exhausted");
			return value;
		};
		expect(createConversationBrowserActionAttemptV1(next)).toEqual(
			input.attempt,
		);
	});

	it("projects every phase through the existing operation fact", () => {
		expect(
			conversationBrowserActionFactV1({
				...input,
				phase: "unknown",
				finishedAt: "2026-10-06T12:00:01.000Z",
				failureCode: "recovery_unconfirmed",
			}),
		).toMatchObject({
			kind: "tool",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			phase: "unknown",
			browser,
			failureCode: "recovery_unconfirmed",
		});
	});

	it("uses the existing event use case as the persistence boundary", async () => {
		const commands: unknown[] = [];
		const result = await persistConversationBrowserActionV1(
			{
				persist: async (command) => {
					commands.push(command);
					return { outcome: "stale" };
				},
			},
			input,
		);
		expect(result).toEqual({ outcome: "stale" });
		expect(commands[0]).toMatchObject({
			conversationId: "conversation-1",
			executionId: "execution-1",
			event: {
				type: "execution.operation",
				fact: { operationRef: "operation-1", attemptRef: "attempt-1" },
			},
		});
	});

	it("rejects a browser binding from another generation or fence", async () => {
		await expect(
			persistConversationBrowserActionV1(
				{ persist: async () => ({ outcome: "stale" as const }) },
				{ ...input, browser: { ...browser, resourceFence: 99 } },
			),
		).rejects.toThrow("BROWSER_ACTION_BINDING_MISMATCH");
	});

	it("commits intent before I/O and preserves unknown after an uncertain action", async () => {
		const phases: string[] = [];
		let ioStarted = false;
		const useCase: ConversationEventUseCaseV1 = {
			persist: async (command) => {
				if (command.event.type !== "execution.operation")
					throw new Error("unexpected event");
				phases.push(command.event.fact.phase);
				return {
					outcome: "accepted",
					event: {
						schemaVersion: 1,
						eventId: `event-${phases.length}`,
						conversationId: command.conversationId,
						executionId: command.executionId,
						sequence: phases.length,
						conversationCursor: phases.length,
						occurredAt: command.occurredAt,
						event: command.event,
					},
				} as const;
			},
		};
		await expect(
			executeConversationBrowserActionV1(useCase, {
				...input,
				adapterEventKeyPrefix: "browser-action-1",
				runtimeCursorPrefix: "browser-cursor-1",
				now: () => "2026-10-06T12:00:01.000Z",
				signal: new AbortController().signal,
				run: async (markStarted) => {
					await markStarted();
					ioStarted = true;
					throw new ConversationBrowserActionExecutionError("unknown");
				},
			}),
		).rejects.toThrow("unknown");
		expect(ioStarted).toBe(true);
		expect(phases).toEqual(["intent", "started", "unknown"]);
	});

	it("does not call I/O when intent persistence is stale", async () => {
		let called = false;
		const useCase = {
			persist: async () => ({ outcome: "stale" as const }),
		};
		await expect(
			executeConversationBrowserActionV1(useCase, {
				...input,
				adapterEventKeyPrefix: "browser-action-1",
				runtimeCursorPrefix: "browser-cursor-1",
				now: () => "2026-10-06T12:00:01.000Z",
				signal: new AbortController().signal,
				run: async () => {
					called = true;
					return {};
				},
			}),
		).rejects.toThrow();
		expect(called).toBe(false);
	});

	it("returns a persisted completed result without replaying I/O", async () => {
		let called = false;
		const useCase: ConversationEventUseCaseV1 = {
			persist: async (command) => ({
				outcome: "replayed",
				event: {
					schemaVersion: 1,
					eventId: "event-1",
					conversationId: command.conversationId,
					executionId: command.executionId,
					sequence: 1,
					conversationCursor: 1,
					occurredAt: command.occurredAt,
					event: {
						type: "execution.operation",
						schemaVersion: 2,
						fact: {
							...conversationBrowserActionFactV1({
								...input,
								phase: "completed",
								finishedAt: command.occurredAt,
								resultRef: "file-1",
							}),
						},
					},
				},
			}),
		};
		const result = await executeConversationBrowserActionV1(useCase, {
			...input,
			adapterEventKeyPrefix: "browser-action-1",
			runtimeCursorPrefix: "browser-cursor-1",
			now: () => "2026-10-06T12:00:01.000Z",
			signal: new AbortController().signal,
			run: async () => {
				called = true;
				return {};
			},
		});
		expect(result).toEqual({ resultRef: "file-1" });
		expect(called).toBe(false);
	});

	it("cancels before intent without invoking persistence or I/O", async () => {
		const controller = new AbortController();
		controller.abort();
		let persisted = false;
		let called = false;
		await expect(
			executeConversationBrowserActionV1(
				{
					persist: async () => {
						persisted = true;
						return { outcome: "stale" as const };
					},
				},
				{
					...input,
					adapterEventKeyPrefix: "browser-action-cancelled",
					runtimeCursorPrefix: "browser-cursor-cancelled",
					now: () => "2026-10-06T12:00:01.000Z",
					signal: controller.signal,
					run: async () => {
						called = true;
						return {};
					},
				},
			),
		).rejects.toMatchObject({ failureCode: "interrupted" });
		expect(persisted).toBe(false);
		expect(called).toBe(false);
	});

	it("records interruption before started without invoking external I/O", async () => {
		const controller = new AbortController();
		const phases: string[] = [];
		const useCase: ConversationEventUseCaseV1 = {
			persist: async (command) => {
				if (command.event.type !== "execution.operation")
					throw new Error("unexpected event");
				phases.push(command.event.fact.phase);
				return { outcome: "accepted", event: command } as never;
			},
		};
		await expect(
			executeConversationBrowserActionV1(useCase, {
				...input,
				adapterEventKeyPrefix: "browser-action-before-start",
				runtimeCursorPrefix: "browser-cursor-before-start",
				now: () => "2026-10-06T12:00:01.000Z",
				signal: controller.signal,
				run: async (markStarted) => {
					controller.abort();
					await markStarted();
					return {};
				},
			}),
		).rejects.toMatchObject({ failureCode: "interrupted" });
		expect(phases).toEqual(["intent", "failed"]);
	});

	it("records unknown when cancellation arrives after started", async () => {
		const controller = new AbortController();
		const phases: string[] = [];
		const useCase: ConversationEventUseCaseV1 = {
			persist: async (command) => {
				if (command.event.type !== "execution.operation")
					throw new Error("unexpected event");
				phases.push(command.event.fact.phase);
				return { outcome: "accepted", event: command } as never;
			},
		};
		await expect(
			executeConversationBrowserActionV1(useCase, {
				...input,
				adapterEventKeyPrefix: "browser-action-after-start",
				runtimeCursorPrefix: "browser-cursor-after-start",
				now: () => "2026-10-06T12:00:01.000Z",
				signal: controller.signal,
				run: async (markStarted) => {
					await markStarted();
					controller.abort();
					throw new Error("external result uncertain");
				},
			}),
		).rejects.toThrow("external result uncertain");
		expect(phases).toEqual(["intent", "started", "unknown"]);
	});

	it("blocks the start barrier when cancellation arrives during persistence", async () => {
		const controller = new AbortController();
		let releaseStarted: (() => void) | undefined;
		const phases: string[] = [];
		const useCase: ConversationEventUseCaseV1 = {
			persist: async (command) => {
				if (command.event.type !== "execution.operation")
					throw new Error("unexpected event");
				const phase = command.event.fact.phase;
				phases.push(phase);
				if (phase === "started") {
					await new Promise<void>((resolve) => {
						releaseStarted = resolve;
					});
				}
				return { outcome: "accepted", event: command } as never;
			},
		};
		let called = false;
		const execution = executeConversationBrowserActionV1(useCase, {
			...input,
			adapterEventKeyPrefix: "browser-action-start-pending",
			runtimeCursorPrefix: "browser-cursor-start-pending",
			now: () => "2026-10-06T12:00:01.000Z",
			signal: controller.signal,
			run: async (markStarted) => {
				await markStarted();
				called = true;
				return {};
			},
		});
		for (let index = 0; index < 10 && !releaseStarted; index++)
			await Promise.resolve();
		if (!releaseStarted) throw new Error("started persistence did not begin");
		controller.abort();
		releaseStarted();
		await expect(execution).rejects.toMatchObject({
			failureCode: "interrupted",
		});
		expect(called).toBe(false);
		expect(phases).toEqual(["intent", "started", "unknown"]);
	});

	it("does not return success when terminal persistence fails", async () => {
		const phases: string[] = [];
		const useCase: ConversationEventUseCaseV1 = {
			persist: async (command) => {
				if (command.event.type !== "execution.operation")
					throw new Error("unexpected event");
				const phase = command.event.fact.phase;
				phases.push(phase);
				if (phase === "completed")
					throw new Error("terminal persistence failed");
				return { outcome: "accepted", event: command } as never;
			},
		};
		await expect(
			executeConversationBrowserActionV1(useCase, {
				...input,
				adapterEventKeyPrefix: "browser-action-terminal-failure",
				runtimeCursorPrefix: "browser-cursor-terminal-failure",
				now: () => "2026-10-06T12:00:01.000Z",
				signal: new AbortController().signal,
				run: async (markStarted) => {
					await markStarted();
					return {};
				},
			}),
		).rejects.toThrow("terminal persistence failed");
		expect(phases).toEqual(["intent", "started", "completed", "unknown"]);
	});
});
