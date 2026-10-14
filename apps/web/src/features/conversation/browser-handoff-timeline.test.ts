import { describe, expect, it } from "vitest";
import { latestBrowserHandoffTimelineEventV1 } from "./browser-handoff-timeline.js";

const event = (handoffId: string) => ({
	type: "browser.handoff" as const,
	payload: {
		handoffId,
		status: "requested" as const,
		reason: "mfa" as const,
		expiresAt: "2026-10-15T00:05:00.000Z",
		binding: {
			subjectId: "subject-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 2,
			resourceFence: 7,
			workloadRevision: 3,
			imageDigest: `sha256:${"a".repeat(64)}`,
			capabilityVersion: 4,
			pageRevision: 5,
		},
	},
});

describe("Browser handoff timeline projection", () => {
	it("retains the latest event after timeline replay deduplication", () => {
		const first = event("handoff-1");
		const latest = {
			...event("handoff-2"),
			payload: { ...event("handoff-2").payload, status: "active" as const },
		};
		expect(latestBrowserHandoffTimelineEventV1([first, latest])).toEqual(
			latest,
		);
		expect(latestBrowserHandoffTimelineEventV1([first, first])).toEqual(first);
	});

	it("ignores malformed or non-handoff events", () => {
		expect(
			latestBrowserHandoffTimelineEventV1([
				{ type: "execution.status", payload: {} },
				{ type: "browser.handoff", payload: { handoffId: "" } },
			]),
		).toBeUndefined();
	});
});
