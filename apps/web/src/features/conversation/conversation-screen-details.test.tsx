import { ExecutionDetailProjectionV2Schema } from "@agent-infra/contracts/pilot";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationExecutionDetails } from "./conversation-screen-details.js";

describe("ConversationExecutionDetails", () => {
	it("shows requested, actual and fallback reason from trusted facts", () => {
		const data = ExecutionDetailProjectionV2Schema.parse({
			schemaVersion: 2,
			conversationId: "conversation-1",
			executionId: "execution-1",
			status: "completed",
			error: null,
			startedAt: "2026-09-15T10:00:00Z",
			finishedAt: "2026-09-15T10:00:01Z",
			processSummary: [],
			events: [
				{
					schemaVersion: 1,
					kind: "event",
					eventId: "fallback-event",
					conversationId: "conversation-1",
					executionId: "execution-1",
					sequence: 1,
					conversationCursor: "cursor-1",
					occurredAt: "2026-09-15T10:00:00Z",
					type: "model.selection.fell_back",
					payload: {
						modelOptionId: "option-actual",
						reasoningLevel: "medium",
						reason: "selection_unavailable",
					},
				},
				{
					schemaVersion: 2,
					kind: "event",
					eventId: "operation-event",
					conversationId: "conversation-1",
					executionId: "execution-1",
					sequence: 2,
					conversationCursor: "cursor-2",
					occurredAt: "2026-09-15T10:00:01Z",
					type: "execution.operation",
					payload: {
						kind: "model",
						operationRef: "operation-1",
						attemptRef: "attempt-1",
						phase: "completed",
						model: {
							configVersion: "config-1",
							modelOptionId: "option-actual",
							modelId: "gpt-5",
						},
					},
				},
			],
		});

		render(
			<ConversationExecutionDetails
				data={data}
				conversationId="conversation-1"
				loading={false}
				failed={false}
				onRetry={vi.fn()}
				onClose={vi.fn()}
				requestedModelOptionId="option-requested"
				modelOptions={[
					{ optionId: "option-requested", displayName: "请求模型" },
					{ optionId: "option-actual", displayName: "实际模型" },
				]}
			/>,
		);

		const status = screen.getByRole("region", { name: "模型状态" });
		expect(status.textContent).toContain("请求模型");
		expect(status.textContent).toContain("实际模型");
		expect(status.textContent).toContain("请求模型选项不可用");
		expect(status.textContent).toContain("不会静默切换到个人 Key 或未授权模型");
	});

	it("uses the latest model and fallback facts when an execution retries", () => {
		const data = ExecutionDetailProjectionV2Schema.parse({
			schemaVersion: 2,
			conversationId: "conversation-1",
			executionId: "execution-1",
			status: "completed",
			error: null,
			startedAt: "2026-09-15T10:00:00Z",
			finishedAt: "2026-09-15T10:00:01Z",
			processSummary: [],
			events: [
				{
					schemaVersion: 1,
					kind: "event",
					eventId: "fallback-first",
					conversationId: "conversation-1",
					executionId: "execution-1",
					sequence: 1,
					conversationCursor: "cursor-1",
					occurredAt: "2026-09-15T10:00:00Z",
					type: "model.selection.fell_back",
					payload: {
						modelOptionId: "option-first",
						reasoningLevel: "medium",
						reason: "selection_unavailable",
					},
				},
				{
					schemaVersion: 2,
					kind: "event",
					eventId: "operation-first",
					conversationId: "conversation-1",
					executionId: "execution-1",
					sequence: 2,
					conversationCursor: "cursor-2",
					occurredAt: "2026-09-15T10:00:00Z",
					type: "execution.operation",
					payload: {
						kind: "model",
						operationRef: "operation-first",
						attemptRef: "attempt-first",
						phase: "failed",
						model: {
							configVersion: "config-1",
							modelOptionId: "option-first",
							modelId: "gpt-first",
						},
					},
				},
				{
					schemaVersion: 1,
					kind: "event",
					eventId: "fallback-last",
					conversationId: "conversation-1",
					executionId: "execution-1",
					sequence: 3,
					conversationCursor: "cursor-3",
					occurredAt: "2026-09-15T10:00:01Z",
					type: "model.selection.fell_back",
					payload: {
						modelOptionId: "option-last",
						reasoningLevel: "high",
						reason: "selection_unavailable",
					},
				},
				{
					schemaVersion: 2,
					kind: "event",
					eventId: "operation-last",
					conversationId: "conversation-1",
					executionId: "execution-1",
					sequence: 4,
					conversationCursor: "cursor-4",
					occurredAt: "2026-09-15T10:00:01Z",
					type: "execution.operation",
					payload: {
						kind: "model",
						operationRef: "operation-last",
						attemptRef: "attempt-last",
						phase: "completed",
						model: {
							configVersion: "config-1",
							modelOptionId: "option-last",
							modelId: "gpt-last",
						},
					},
				},
			],
		});

		render(
			<ConversationExecutionDetails
				data={data}
				conversationId="conversation-1"
				loading={false}
				failed={false}
				onRetry={vi.fn()}
				onClose={vi.fn()}
				requestedModelOptionId="option-requested"
				modelOptions={[
					{ optionId: "option-requested", displayName: "请求模型" },
					{ optionId: "option-first", displayName: "旧模型" },
					{ optionId: "option-last", displayName: "最终模型" },
				]}
			/>,
		);

		const status = screen.getAllByRole("region", { name: "模型状态" }).at(-1);
		expect(status).toBeTruthy();
		expect(status.textContent).toContain("最终模型");
		expect(status.textContent).not.toContain("旧模型");
	});
});
