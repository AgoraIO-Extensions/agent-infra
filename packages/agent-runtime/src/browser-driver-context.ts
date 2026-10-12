import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import type { BrowserHandoffControllerV1 } from "./browser-handoff.js";
import type {
	BrowserActionKindV1,
	BrowserActionRecordV1,
	BrowserElementReferenceV1,
	BrowserPageReferenceV1,
} from "./browser-observe.js";
import type { BrowserSessionControllerV1 } from "./browser-session.js";
import type {
	RuntimeBrowserExecutionContextV1,
	RuntimeBrowserToolExecutionRequestV1,
	RuntimeBrowserToolExecutionResultV1,
} from "./driver.js";

const maxContentBytes = 16_384;
const supportedInteractionKinds = new Set<BrowserActionKindV1>([
	"click",
	"fill",
	"select",
	"check",
	"uncheck",
	"press",
	"hover",
	"scroll",
	"wait",
]);

function pageReference(value: Record<string, unknown>): BrowserPageReferenceV1 {
	if (
		typeof value.pageId !== "string" ||
		!Number.isSafeInteger(value.pageRevision) ||
		(value.pageRevision as number) < 1
	)
		throw new Error("BROWSER_PAGE_REFERENCE_INVALID");
	return {
		pageId: value.pageId,
		pageRevision: value.pageRevision as number,
	};
}

function sameExecutionBinding(
	request: RuntimeBrowserToolExecutionRequestV1["binding"],
	context: Pick<
		RuntimeBrowserExecutionContextV1,
		"binding" | "capabilityVersion"
	>,
) {
	return (
		request.agentId === context.binding.agentId &&
		request.conversationId === context.binding.conversationId &&
		request.sessionGeneration === context.binding.sessionGeneration &&
		request.resourceFence === context.binding.resourceFence &&
		request.capabilityVersion === context.capabilityVersion
	);
}

function boundedText(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length <= maxContentBytes
		? text
		: `${text.slice(0, maxContentBytes - 1)}…`;
}

function success(
	request: RuntimeBrowserToolExecutionRequestV1,
	value: unknown,
): RuntimeBrowserToolExecutionResultV1 {
	return {
		actionId: request.actionId,
		operationRef: request.operationRef,
		attemptRef: request.attemptRef,
		binding: request.binding,
		phase: "completed",
		contentItems: [{ type: "inputText", text: boundedText(value) }],
		success: true,
	};
}

function failure(
	request: RuntimeBrowserToolExecutionRequestV1,
	error: unknown,
): RuntimeBrowserToolExecutionResultV1 {
	const reason =
		error instanceof Error ? error.message : "BROWSER_EXECUTION_FAILED";
	return {
		actionId: request.actionId,
		operationRef: request.operationRef,
		attemptRef: request.attemptRef,
		binding: request.binding,
		phase: "failed",
		contentItems: [],
		success: false,
		failureCode: reason.slice(0, 256),
	};
}

function actionRecordSummary(record: BrowserActionRecordV1) {
	return {
		status: record.status,
		actionId: record.actionId,
		kind: record.kind,
		page: record.page,
		sideEffect: record.sideEffect,
		...(record.reasonCode ? { reasonCode: record.reasonCode } : {}),
		...(record.artifact
			? {
					artifact: {
						descriptor: record.artifact.descriptor,
						kind: record.artifact.kind,
					},
				}
			: {}),
	};
}

export function createBrowserSessionDriverContextV1(input: {
	readonly session: BrowserSessionControllerV1;
	readonly capability: BrowserCapabilityAvailableV1;
	readonly binding: RuntimeBrowserExecutionContextV1["binding"];
	readonly subjectId: string;
	readonly handoff?: BrowserHandoffControllerV1;
}): RuntimeBrowserExecutionContextV1 {
	if (!input.subjectId || input.capability.status !== "available")
		throw new Error("BROWSER_DRIVER_CONTEXT_INVALID");
	return {
		capabilityVersion: input.capability.capabilityVersion,
		binding: structuredClone(input.binding),
		...(input.handoff ? { handoff: { controller: input.handoff } } : {}),
		executeTool: async (request, signal) => {
			// The Driver binds executionId, while this request-local context binds
			// Agent/Conversation/Session and capability identity. A foreign tuple
			// must never reach the Session controller, even in a controlled adapter.
			if (
				!sameExecutionBinding(request.binding, {
					binding: input.binding,
					capabilityVersion: input.capability.capabilityVersion,
				})
			)
				throw new Error("BROWSER_DRIVER_CONTEXT_BINDING_MISMATCH");
			try {
				signal.throwIfAborted();
				const args = request.arguments;
				if (request.tool === "browser_navigate") {
					if (typeof args.url !== "string" || args.url.length === 0)
						throw new Error("BROWSER_NAVIGATION_URL_INVALID");
					const page = await input.session.navigate(args.url);
					const observation = await input.session.observe(page);
					return success(request, observation);
				}
				if (request.tool === "browser_observe") {
					return success(
						request,
						await input.session.observe(pageReference(args)),
					);
				}
				if (request.tool !== "browser_interact")
					throw new Error("BROWSER_TOOL_UNSUPPORTED");
				const page = pageReference(args);
				if (
					typeof args.elementId !== "string" ||
					!supportedInteractionKinds.has(args.kind as BrowserActionKindV1)
				)
					throw new Error("BROWSER_INTERACTION_INVALID");
				const target: BrowserElementReferenceV1 = {
					elementId: args.elementId,
					pageId: page.pageId,
					pageRevision: page.pageRevision,
					role: "",
					name: "",
				};
				const record = await input.session.act({
					kind: args.kind as BrowserActionKindV1,
					page,
					target,
					...(typeof args.value === "string" ? { value: args.value } : {}),
					...(typeof args.key === "string" ? { key: args.key } : {}),
					actionId: request.actionId,
					operationRef: request.operationRef,
					attemptRef: request.attemptRef,
					idempotencyKey: request.actionId,
					executionBinding: {
						agentId: request.binding.agentId,
						conversationId: request.binding.conversationId,
						executionId: request.binding.executionId,
						capabilityVersion: request.binding.capabilityVersion,
						pageRevision: request.binding.pageRevision,
						sessionGeneration: request.binding.sessionGeneration,
						resourceFence: request.binding.resourceFence,
					},
					authorization: {
						subjectId: input.subjectId,
						agentId: request.binding.agentId,
						conversationId: request.binding.conversationId,
						executionId: request.binding.executionId,
					},
				});
				signal.throwIfAborted();
				return success(request, actionRecordSummary(record));
			} catch (error) {
				return failure(request, error);
			}
		},
	};
}
