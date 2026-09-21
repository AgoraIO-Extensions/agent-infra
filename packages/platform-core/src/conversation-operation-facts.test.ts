import { describe, expect, it, vi } from "vitest";
import {
	type ConversationOperationFactV2,
	parseConversationOperationFactV2,
	requireConversationOperationSuccessorV2,
} from "./conversation-operation-facts.js";
import { FakeConversationEventsV1 } from "./fake-conversation-events.js";

const intent: ConversationOperationFactV2 = {
	kind: "model",
	operationRef: "model-op-1",
	attemptRef: "attempt-1",
	phase: "intent",
	model: {
		configVersion: "revision-1",
		modelOptionId: "option-1",
		modelId: "model-1",
		reasoningLevel: "medium",
	},
};
const started: ConversationOperationFactV2 = {
	...intent,
	phase: "started",
	startedAt: "2026-09-14T12:00:00.000Z",
};
const unknown: ConversationOperationFactV2 = {
	...started,
	phase: "unknown",
	failureCode: "response_incomplete",
	finishedAt: "2026-09-14T12:00:01.000Z",
};
const completed: ConversationOperationFactV2 = {
	...started,
	phase: "completed",
	finishedAt: "2026-09-14T12:00:02.000Z",
	durationMs: 2_000,
};

const toolIntent = {
	kind: "tool",
	operationRef: "connection-operation-1",
	attemptRef: "connection-attempt-1",
	phase: "intent",
	toolId: "connection.github.create_pr",
	connection: {
		serviceRef: "connection-primary",
		verification: "unverified",
		reason: "receipt_missing",
	},
} as const satisfies ConversationOperationFactV2;
const toolStarted = {
	...toolIntent,
	phase: "started",
	startedAt: "2026-09-14T12:00:00.000Z",
} as const;
const toolCompleted = {
	...toolStarted,
	phase: "completed",
	finishedAt: "2026-09-14T12:00:02.000Z",
	durationMs: 2_000,
	resultRef: "result-1",
	connection: {
		...toolIntent.connection,
		callRef: "call-1",
		reason: "record_unavailable",
	},
} as const;
const verifiedTool = {
	...toolCompleted,
	connection: {
		serviceRef: toolIntent.connection.serviceRef,
		verification: "verified",
		callRef: "call-1",
	},
} as const;

describe("Connection association domain successors", () => {
	it("cannot advance an unfinished or unknown tool outcome during post-terminal verification", () => {
		for (const previous of [
			toolStarted,
			{ ...toolCompleted, phase: "unknown" as const },
		]) {
			expect(() =>
				requireConversationOperationSuccessorV2([previous], verifiedTool, true),
			).toThrow();
		}
		expect(() =>
			requireConversationOperationSuccessorV2(
				[toolCompleted],
				verifiedTool,
				true,
			),
		).not.toThrow();
	});

	it.each(["intent", "started", "completed", "failed", "unknown"] as const)(
		"allows evidence-only updates in %s without changing the observed phase",
		(phase) => {
			const previous =
				phase === "intent"
					? toolIntent
					: phase === "started"
						? toolStarted
						: { ...toolCompleted, phase };
			expect(() =>
				requireConversationOperationSuccessorV2([previous], {
					...previous,
					connection: verifiedTool.connection,
				}),
			).not.toThrow();
		},
	);

	it("accepts late reference collection and keeps verified evidence across the next phase", () => {
		const { connection: _connection, ...withoutAssociation } = toolCompleted;
		expect(() =>
			requireConversationOperationSuccessorV2(
				[withoutAssociation],
				verifiedTool,
			),
		).not.toThrow();
		const verifiedStarted = {
			...toolStarted,
			connection: verifiedTool.connection,
		};
		expect(() =>
			requireConversationOperationSuccessorV2([verifiedStarted], verifiedTool),
		).not.toThrow();
	});

	it("rejects metadata updates that alter any original tool outcome or bind a different attempt", () => {
		const history = [toolIntent, toolStarted, toolCompleted];
		for (const change of [
			{ operationRef: "other-operation" },
			{ attemptRef: "other-attempt" },
			{ parentOperationRef: "other-operation" },
			{ toolId: "connection.github.delete_pr" },
			{ phase: "failed" },
			{ startedAt: "2026-09-14T12:00:00.001Z" },
			{ finishedAt: "2026-09-14T12:00:03.000Z" },
			{ durationMs: 3_000 },
			{ resultRef: "different-result" },
		])
			expect(() =>
				requireConversationOperationSuccessorV2(history, {
					...verifiedTool,
					...change,
				} as ConversationOperationFactV2),
			).toThrow();
	});

	it("keeps service, an existing call reference and verified evidence monotonic", () => {
		for (const connection of [
			{ ...verifiedTool.connection, serviceRef: "other-connection" },
			{ ...verifiedTool.connection, callRef: "other-call" },
			toolIntent.connection,
			toolCompleted.connection,
			undefined,
		])
			expect(() =>
				requireConversationOperationSuccessorV2([verifiedTool], {
					...verifiedTool,
					connection,
				}),
			).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([toolCompleted], {
				...toolIntent,
				attemptRef: "new-attempt",
				connection: { ...verifiedTool.connection, callRef: "another-call" },
			}),
		).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([verifiedTool], verifiedTool),
		).toThrow();
	});

	it("does not persist private evidence or associations on model facts", () => {
		for (const value of [
			{ ...intent, connection: verifiedTool.connection },
			{
				...toolCompleted,
				connection: {
					...verifiedTool.connection,
					operationNonce: "private-nonce",
				},
			},
			{
				...toolCompleted,
				connection: {
					...verifiedTool.connection,
					serviceRef: "https://arbitrary.test",
				},
			},
			{
				...toolCompleted,
				connection: {
					...verifiedTool.connection,
					callRef: "https://arbitrary.test/call",
				},
			},
			{
				...toolCompleted,
				connection: {
					...toolCompleted.connection,
					reason: "private response text",
				},
			},
		])
			expect(() => parseConversationOperationFactV2(value)).toThrow();
	});
});

describe("actual operation facts", () => {
	it("preserves missing measurements and only stores explicitly observed usage", () => {
		expect(parseConversationOperationFactV2(intent)).toEqual(intent);
		expect(parseConversationOperationFactV2(intent)).not.toHaveProperty(
			"usage",
		);
		expect(
			parseConversationOperationFactV2({
				...completed,
				usage: { inputTokens: 0, outputTokens: 8 },
			}),
		).toMatchObject({ usage: { inputTokens: 0, outputTokens: 8 } });
	});

	it("requires intent before each actual attempt and preserves unknown recovery", () => {
		expect(() =>
			requireConversationOperationSuccessorV2([], intent),
		).not.toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent], started),
		).not.toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent, started], unknown),
		).not.toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2(
				[intent, started, unknown],
				completed,
			),
		).not.toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([], started),
		).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent], completed),
		).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent, started], {
				...started,
			}),
		).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent, started, unknown], {
				...intent,
				attemptRef: "attempt-2",
			}),
		).toThrow();
	});

	it("allows a distinct attempt only after confirmed terminal facts and rejects ref reuse", () => {
		const retry = { ...intent, attemptRef: "attempt-2" };
		expect(() =>
			requireConversationOperationSuccessorV2(
				[intent, started, completed],
				retry,
			),
		).not.toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2(
				[intent, started, completed, retry],
				intent,
			),
		).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent], {
				...intent,
				operationRef: "another-operation",
			}),
		).toThrow();
	});

	it("rejects model, tool, parent and actual start rebinding", () => {
		for (const next of [
			{ ...started, model: { ...intent.model, modelOptionId: "owner-option" } },
			{ ...started, parentOperationRef: "unrelated-parent" },
			{ ...started, kind: "tool", toolId: "exec_command" },
		])
			expect(() =>
				requireConversationOperationSuccessorV2(
					[intent],
					next as ConversationOperationFactV2,
				),
			).toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent, started], {
				...completed,
				startedAt: "2026-09-14T12:00:00.500Z",
			}),
		).toThrow();
		const tool = {
			kind: "tool",
			operationRef: "tool-op-1",
			attemptRef: "tool-attempt-1",
			parentOperationRef: intent.operationRef,
			phase: "intent",
			toolId: "exec_command",
		} as const;
		expect(() =>
			requireConversationOperationSuccessorV2([intent], tool),
		).not.toThrow();
		expect(() =>
			requireConversationOperationSuccessorV2([intent, tool], {
				...tool,
				phase: "started",
				toolId: "other_tool",
			}),
		).toThrow();
	});

	it("rejects free text, invalid measurements and inconsistent phase metadata", () => {
		for (const value of [
			{ ...intent, prompt: "private conversation" },
			{ ...intent, model: { ...intent.model, modelId: "model\nprivate" } },
			{ ...intent, finishedAt: "2026-09-14T12:00:00.000Z" },
			{ ...started, durationMs: 12 },
			{ ...completed, failureCode: "operation_failed" },
			{ ...completed, durationMs: -1 },
			{ ...completed, finishedAt: "2026-09-14T11:59:00.000Z" },
			{ ...completed, usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
		])
			expect(() => parseConversationOperationFactV2(value)).toThrow();
		const getter = vi.fn(() => "intent");
		expect(() =>
			parseConversationOperationFactV2(
				Object.defineProperty({ ...intent }, "phase", {
					enumerable: true,
					get: getter,
				}),
			),
		).toThrow();
		expect(getter).not.toHaveBeenCalled();
	});

	it("persists mixed text and facts on one timeline and replays without another sequence", async () => {
		const events = new FakeConversationEventsV1({
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
			deliveryFence: 1,
		});
		const base = {
			schemaVersion: 1 as const,
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
			deliveryFence: 1,
			occurredAt: "2026-09-14T12:00:00.000Z",
		};
		const text = {
			...base,
			adapterEventKey: "text-1",
			runtimeCursor: "cursor-1",
			event: { type: "text.delta" as const, text: "original text" },
		};
		const operation = {
			...base,
			adapterEventKey: "operation-1",
			runtimeCursor: "cursor-2",
			event: {
				schemaVersion: 2 as const,
				type: "execution.operation" as const,
				fact: intent,
			},
		};
		await events.persist(text);
		const accepted = await events.persist(operation);
		expect(accepted).toMatchObject({
			outcome: "accepted",
			event: { sequence: 2, conversationCursor: 2, event: operation.event },
		});
		expect(
			await events.persist({ ...operation, deliveryFence: 0 }),
		).toMatchObject({
			outcome: "replayed",
			event: { sequence: 2, conversationCursor: 2 },
		});
		await expect(
			events.persist({
				...operation,
				adapterEventKey: "different-key",
				runtimeCursor: "cursor-3",
			}),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(events.snapshot().events).toHaveLength(2);
		expect(events.snapshot().events[0]?.schemaVersion).toBe(1);
		expect(events.runtimeCursor()).toBe("cursor-2");
	});
});
