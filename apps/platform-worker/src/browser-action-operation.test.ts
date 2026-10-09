import { createBrowserObserveControllerV1 } from "@agent-infra/agent-runtime";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
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
import { createBrowserRecoveryConsumerV1 } from "./browser-recovery-consumer.js";

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
	| "executionBinding"
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

const componentCapability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 5,
	status: "available",
	operations: ["navigate", "observe", "interact"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 1,
		maxPages: 2,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 0,
		maxDownloadBytes: 1,
		maxUploadBytes: 1,
		maxScreenshotBytes: 1,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 1_000_000,
		navigationTimeoutMs: 5_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: false,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "128",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "receipt",
		probeVersion: "probe",
		verifiedAt: "2026-10-08T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact"],
	},
};

class ComponentLocator {
	constructor(private readonly name: string) {}
	async innerText() {
		return this.name;
	}
	async isVisible() {
		return true;
	}
	async getAttribute(name: string) {
		if (name === "role") return "button";
		if (name === "type") return "button";
		return name === "name" ? this.name : null;
	}
	async evaluate() {
		return "button";
	}
	async click() {}
}

class ComponentPage {
	private readonly handlers = new Map<string, (value: unknown) => void>();
	private readonly button = new ComponentLocator("Continue");
	private currentUrl = "about:blank";
	on(event: string, handler: (value: unknown) => void) {
		this.handlers.set(event, handler);
		return this;
	}
	mainFrame() {
		return this;
	}
	async goto(url: string) {
		this.currentUrl = url;
		this.handlers.get("framenavigated")?.(this);
	}
	url() {
		return this.currentUrl;
	}
	async title() {
		return "Example";
	}
	locator(selector: string) {
		if (selector === "iframe") return { count: async () => 0 };
		if (selector === "body") return { innerText: async () => "Continue" };
		return {
			count: async () => 1,
			nth: () => this.button,
		};
	}
}

function componentContext(page: ComponentPage) {
	return {
		route: async () => undefined,
		pages: () => [page],
		newPage: async () => page,
	};
}
const action = {
	kind: "click",
	page,
	target: {
		elementId: "element-1",
		pageId: page.pageId,
		pageRevision: page.pageRevision,
		role: "button",
		name: "Submit",
	},
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
			operationRef: request.operationRef,
			attemptRef: request.attemptRef,
			kind: request.kind,
			status: "completed",
			page: request.page,
			sideEffect: request.sideEffect === true,
			executionBinding: request.executionBinding,
			createdAt: "2026-10-07T00:00:00.000Z",
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
	it("round-trips the real Runtime controller record through recovery", async () => {
		const page = new ComponentPage();
		const controller = createBrowserObserveControllerV1({
			context: componentContext(page) as never,
			capability: componentCapability,
		});
		const pageReference = await controller.navigate("https://example.test/");
		const observed = await controller.observe(pageReference);
		const target = observed.elements[0];
		if (!target) throw new Error("expected a component target");
		const binding = {
			agentId: "agent-component",
			conversationId: "conversation-component",
			executionId: "execution-component",
			capabilityVersion: componentCapability.capabilityVersion,
			pageRevision: pageReference.pageRevision,
			sessionGeneration: 1,
			resourceFence: 1,
		} as const;
		const events: ConversationEventUseCaseV1 = {
			persist: async (command) => ({
				outcome: "accepted",
				event: acceptedEvent(command),
			}),
		};
		const adapter = createBrowserActionOperationAdapterV1({
			events,
			controller,
		});
		const result = await adapter.execute({
			agentId: binding.agentId,
			conversationId: binding.conversationId,
			executionId: binding.executionId,
			sessionGeneration: binding.sessionGeneration,
			deliveryFence: binding.resourceFence,
			controllerBinding: binding,
			capabilityVersion: binding.capabilityVersion,
			page: pageReference,
			actionId: "component-action",
			attempt: {
				operationRef: "component-operation",
				attemptRef: "component-attempt",
			},
			toolId: "browser.click",
			action: { kind: "click", page: pageReference, target },
			idempotencyKey: "component-idempotency",
			occurredAt: "2026-10-08T00:00:00.000Z",
			adapterEventKeyPrefix: "component-action",
			runtimeCursorPrefix: "component-cursor",
			now: () => "2026-10-08T00:00:01.000Z",
			signal: new AbortController().signal,
		});
		if (!result.record) throw new Error("expected Runtime action record");
		const recovery = createBrowserRecoveryConsumerV1({ controller });
		expect(
			recovery.read({
				actionId: "component-action",
				idempotencyKey: "component-idempotency",
				binding,
			}),
		).toMatchObject({ status: "completed", record: result.record });
	});

	it("persists intent and started before invoking the controller with durable refs", async () => {
		const state = setup();
		const result = await state.adapter.execute(state.input);

		expect(result.record).toMatchObject({
			actionId: "action-1",
			status: "completed",
		});
		expect(state.phases).toEqual(["intent", "started", "completed"]);
		expect(state.controller.executeAction).toHaveBeenCalledWith({
			...action,
			actionId: "action-1",
			operationRef: attempt.operationRef,
			attemptRef: attempt.attemptRef,
			idempotencyKey: "action-1",
			executionBinding: binding,
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
		["agent", { executionBinding: { ...binding, agentId: "other" } }],
		[
			"conversation",
			{ executionBinding: { ...binding, conversationId: "other" } },
		],
		["execution", { executionBinding: { ...binding, executionId: "other" } }],
		["capability", { executionBinding: { ...binding, capabilityVersion: 6 } }],
		["page", { executionBinding: { ...binding, pageRevision: 3 } }],
		["generation", { executionBinding: { ...binding, sessionGeneration: 2 } }],
		["fence", { executionBinding: { ...binding, resourceFence: 2 } }],
		["operation", { operationRef: "other-operation" }],
		["attempt", { attemptRef: "other-attempt" }],
	] as const)(
		"keeps a foreign controller %s result unknown",
		async (_kind, change) => {
			const state = setup({
				executeAction: async (request) => ({
					actionId: request.actionId,
					operationRef:
						"operationRef" in change
							? change.operationRef
							: request.operationRef,
					attemptRef:
						"attemptRef" in change ? change.attemptRef : request.attemptRef,
					kind: request.kind,
					status: "completed" as const,
					page: request.page,
					sideEffect: request.sideEffect === true,
					executionBinding:
						"executionBinding" in change
							? change.executionBinding
							: request.executionBinding,
					createdAt: "2026-10-07T00:00:00.000Z",
				}),
			});
			await expect(state.adapter.execute(state.input)).rejects.toMatchObject({
				failureCode: "recovery_unconfirmed",
			});
			expect(state.phases).toEqual(["intent", "started", "unknown"]);
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
					operationRef: request.operationRef,
					attemptRef: request.attemptRef,
					kind: request.kind,
					status,
					page: request.page,
					sideEffect: request.sideEffect === true,
					executionBinding: request.executionBinding,
					createdAt: "2026-10-07T00:00:00.000Z",
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
