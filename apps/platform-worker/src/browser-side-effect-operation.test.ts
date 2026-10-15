import type {
	RuntimeBrowserSideEffectConfirmationRequestV3,
	RuntimeBrowserSideEffectConfirmationResponseV3,
} from "@agent-infra/contracts/runtime";
import type { ConversationEventUseCaseV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { createBrowserSideEffectOperationAdapterV1 } from "./browser-side-effect-operation.js";

function request(
	command: RuntimeBrowserSideEffectConfirmationRequestV3["command"] = "confirm",
): RuntimeBrowserSideEffectConfirmationRequestV3 {
	return {
		schemaVersion: 3,
		requestId: "request-side-effect",
		traceId: "trace-side-effect",
		principal: { kind: "user", id: "actor-1" },
		channelId: "web",
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		turnId: "turn-1",
		sessionGeneration: 1,
		hostSessionRef: "host-1",
		operation: {
			kind: "execution",
			id: "execution-1",
			deliveryFence: 3,
			executionDeliveryFence: 3,
		},
		grant: {
			schemaVersion: 2,
			format: "runtime-execution-jws",
			token: "header.payload.signature",
		},
		command,
		binding: {
			actionId: "action-1",
			confirmationId: "confirmation-1",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
			capabilityVersion: 2,
			pageRevision: 3,
			resourceFence: 3,
			workloadRevision: 4,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
	};
}

function events() {
	const commands: unknown[] = [];
	return {
		commands,
		persist: vi.fn(async (command: unknown) => {
			commands.push(command);
			return {
				outcome: "accepted" as const,
				event: {
					eventId: `event-${commands.length}`,
					sequence: commands.length,
					conversationCursor: commands.length,
					...(command as object),
				},
			};
		}),
	} as unknown as ConversationEventUseCaseV1 & { commands: unknown[] };
}

describe("Browser side-effect Worker operation adapter", () => {
	it("persists a completed Runtime confirmation through the existing operation authority", async () => {
		const conversationEvents = events();
		const runtime = {
			browserSideEffect: vi.fn().mockResolvedValue({
				schemaVersion: 3,
				hostSessionRef: "host-1",
				executionId: "execution-1",
				actionId: "action-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				outcome: "accepted",
				phase: "completed",
			}),
		};
		const adapter = createBrowserSideEffectOperationAdapterV1({
			events: conversationEvents,
			runtime,
		});
		await expect(
			adapter.execute({
				request: request(),
				attempt: { operationRef: "operation-1", attemptRef: "attempt-1" },
				occurredAt: "2026-10-15T00:00:00.000Z",
				adapterEventKeyPrefix: "browser-command:command-1",
				runtimeCursorPrefix: "browser-command:command-1",
				now: () => "2026-10-15T00:00:01.000Z",
				signal: new AbortController().signal,
			}),
		).resolves.toEqual({});
		expect(runtime.browserSideEffect).toHaveBeenCalledOnce();
		expect(
			conversationEvents.commands.map(
				(command) =>
					(command as { event: { fact: { phase: string } } }).event.fact.phase,
			),
		).toEqual(["intent", "started", "completed"]);
	});

	it("turns a foreign Runtime response into unknown without completing the fact", async () => {
		const conversationEvents = events();
		const runtime = {
			browserSideEffect: vi.fn().mockResolvedValue({
				schemaVersion: 3,
				hostSessionRef: "host-1",
				executionId: "execution-1",
				actionId: "foreign-action",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				outcome: "accepted",
				phase: "completed",
			}),
		};
		const adapter = createBrowserSideEffectOperationAdapterV1({
			events: conversationEvents,
			runtime,
		});
		await expect(
			adapter.execute({
				request: request("reject"),
				attempt: { operationRef: "operation-1", attemptRef: "attempt-1" },
				occurredAt: "2026-10-15T00:00:00.000Z",
				adapterEventKeyPrefix: "browser-command:command-2",
				runtimeCursorPrefix: "browser-command:command-2",
				now: () => "2026-10-15T00:00:01.000Z",
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			phase: "unknown",
			failureCode: "recovery_unconfirmed",
		});
		expect(conversationEvents.commands.at(-1)).toMatchObject({
			event: { fact: { phase: "unknown" } },
		});
	});

	it("rejects a binding mismatch before Runtime I/O", async () => {
		const conversationEvents = events();
		const runtime = { browserSideEffect: vi.fn() };
		const adapter = createBrowserSideEffectOperationAdapterV1({
			events: conversationEvents,
			runtime,
		});
		await expect(
			adapter.execute({
				request: { ...request(), executionId: "foreign-execution" },
				attempt: { operationRef: "operation-1", attemptRef: "attempt-1" },
				occurredAt: "2026-10-15T00:00:00.000Z",
				adapterEventKeyPrefix: "browser-command:command-3",
				runtimeCursorPrefix: "browser-command:command-3",
				now: () => "2026-10-15T00:00:01.000Z",
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ failureCode: "authorization_denied" });
		expect(runtime.browserSideEffect).not.toHaveBeenCalled();
	});

	it("does not treat a rejected outcome as completed", async () => {
		const conversationEvents = events();
		const runtime = {
			browserSideEffect: vi.fn().mockResolvedValue({
				schemaVersion: 3,
				hostSessionRef: "host-1",
				executionId: "execution-1",
				actionId: "action-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				outcome: "rejected",
				phase: "completed",
			} as unknown as RuntimeBrowserSideEffectConfirmationResponseV3),
		};
		const adapter = createBrowserSideEffectOperationAdapterV1({
			events: conversationEvents,
			runtime,
		});
		await expect(
			adapter.execute({
				request: request(),
				attempt: { operationRef: "operation-1", attemptRef: "attempt-1" },
				occurredAt: "2026-10-15T00:00:00.000Z",
				adapterEventKeyPrefix: "browser-command:command-4",
				runtimeCursorPrefix: "browser-command:command-4",
				now: () => "2026-10-15T00:00:01.000Z",
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			phase: "failed",
			failureCode: "request_rejected",
		});
	});
});
