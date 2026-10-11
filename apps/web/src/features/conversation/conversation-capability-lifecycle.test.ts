import { expect, it } from "vitest";
import {
	acceptConversationCapabilityV1,
	canStartConversationCapabilityV1,
	createConversationCapabilityLifecycleStateV1,
	resetConversationCapabilityLifecycleV1,
	retryConversationCapabilityV1,
	selectConversationCapabilityV1,
	settleConversationCapabilityV1,
} from "./conversation-capability-lifecycle.js";

it("requires explicit confirmation, preserves the attempt and models unknown recovery", () => {
	let state = createConversationCapabilityLifecycleStateV1(
		"alice:agent:conversation",
	);
	expect(canStartConversationCapabilityV1(state)).toBe(false);
	state = selectConversationCapabilityV1(
		state,
		"skill:workspace-summary",
		"SKILL.md",
	);
	expect(canStartConversationCapabilityV1(state)).toBe(true);
	state = acceptConversationCapabilityV1(state, "attempt-a");
	expect(state.phase).toBe("pending");
	state = settleConversationCapabilityV1(state, "unknown");
	expect(state.attemptId).toBe("attempt-a");
	state = retryConversationCapabilityV1(state);
	expect(state.phase).toBe("pending");
});

it("does not replace a pending or unknown attempt with a new selection", () => {
	let state = createConversationCapabilityLifecycleStateV1("scope");
	state = selectConversationCapabilityV1(state, "command:compact");
	state = acceptConversationCapabilityV1(state, "attempt-a");
	expect(
		selectConversationCapabilityV1(state, "skill:other").capabilityKey,
	).toBe("command:compact");
	state = settleConversationCapabilityV1(state, "unknown");
	expect(
		selectConversationCapabilityV1(state, "skill:other").capabilityKey,
	).toBe("command:compact");
});

it("clears local selection on scope change", () => {
	let state = createConversationCapabilityLifecycleStateV1(
		"alice:agent-a:conversation-a",
	);
	state = selectConversationCapabilityV1(state, "command:compact");
	state = acceptConversationCapabilityV1(state, "attempt-a");
	expect(
		resetConversationCapabilityLifecycleV1(state, "bob:agent-a:conversation-a"),
	).toMatchObject({
		phase: "idle",
		capabilityKey: undefined,
		attemptId: undefined,
	});
});
