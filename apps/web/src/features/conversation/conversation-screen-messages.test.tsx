import {
	ConversationDetailProjectionV2Schema,
	PersistedConversationEventV2Schema,
} from "@agent-infra/contracts/pilot";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMessages } from "./conversation-screen-messages.js";
import { history, timestamp } from "./conversation-test-fixtures.js";

afterEach(cleanup);

type Status = "processing" | "completed";

function fact(
	executionId: string,
	sequence: number,
	payload: { text: string } | { status: Status },
) {
	return PersistedConversationEventV2Schema.parse({
		schemaVersion: 1,
		kind: "event",
		eventId: `event-${executionId}-${sequence}`,
		conversationId: "conversation-1",
		executionId,
		sequence,
		conversationCursor: `cursor-${executionId}-${sequence}`,
		occurredAt: timestamp,
		type: "text" in payload ? "text.delta" : "execution.status",
		payload,
	});
}

function message(
	messageId: string,
	role: "user" | "assistant",
	text: string,
	status: Status,
	executionId: string,
	replyToMessageId: string | null = null,
) {
	return {
		messageId,
		role,
		text,
		status,
		executionId,
		replyToMessageId,
		answerVersion: role === "assistant" ? 1 : null,
		isCurrentAnswer: role === "assistant" ? true : null,
		error: null,
		createdAt: timestamp,
	};
}

function timeline(
	messages: ReturnType<typeof message>[],
	events: ReturnType<typeof fact>[],
	stopExecution?: string,
) {
	render(
		<ConversationMessages
			agentName="Agent"
			userName="用户"
			history={ConversationDetailProjectionV2Schema.parse({
				...history("conversation-1", events),
				messages,
			})}
			events={events}
			onExecution={vi.fn()}
			onRegenerate={vi.fn()}
			canRegenerate
			onResend={vi.fn()}
			hasEarlier={false}
			earlierLoading={false}
			earlierFailure={false}
			onLoadEarlier={vi.fn()}
			stop={
				stopExecution
					? {
							executionId: stopExecution,
							label: "停止回复",
							disabled: false,
							onStop: vi.fn(),
						}
					: undefined
			}
		/>,
	);
	const region = screen.getByRole("region", { name: "会话时间线" });
	return {
		region,
		labels: within(region)
			.getAllByRole("article")
			.map((node) => node.getAttribute("aria-label")),
	};
}

// #3449 N16-01：补充指令沿用原回复的 Execution，答案在原消息的回复中更新（PRD §11.2）。
describe("supplementary instructions in the timeline (#3449 N16-01)", () => {
	const question = message(
		"q1",
		"user",
		"整理变更说明",
		"processing",
		"exec-1",
	);
	const supplement = message(
		"s1",
		"user",
		"只看 apps/web",
		"processing",
		"exec-1",
	);

	it("keeps one processing reply card under the source message when the reply has no output yet", () => {
		const { region, labels } = timeline(
			[question, supplement],
			[fact("exec-1", 1, { status: "processing" })],
			"exec-1",
		);
		expect(labels).toEqual(["用户的消息", "Agent的消息", "用户的消息"]);
		expect(
			within(region).getAllByRole("button", { name: "停止回复" }),
		).toHaveLength(1);
		expect(within(region).getByText("只看 apps/web")).toBeTruthy();
	});

	it("keeps one processing reply card when the source message already has an answer", () => {
		const events = [
			fact("exec-1", 1, { status: "processing" }),
			fact("exec-1", 2, { text: "正在整理第一部分。" }),
		];
		const { region, labels } = timeline(
			[
				question,
				message(
					"a1",
					"assistant",
					"正在整理第一部分。",
					"processing",
					"exec-1",
					"q1",
				),
				supplement,
			],
			events,
			"exec-1",
		);
		expect(labels).toEqual(["用户的消息", "Agent的消息", "用户的消息"]);
		expect(
			within(region).getAllByRole("button", { name: "停止回复" }),
		).toHaveLength(1);
		expect(within(region).getAllByText("正在整理第一部分。")).toHaveLength(1);
	});

	it("shows the finished answer once, only under the source message", () => {
		const events = [
			fact("exec-1", 1, { status: "processing" }),
			fact("exec-1", 2, { text: "已按 apps/web 收窄。" }),
			fact("exec-1", 3, { status: "completed" }),
		];
		const { region, labels } = timeline(
			[
				{ ...question, status: "completed" },
				message(
					"a1",
					"assistant",
					"已按 apps/web 收窄。",
					"completed",
					"exec-1",
					"q1",
				),
				{ ...supplement, status: "completed" },
			],
			events,
		);
		expect(labels).toEqual(["用户的消息", "Agent的消息", "用户的消息"]);
		expect(within(region).getAllByText("已按 apps/web 收窄。")).toHaveLength(1);
		expect(
			within(region).getAllByRole("button", { name: /^重新生成/ }),
		).toHaveLength(1);
	});

	it("still gives a later message with its own execution its own reply card", () => {
		const events = [
			fact("exec-1", 1, { text: "第一轮的答案。" }),
			fact("exec-1", 2, { status: "completed" }),
			fact("exec-2", 1, { status: "processing" }),
		];
		const { labels } = timeline(
			[
				{ ...question, status: "completed" },
				message(
					"a1",
					"assistant",
					"第一轮的答案。",
					"completed",
					"exec-1",
					"q1",
				),
				message("q2", "user", "下一轮", "processing", "exec-2"),
			],
			events,
			"exec-2",
		);
		expect(labels).toEqual([
			"用户的消息",
			"Agent的消息",
			"用户的消息",
			"Agent的消息",
		]);
	});
});
