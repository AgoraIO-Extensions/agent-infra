import { describe, expect, it } from "vitest";
import {
	RuntimeBrowserHandoffRequestV3Schema,
	RuntimeBrowserHandoffResponseV3Schema,
} from "./browser-handoff.ts";

const context = {
	schemaVersion: 3 as const,
	requestId: "request-handoff",
	traceId: "trace-handoff",
	principal: { kind: "user" as const, id: "subject-1" },
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: "host-session-1",
	operation: {
		kind: "execution" as const,
		id: "execution-1",
		deliveryFence: 1,
		executionDeliveryFence: 1,
	},
	grant: {
		schemaVersion: 2 as const,
		format: "runtime-execution-jws" as const,
		token: "header.payload.signature",
	},
};

const runtime = {
	browserAlive: true,
	authorized: true,
	subjectId: "subject-1",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	sessionGeneration: 1,
	resourceFence: 1,
	workloadRevision: 1,
	imageDigest: `sha256:${"a".repeat(64)}`,
	capabilityVersion: 1,
	pageRevision: 1,
};

describe("Runtime Browser handoff V3 contract", () => {
	it.each([
		"request",
		"take-over",
		"return-to-agent",
		"revoke",
		"browser-crashed",
	] as const)("accepts the %s transition", (kind) => {
		const handoff =
			kind === "request"
				? { kind, reason: "mfa" as const, runtime }
				: kind === "take-over"
					? {
							kind,
							handoffId: "handoff-1",
							operatorId: "subject-1",
							subjectId: "subject-1",
							runtime,
						}
					: kind === "return-to-agent"
						? { kind, handoffId: "handoff-1", operatorId: "subject-1", runtime }
						: kind === "revoke"
							? { kind, reason: "BROWSER_HANDOFF_REVOKED" as const, runtime }
							: { kind, runtime };
		expect(
			RuntimeBrowserHandoffRequestV3Schema.safeParse({ ...context, handoff }),
		).toMatchObject({ success: true });
	});

	it("rejects a handoff response with an unknown status", () => {
		expect(
			RuntimeBrowserHandoffResponseV3Schema.safeParse({
				schemaVersion: 3,
				hostSessionRef: "host-session-1",
				executionId: "execution-1",
				outcome: "accepted",
				record: {
					handoffId: "handoff-1",
					status: "bogus",
					reason: "mfa",
					requestedAt: "2026-10-14T00:00:00.000Z",
					expiresAt: "2026-10-14T00:05:00.000Z",
				},
			}),
		).toMatchObject({ success: false });
	});
});
