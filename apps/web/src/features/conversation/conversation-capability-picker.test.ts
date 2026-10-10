import { describe, expect, it } from "vitest";
import {
	confirmConversationCapability,
	createConversationCapabilityPickerState,
	filterConversationCapabilities,
	markConversationCapabilityConfirmed,
	moveConversationCapabilitySelection,
	resetConversationCapabilityScope,
	selectConversationCapability,
	updateConversationCapabilityParameter,
	updateConversationCapabilityQuery,
} from "./conversation-capability-picker.js";

const capabilities = [
	{
		kind: "skill" as const,
		name: "workspace-summary",
		description: "Summarize approved workspace files",
		source: "skillhub",
		version: "1.0.0",
		parameterHint: "file",
	},
	{
		kind: "command" as const,
		name: "compact",
		description: "Compact the current native session",
		source: "codex",
	},
];

describe("conversation capability picker model", () => {
	it("filters injected capabilities without creating a transport request", () => {
		expect(filterConversationCapabilities(capabilities, "workspace")).toEqual([
			capabilities[0],
		]);
	});

	it("moves selection cyclically and requires explicit confirmation", () => {
		let state = createConversationCapabilityPickerState(
			"alice:agent-a:conversation-a",
		);
		state = updateConversationCapabilityQuery(state, "/");
		state = moveConversationCapabilitySelection(state, capabilities, 1);
		expect(state.selectedIndex).toBe(1);
		state = selectConversationCapability(state, capabilities[1]);
		state = updateConversationCapabilityParameter(state, "context");
		expect(confirmConversationCapability(state)).toEqual({
			kind: "command",
			name: "compact",
			parameterText: "context",
		});
		expect(markConversationCapabilityConfirmed(state).confirmed).toBe(true);
	});

	it("clears selection and confirmation when scope changes", () => {
		let state = createConversationCapabilityPickerState(
			"alice:agent-a:conversation-a",
		);
		state = selectConversationCapability(state, capabilities[0]);
		state = updateConversationCapabilityParameter(state, "SKILL.md");
		state = markConversationCapabilityConfirmed(state);
		const reset = resetConversationCapabilityScope(
			state,
			"bob:agent-a:conversation-a",
		);
		expect(reset.selected).toBeUndefined();
		expect(reset.parameterText).toBe("");
		expect(reset.confirmed).toBe(false);
	});

	it("rejects oversized UTF-8 parameter text", () => {
		let state = createConversationCapabilityPickerState("scope");
		state = selectConversationCapability(state, capabilities[0]);
		state = updateConversationCapabilityParameter(state, "你".repeat(4096));
		expect(state.parameterText).toBe("");
		expect(confirmConversationCapability(state)?.parameterText).toBe("");
	});
});
