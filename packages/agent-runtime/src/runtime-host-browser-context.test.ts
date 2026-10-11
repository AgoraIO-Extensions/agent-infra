import { describe, expect, it } from "vitest";
import { runtimeBrowserExecutionContextForCommand } from "./runtime-host.js";

const browser = {
	capabilityVersion: 1,
	binding: {
		agentId: "agent-1",
		conversationId: "conversation-1",
		sessionGeneration: 2,
		resourceFence: 7,
		workloadRevision: 3,
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
} as const;

const command = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	sessionGeneration: 2,
} as const;

describe("RuntimeHost Browser execution context", () => {
	it("passes the verified context for the matching Session command", () => {
		expect(runtimeBrowserExecutionContextForCommand(browser, command)).toBe(
			browser,
		);
	});

	it.each([
		["agent", { agentId: "agent-2" }],
		["conversation", { conversationId: "conversation-2" }],
		["generation", { sessionGeneration: 3 }],
	])("fails closed on a foreign %s", (_name, change) => {
		expect(
			runtimeBrowserExecutionContextForCommand(browser, {
				...command,
				...change,
			}),
		).toBeUndefined();
	});

	it("fails closed when readiness has no Browser context", () => {
		expect(runtimeBrowserExecutionContextForCommand(undefined, command)).toBe(
			undefined,
		);
	});
});
