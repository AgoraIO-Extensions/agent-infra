import {
	ConversationDetailProjectionV2Schema,
	PersistedConversationEventV1Schema,
} from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import {
	currentExecution,
	emptyAnswerKind,
} from "./conversation-screen-state.js";
import { event, history, timestamp } from "./conversation-test-fixtures.js";

describe("current conversation execution", () => {
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
