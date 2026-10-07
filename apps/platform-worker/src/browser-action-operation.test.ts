import type {
	ConversationEventUseCaseV1,
	PersistedRuntimeConversationEventV1,
} from "@agent-infra/platform-core";
import {
	type ConversationBrowserActionAttemptV1,
	conversationBrowserActionFactV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import {
	type BrowserActionOperationControllerRecordV1,
	type BrowserActionOperationControllerRequestV1,
	type BrowserActionOperationInputV1,
	createBrowserActionOperationAdapterV1,
} from "./browser-action-operation.js";

type ActionRequest = Omit<
	BrowserActionOperationControllerRequestV1,
	| "agentId"
	| "conversationId"
	| "executionId"
	| "capabilityVersion"
	| "pageRevision"
	| "sessionGeneration"
	| "resourceFence"
	| "actionId"
	| "operationRef"
	| "attemptRef"
>;
type ActionRecord = BrowserActionOperationControllerRecordV1;

const page = { pageId: "page-1", pageRevision: 2 } as const;
const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	capabilityVersion: 5,
	pageRevision: page.pageRevision,
	sessionGeneration: 3,
	resourceFence: 4,
} as const;
const attempt: ConversationBrowserActionAttemptV1 = {
	operationRef: "operation-1",
	attemptRef: "attempt-1",
};
const action = {
	kind: "click",
	page,
	target: { elementId: "element-1" },
	sideEffect: true,
} as const satisfies ActionRequest;

function acceptedEvent(
	command: Parameters<ConversationEventUseCaseV1["persist"]>[0],
): PersistedRuntimeConversationEventV1 {
	return {
		schemaVersion: 1,
		eventId: `event-${command.event.type}-${command.adapterEventKey}`,
		conversationId: command.conversationId,
		executionId: command.executionId,
		sequence: 1,
		conversationCursor: 1,
		occurredAt: command.occurredAt,
		event: command.event,
	} as PersistedRuntimeConversationEventV1;
}

function setup(
	options: {
		readonly persist?: ConversationEventUseCaseV1["persist"];
		readonly executeAction?: (
			request: BrowserActionOperationControllerRequestV1,
		) => Promise<ActionRecord>;
	} = {},
) {
	const phases: string[] = [];
	const persist =
		options.persist ??
		(async (command) => {
			if (command.event.type === "execution.operation")
				phases.push(command.event.fact.phase);
			return { outcome: "accepted" as const, event: acceptedEvent(command) };
		});
	const executeAction =
		options.executeAction ??
		(async (
			request: BrowserActionOperationControllerRequestV1,
		): Promise<ActionRecord> => ({
			actionId: request.actionId ?? "missing-action-id",
			status: "completed",
			page: request.page,
			sideEffect: request.sideEffect === true,
		}));
	const controller = { executeAction: vi.fn(executeAction) };
	const adapter = createBrowserActionOperationAdapterV1({
		events: { persist } as ConversationEventUseCaseV1,
		controller,
	});
	const input: BrowserActionOperationInputV1 = {
		agentId: binding.agentId,
		conversationId: binding.conversationId,
		executionId: binding.executionId,
		sessionGeneration: binding.sessionGeneration,
		deliveryFence: binding.resourceFence,
		controllerBinding: binding,
		capabilityVersion: binding.capabilityVersion,
		page,
		actionId: "action-1",
		attempt,
		toolId: "browser.click",
		action,
		occurredAt: "2026-10-07T00:00:00.000Z",
		adapterEventKeyPrefix: "browser-action-1",
		runtimeCursorPrefix: "browser-cursor-1",
		now: () => "2026-10-07T00:00:01.000Z",
		signal: new AbortController().signal,
	};
	return { adapter, controller, input, phases };
}

describe("Browser action operation adapter", () => {
	it("persists intent and started before invoking the controller with durable refs", async () => {
		const state = setup();
		const result = await state.adapter.execute(state.input);

		expect(result.record).toMatchObject({
			actionId: "action-1",
			status: "completed",
		});
		expect(state.phases).toEqual(["intent", "started", "completed"]);
		expect(state.controller.executeAction).toHaveBeenCalledWith({
			agentId: binding.agentId,
			conversationId: binding.conversationId,
			executionId: binding.executionId,
			capabilityVersion: binding.capabilityVersion,
			pageRevision: binding.pageRevision,
			sessionGeneration: binding.sessionGeneration,
			resourceFence: binding.resourceFence,
			...action,
			actionId: "action-1",
			operationRef: attempt.operationRef,
			attemptRef: attempt.attemptRef,
		});
	});

	it.each([
		["agent", { agentId: "other-agent" }],
		["conversation", { conversationId: "other-conversation" }],
		["execution", { executionId: "other-execution" }],
		["capability", { capabilityVersion: 6 }],
		["page", { pageRevision: 3 }],
		["generation", { sessionGeneration: 4 }],
		["fence", { resourceFence: 5 }],
	] as const)(
		"fails before browser I/O on a stale %s binding",
		async (_kind, change) => {
			const state = setup();
			await expect(
				state.adapter.execute({
					...state.input,
					controllerBinding: { ...binding, ...change },
				}),
			).rejects.toThrow("BROWSER_ACTION_CONTROLLER_BINDING_MISMATCH");
			expect(state.controller.executeAction).not.toHaveBeenCalled();
			expect(state.phases).toEqual([]);
		},
	);

	it.each([
		["rejected", "request_rejected"],
		["failed", "operation_failed"],
		["unknown", "recovery_unconfirmed"],
	] as const)(
		"persists %s without fabricating completion",
		async (status, failureCode) => {
			const state = setup({
				executeAction: async (request) => ({
					actionId: request.actionId ?? "missing-action-id",
					status,
					page: request.page,
					sideEffect: request.sideEffect === true,
					reasonCode: `BROWSER_${status.toUpperCase()}`,
				}),
			});

			await expect(state.adapter.execute(state.input)).rejects.toMatchObject({
				failureCode,
			});
			expect(state.phases).toEqual([
				"intent",
				"started",
				status === "unknown" ? "unknown" : "failed",
			]);
		},
	);

	it("does not invoke the controller when the durable intent replays completed", async () => {
		const state = setup({
			persist: async (command) => ({
				outcome: "replayed" as const,
				event: {
					...acceptedEvent(command),
					event: {
						schemaVersion: 2,
						type: "execution.operation",
						fact: conversationBrowserActionFactV1({
							conversationId: command.conversationId,
							executionId: command.executionId,
							sessionGeneration: binding.sessionGeneration,
							deliveryFence: binding.resourceFence,
							runtimeCursor: command.runtimeCursor,
							occurredAt: command.occurredAt,
							adapterEventKey: command.adapterEventKey,
							attempt,
							phase: "completed",
							toolId: "browser.click",
							browser: {
								actionId: "action-1",
								capabilityVersion: 5,
								pageRevision: page.pageRevision,
								sessionGeneration: binding.sessionGeneration,
								resourceFence: binding.resourceFence,
								sideEffect: true,
							},
						}),
					},
				},
			}),
		});

		await expect(state.adapter.execute(state.input)).resolves.toEqual({
			resultRef: undefined,
			record: undefined,
		});
		expect(state.controller.executeAction).not.toHaveBeenCalled();
	});

	it("honors cancellation before intent without browser I/O", async () => {
		const controller = new AbortController();
		controller.abort();
		const state = setup();
		await expect(
			state.adapter.execute({ ...state.input, signal: controller.signal }),
		).rejects.toMatchObject({ failureCode: "interrupted" });
		expect(state.controller.executeAction).not.toHaveBeenCalled();
	});
});
