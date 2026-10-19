import { PersistedConversationEventV2Schema } from "@agent-infra/contracts/pilot";
import { describe, expect, it } from "vitest";
import {
	modelFallbackReason,
	modelFallbacks,
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
		expect(result.get("execution-listed")).toEqual({
			actualModel: "Default model",
		});
		expect(result.get("execution-observed")).toEqual({
			actualModel: "gpt-observed",
		});
		expect(result.get("execution-unknown")).toEqual({ actualModel: "未提供" });
		expect(result.has("execution-other")).toBe(false);
	});

	it("only reports executions that carry a fallback event", () => {
		expect(modelFallbacks([modelFact("execution-1", "gpt")], []).size).toBe(0);
	});

	it("does not claim the requested model was temporarily unavailable (PRD §8.2)", () => {
		expect(modelFallbackReason).not.toContain("暂时不可用");
	});
});
