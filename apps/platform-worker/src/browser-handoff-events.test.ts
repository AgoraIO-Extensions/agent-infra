import type {
	RuntimeBrowserHandoffRequestV3,
	RuntimeBrowserHandoffResponseV3,
} from "@agent-infra/contracts/runtime";
import type { ConversationEventUseCaseV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserHandoffEventInputV1,
	createBrowserHandoffEventAdapterV1,
} from "./browser-handoff-events.js";

const request: RuntimeBrowserHandoffRequestV3 = {
	schemaVersion: 3,
	requestId: "request-handoff",
	traceId: "trace-handoff",
	principal: { kind: "user", id: "subject-1" },
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 2,
	hostSessionRef: "host-session-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 7,
		executionDeliveryFence: 7,
	},
	grant: {
		schemaVersion: 2,
		format: "runtime-execution-jws",
		token: "header.payload.signature",
	},
	handoff: {
		kind: "request",
		reason: "mfa",
		runtime: {
			browserAlive: true,
			authorized: true,
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
};

function response(
	status: NonNullable<RuntimeBrowserHandoffResponseV3["record"]>["status"],
): RuntimeBrowserHandoffResponseV3 {
	return {
		schemaVersion: 3,
		hostSessionRef: "host-session-1",
		executionId: "execution-1",
		outcome: "accepted",
		record: {
			handoffId: "handoff-1",
			status,
			reason: "mfa",
			requestedAt: "2026-10-14T00:00:00.000Z",
			expiresAt: "2026-10-14T00:05:00.000Z",
			...(status === "active" || status === "returning"
				? { operatorId: "subject-1" }
				: {}),
			...(status === "completed"
				? { terminalReason: "BROWSER_HANDOFF_RETURNED" }
				: {}),
		},
	};
}

function setup(
	result: RuntimeBrowserHandoffResponseV3 = response("requested"),
) {
	const persist = vi.fn(async (command) => ({
		outcome: "accepted" as const,
		event: {
			schemaVersion: 1 as const,
			eventId: "event-1",
			conversationId: command.conversationId,
			executionId: command.executionId,
			sequence: 1,
			conversationCursor: 1,
			occurredAt: command.occurredAt,
			event: command.event,
		},
	}));
	const browserHandoff = vi.fn(async () => result);
	const adapter = createBrowserHandoffEventAdapterV1({
		runtime: { browserHandoff },
		events: { persist } as unknown as ConversationEventUseCaseV1,
	});
	const input: BrowserHandoffEventInputV1 = {
		request,
		response: result,
		occurredAt: "2026-10-14T00:00:01.000Z",
		adapterEventKeyPrefix: "browser-handoff-1",
		runtimeCursorPrefix: "browser-handoff-cursor-1",
	};
	return { adapter, input, persist, browserHandoff };
}

describe("Browser handoff event adapter", () => {
	it.each([
		"requested",
		"active",
		"returning",
		"completed",
		"revoked",
		"expired",
		"crashed",
		"unknown",
	] as const)(
		"persists the %s state through Conversation Events",
		async (status) => {
			const state = setup(response(status));
			await expect(state.adapter.persist(state.input)).resolves.toMatchObject({
				status,
				outcome: "accepted",
			});
			expect(state.persist).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-1",
					executionId: "execution-1",
					sessionGeneration: 2,
					deliveryFence: 7,
					adapterEventKey: `browser-handoff-1:${status}`,
					runtimeCursor: `browser-handoff-cursor-1:${status}`,
					event: expect.objectContaining({
						type: "browser.handoff",
						status,
						binding: expect.objectContaining({ pageRevision: 5 }),
					}),
				}),
			);
		},
	);

	it("uses an unknown event when the Host has no record", async () => {
		const state = setup({
			...response("requested"),
			record: null,
		});
		await expect(state.adapter.persist(state.input)).resolves.toMatchObject({
			status: "unknown",
		});
		expect(state.persist).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					status: "unknown",
					terminalReason: "BROWSER_HANDOFF_RECORD_UNAVAILABLE",
				}),
			}),
		);
	});

	it("preserves a forward-compatible unknown Host outcome as unknown", async () => {
		const state = setup({
			...response("active"),
			outcome: "unknown",
		} as never);
		await expect(state.adapter.persist(state.input)).resolves.toMatchObject({
			status: "unknown",
		});
		expect(state.persist).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					status: "unknown",
					terminalReason: "BROWSER_HANDOFF_ACCEPTANCE_UNKNOWN",
				}),
			}),
		);
	});

	it("dispatches through the existing Worker client before persisting", async () => {
		const state = setup(response("active"));
		await expect(
			state.adapter.dispatch({
				request,
				occurredAt: state.input.occurredAt,
				adapterEventKeyPrefix: state.input.adapterEventKeyPrefix,
				runtimeCursorPrefix: state.input.runtimeCursorPrefix,
			}),
		).resolves.toMatchObject({ status: "active" });
		expect(state.browserHandoff).toHaveBeenCalledWith(request, undefined);
	});

	it("persists a bounded unknown event for a foreign binding", async () => {
		const state = setup();
		const foreign = structuredClone(request);
		foreign.handoff.runtime = {
			...foreign.handoff.runtime,
			agentId: "foreign-agent",
		};
		await expect(
			state.adapter.persist({ ...state.input, request: foreign }),
		).resolves.toMatchObject({ status: "unknown", outcome: "accepted" });
		expect(state.persist).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: request.conversationId,
				executionId: request.executionId,
				deliveryFence: request.operation.deliveryFence,
				event: expect.objectContaining({
					status: "unknown",
					terminalReason: "BROWSER_HANDOFF_BINDING_CONFLICT",
					binding: expect.objectContaining({ agentId: request.agentId }),
				}),
			}),
		);
	});

	it("persists unknown when the response belongs to another Host execution", async () => {
		const state = setup({
			...response("active"),
			hostSessionRef: "foreign-host-session",
		});
		await expect(state.adapter.persist(state.input)).resolves.toMatchObject({
			status: "unknown",
			outcome: "accepted",
		});
		expect(state.persist).toHaveBeenCalledWith(
			expect.objectContaining({
				event: expect.objectContaining({
					status: "unknown",
					terminalReason: "BROWSER_HANDOFF_RESPONSE_BINDING_CONFLICT",
				}),
			}),
		);
	});

	it("fails closed when the Conversation Event lease is stale", async () => {
		const state = setup();
		state.persist.mockResolvedValue({ outcome: "stale" } as never);
		await expect(state.adapter.persist(state.input)).rejects.toThrow(
			"BROWSER_HANDOFF_EVENT_STALE",
		);
	});
});
