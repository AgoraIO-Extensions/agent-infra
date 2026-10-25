import {
	ConversationDetailProjectionV2Schema,
	PersistedConversationEventV1Schema,
	ReasoningDeltaEventV2Schema,
	TaskStatusEventV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import {
	answerText,
	currentExecution,
	elapsedSecondsLabel,
	emptyAnswerKind,
	executionPhase,
	executionPhaseLabel,
	isTerminal,
	reasoningTexts,
} from "./conversation-screen-state.js";
import { event, history, timestamp } from "./conversation-test-fixtures.js";

describe("current conversation execution", () => {
	it.each(["failed", "cancelled", "completed"] as const)(
		"keeps stop timeout uncertain until a persisted %s event arrives",
		(status) => {
			const unknown = TaskStatusEventV1Schema.parse({
				...event(1),
				type: "task.status",
				payload: { status: "unknown", reason: "STOP_CONFIRMATION_TIMEOUT" },
			});
			const before = currentExecution(null, [unknown]);
			expect(before).toEqual({
				executionId: unknown.executionId,
				status: "unknown",
			});
			expect(isTerminal(before.status)).toBe(false);
			const terminal = PersistedConversationEventV1Schema.parse({
				...event(2),
				type: "execution.status",
				payload: { status },
			});
			const projection = ConversationDetailProjectionV2Schema.parse(
				history("conversation-1", [unknown, terminal]),
			);
			expect(currentExecution(projection, projection.events)).toEqual({
				executionId: terminal.executionId,
				status,
			});
			expect(currentExecution(null, [unknown, terminal])).toEqual(
				currentExecution(projection, projection.events),
			);
		},
	);
	it("keeps an accepted user execution selected until its status is persisted", () => {
		const older = PersistedConversationEventV1Schema.parse({
			...event(1),
			schemaVersion: 1,
			type: "execution.status",
			payload: { status: "processing" },
		});
		const projection = ConversationDetailProjectionV2Schema.parse({
			...history("conversation-1", [older]),
			messages: [
				{
					messageId: "message-2",
					role: "user",
					text: "New request",
					status: "submitted",
					executionId: "execution-2",
					replyToMessageId: null,
					answerVersion: null,
					isCurrentAnswer: null,
					error: null,
					createdAt: timestamp,
				},
			],
		});

		expect(
			currentExecution(projection, projection.events, "execution-2"),
		).toEqual({ executionId: "execution-2", status: "submitted" });
	});

	it("allows a newer active execution to win after the accepted status is persisted", () => {
		const accepted = PersistedConversationEventV1Schema.parse({
			...event(1),
			executionId: "execution-1",
			type: "execution.status",
			payload: { status: "completed" },
		});
		const newer = PersistedConversationEventV1Schema.parse({
			...event(2),
			executionId: "execution-2",
			type: "execution.status",
			payload: { status: "processing" },
		});
		const projection = ConversationDetailProjectionV2Schema.parse(
			history("conversation-1", [accepted, newer]),
		);

		expect(
			currentExecution(projection, projection.events, "execution-1"),
		).toEqual({ executionId: "execution-2", status: "processing" });
	});

	it("keeps a newer user execution ahead of an older assistant execution", () => {
		const olderStatus = PersistedConversationEventV1Schema.parse({
			...event(2),
			type: "execution.status",
			payload: { status: "processing" },
		});
		const projection = ConversationDetailProjectionV2Schema.parse({
			...history("conversation-1", [olderStatus]),
			messages: [
				{
					messageId: "message-1",
					role: "assistant",
					text: "Older answer",
					status: "processing",
					executionId: "execution-1",
					replyToMessageId: null,
					answerVersion: 1,
					isCurrentAnswer: true,
					error: null,
					createdAt: timestamp,
				},
				{
					messageId: "message-2",
					role: "user",
					text: "New request",
					status: "submitted",
					executionId: "execution-2",
					replyToMessageId: null,
					answerVersion: null,
					isCurrentAnswer: null,
					error: null,
					createdAt: timestamp,
				},
			],
		});

		expect(currentExecution(projection, projection.events)).toEqual({
			executionId: "execution-2",
			status: "submitted",
		});
	});

	it("settles on a terminal assistant result whose terminal event is missing (#1524)", () => {
		const processing = PersistedConversationEventV1Schema.parse({
			...event(1),
			executionId: "execution-1",
			type: "execution.status",
			payload: { status: "processing" },
		});
		const projection = ConversationDetailProjectionV2Schema.parse({
			...history("conversation-1", [processing]),
			messages: [
				{
					messageId: "message-1",
					role: "user",
					text: "Request",
					status: "submitted",
					executionId: "execution-1",
					replyToMessageId: null,
					answerVersion: null,
					isCurrentAnswer: null,
					error: null,
					createdAt: timestamp,
				},
				{
					messageId: "message-2",
					role: "assistant",
					text: "Answer",
					status: "completed",
					executionId: "execution-1",
					replyToMessageId: "message-1",
					answerVersion: 1,
					isCurrentAnswer: true,
					error: null,
					createdAt: timestamp,
				},
			],
		});

		expect(currentExecution(projection, projection.events)).toEqual({
			executionId: "execution-1",
			status: "completed",
		});
	});

	it("does not keep a cancelled reply pending when no status event exists (#1524)", () => {
		const projection = ConversationDetailProjectionV2Schema.parse({
			...history("conversation-1", []),
			messages: [
				{
					messageId: "message-1",
					role: "user",
					text: "Request",
					status: "submitted",
					executionId: "execution-1",
					replyToMessageId: null,
					answerVersion: null,
					isCurrentAnswer: null,
					error: null,
					createdAt: timestamp,
				},
				{
					messageId: "message-2",
					role: "assistant",
					text: "",
					status: "cancelled",
					executionId: "execution-1",
					replyToMessageId: "message-1",
					answerVersion: 1,
					isCurrentAnswer: true,
					error: null,
					createdAt: timestamp,
				},
			],
		});

		expect(
			currentExecution(projection, projection.events, "execution-1"),
		).toEqual({ executionId: "execution-1", status: "cancelled" });
	});

	it("keeps a later terminal event ahead of an assistant result", () => {
		const cancelled = PersistedConversationEventV1Schema.parse({
			...event(1),
			executionId: "execution-1",
			type: "execution.status",
			payload: { status: "cancelled" },
		});
		const projection = ConversationDetailProjectionV2Schema.parse({
			...history("conversation-1", [cancelled]),
			messages: [
				{
					messageId: "message-2",
					role: "assistant",
					text: "Partial",
					status: "completed",
					executionId: "execution-1",
					replyToMessageId: null,
					answerVersion: 1,
					isCurrentAnswer: true,
					error: null,
					createdAt: timestamp,
				},
			],
		});

		expect(currentExecution(projection, projection.events)).toEqual({
			executionId: "execution-1",
			status: "cancelled",
		});
	});
});

describe("answers without body text (NW-15)", () => {
	const projection = ConversationDetailProjectionV2Schema.parse(
		history("conversation-1", [
			PersistedConversationEventV1Schema.parse({
				...event(2),
				executionId: "execution-loaded",
			}),
		]),
	);

	it("only treats a completed reply outside the loaded window as not loaded", () => {
		expect(
			emptyAnswerKind(projection, [], "execution-old", "completed", true),
		).toBe("not_loaded");
		for (const status of ["failed", "cancelled", "processing"] as const)
			expect(
				emptyAnswerKind(projection, [], "execution-old", status, true),
			).toBe("empty");
	});

	it("does not call a reply not loaded when its events are loaded or nothing is earlier", () => {
		expect(
			emptyAnswerKind(projection, [], "execution-loaded", "completed", true),
		).toBe("empty");
		expect(
			emptyAnswerKind(projection, [], "execution-old", "completed", false),
		).toBe("empty");
		expect(emptyAnswerKind(projection, [], null, "completed", true)).toBe(
			"empty",
		);
	});
});

describe("reasoning deltas in the timeline (#2979)", () => {
	const reasoning = (sequence: number, kind: "raw" | "summary") =>
		ReasoningDeltaEventV2Schema.parse({
			...event(sequence),
			schemaVersion: 2,
			type: "reasoning.delta",
			payload: { kind, text: `thought ${sequence}` },
		});

	it("keeps the answer text to text deltas while the history accepts reasoning", () => {
		const projection = ConversationDetailProjectionV2Schema.parse(
			history("conversation-1", [event(1)]),
		);
		const live = [
			...projection.events,
			reasoning(2, "raw"),
			event(3),
			reasoning(4, "summary"),
		];
		expect(answerText(projection, live, "execution-1", "output 1")).toBe(
			"output 1output 3",
		);
		// 思考过程同样属于该 Execution 的已加载事件，不会把回复误判为「未加载」。
		expect(
			emptyAnswerKind(
				projection,
				[reasoning(5, "raw")],
				"execution-1",
				"completed",
				true,
			),
		).toBe("empty");
	});
});

describe("thinking text per execution (#2981)", () => {
	const reasoning = (
		sequence: number,
		kind: "raw" | "summary",
		text: string,
		executionId = "execution-1",
	) =>
		ReasoningDeltaEventV2Schema.parse({
			...event(sequence),
			executionId,
			schemaVersion: 2,
			type: "reasoning.delta",
			payload: { kind, text },
		});

	it("joins each execution's reasoning in arrival order, summary before raw", () => {
		const texts = reasoningTexts([
			reasoning(1, "raw", "think "),
			event(2),
			reasoning(3, "summary", "Plan"),
			reasoning(4, "raw", "more"),
			reasoning(5, "raw", "other", "execution-2"),
			reasoning(6, "summary", "\n\nNext"),
		]);
		expect(texts.get("execution-1")).toBe("Plan\n\nNext\n\nthink more");
		expect(texts.get("execution-2")).toBe("other");
		// 正文增量不进入思考过程；没有思考的 Execution 没有条目。
		expect([...texts.keys()]).toEqual(["execution-1", "execution-2"]);
	});
});

describe("reply progress labels (#3377)", () => {
	it("names phases like the WeCom phase line and only for the given execution", () => {
		expect(executionPhaseLabel({ kind: "queued" })).toBe("排队中");
		expect(executionPhaseLabel({ kind: "preparing" })).toBe("准备会话");
		expect(executionPhaseLabel({ kind: "running" })).toBe("执行中");
		expect(
			executionPhaseLabel({ kind: "tool", toolId: "browser_observe" }),
		).toBe("调用工具：读取页面");
		expect(executionPhaseLabel({ kind: "tool", toolId: "shell" })).toBe(
			"调用工具：shell",
		);
		expect(executionPhaseLabel({ kind: "model_retry" })).toBe("模型重试");
		const other = PersistedConversationEventV1Schema.parse({
			...event(1),
			executionId: "execution-2",
			type: "execution.status",
			payload: { status: "processing" },
		});
		expect(executionPhase([other], "execution-1", "submitted")).toEqual({
			kind: "preparing",
		});
		expect(executionPhase([other], null, "processing")).toBeNull();
	});

	it("counts whole elapsed seconds and ignores an unusable start", () => {
		const now = new Date("2026-09-15T10:01:05.900Z");
		expect(elapsedSecondsLabel("2026-09-15T10:00:00Z", now)).toBe("已用 65 秒");
		expect(elapsedSecondsLabel("2026-09-15T10:02:00Z", now)).toBe("已用 0 秒");
		expect(elapsedSecondsLabel("not a time", now)).toBeNull();
	});
});
