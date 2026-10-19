import { PersistedConversationEventV2Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import {
	modelFallbackReason,
	modelFallbacks,
	removedModelOptionLabel,
} from "./conversation-model-fallback.js";
import { event, timestamp } from "./conversation-test-fixtures.js";

const fallback = (executionId: string, modelOptionId: string) =>
	PersistedConversationEventV2Schema.parse({
		...event(1),
		executionId,
		type: "model.selection.fell_back",
		payload: {
			modelOptionId,
			reasoningLevel: "medium",
			reason: "selection_unavailable",
		},
	});

/** G-07 起的 V2 回退事件：服务端在回退时记录原选项及其显示名（读不到时为 null）。 */
const fallbackV2 = (
	executionId: string,
	requestedModelDisplayName: string | null,
) =>
	PersistedConversationEventV2Schema.parse({
		...event(1),
		schemaVersion: 2,
		executionId,
		type: "model.selection.fell_back",
		payload: {
			modelOptionId: "option-default",
			reasoningLevel: "medium",
			reason: "selection_unavailable",
			requestedModelOptionId: "option-removed",
			requestedModelDisplayName,
		},
	});

const modelFact = (executionId: string, modelId: string) =>
	PersistedConversationEventV2Schema.parse({
		schemaVersion: 2,
		kind: "event",
		eventId: `operation-${executionId}`,
		conversationId: "conversation-1",
		executionId,
		sequence: 2,
		conversationCursor: `cursor-${executionId}`,
		occurredAt: timestamp,
		type: "execution.operation",
		payload: {
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "model",
			phase: "completed",
			model: {
				configVersion: "config-1",
				modelOptionId: "opaque-option",
				modelId,
			},
		},
	});

describe("model fallback facts (G-07)", () => {
	it("resolves the actual model without ever exposing the opaque option id", () => {
		const options = [
			{ optionId: "option-default", displayName: "Default model" },
		];
		const result = modelFallbacks(
			[
				fallback("execution-listed", "option-default"),
				fallback("execution-observed", "option-removed"),
				modelFact("execution-observed", "gpt-observed"),
				fallback("execution-unknown", "option-removed"),
			],
			options,
		);
		// 旧 V1 事件没有请求模型：一律写中性文案，不推断、不显示 ID。
		expect(result.get("execution-listed")).toEqual({
			requestedModel: removedModelOptionLabel,
			actualModel: "Default model",
		});
		expect(result.get("execution-observed")).toEqual({
			requestedModel: removedModelOptionLabel,
			actualModel: "gpt-observed",
		});
		expect(result.get("execution-unknown")).toEqual({
			requestedModel: removedModelOptionLabel,
			actualModel: "未提供",
		});
		expect(result.has("execution-other")).toBe(false);
	});

	it("shows the requested model recorded at fallback time, never the option id", () => {
		const options = [
			{ optionId: "option-default", displayName: "Default model" },
			// 当前清单里即使出现同 ID 的选项，也只采用回退时记录的显示名。
			{ optionId: "option-removed", displayName: "Renamed later" },
		];
		const result = modelFallbacks(
			[
				fallbackV2("execution-named", "gpt-removed"),
				fallbackV2("execution-unnamed", null),
				fallbackV2("execution-blank", "   "),
			],
			options,
		);
		expect(result.get("execution-named")).toEqual({
			requestedModel: "gpt-removed",
			actualModel: "Default model",
		});
		for (const executionId of ["execution-unnamed", "execution-blank"]) {
			expect(result.get(executionId)).toEqual({
				requestedModel: removedModelOptionLabel,
				actualModel: "Default model",
			});
		}
		for (const fallback of result.values()) {
			expect(Object.values(fallback).join(" ")).not.toContain("option-");
		}
	});

	it("only reports executions that carry a fallback event", () => {
		expect(modelFallbacks([modelFact("execution-1", "gpt")], []).size).toBe(0);
	});

	it("does not claim the requested model was temporarily unavailable (PRD §8.2)", () => {
		expect(modelFallbackReason).not.toContain("暂时不可用");
	});
});
