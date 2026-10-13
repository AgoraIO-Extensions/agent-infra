import type {
	BrowserHandoffControllerV1,
	RuntimeBrowserExecutionContextV1,
} from "@agent-infra/agent-runtime";
import {
	createBrowserSessionDriverContextV1,
	createChromiumBrowserSessionControllerV1,
} from "@agent-infra/agent-runtime";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";

export type SessionBrowserExecutionBindingV1 = Omit<
	RuntimeBrowserExecutionContextV1["binding"],
	"workloadRevision" | "imageDigest"
> & {
	readonly subjectId: string;
	readonly executionId: string;
	readonly pageRevision: number;
	readonly capabilityVersion: number;
	readonly workloadRevision: number;
	readonly imageDigest: string;
};

function assertBinding(input: SessionBrowserExecutionBindingV1): void {
	if (
		!input.subjectId ||
		!input.agentId ||
		!input.conversationId ||
		!input.executionId ||
		!Number.isSafeInteger(input.sessionGeneration) ||
		input.sessionGeneration < 1 ||
		!Number.isSafeInteger(input.resourceFence) ||
		input.resourceFence < 1 ||
		!Number.isSafeInteger(input.capabilityVersion) ||
		input.capabilityVersion < 1 ||
		!Number.isSafeInteger(input.pageRevision) ||
		input.pageRevision < 1 ||
		!Number.isSafeInteger(input.workloadRevision) ||
		input.workloadRevision < 1 ||
		!/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/u.test(input.imageDigest)
	)
		throw new Error("RUNTIME_BROWSER_SESSION_BINDING_INVALID");
}

/**
 * Assemble a Session-owned Browser Driver context from deployment inputs.
 * The caller owns the request-local binding and handoff controller; this
 * factory creates no durable Browser or Runtime authority.
 */
export function createSessionBrowserExecutionContextV1(input: {
	readonly sandboxRoot: string;
	readonly capability: BrowserCapabilityAvailableV1;
	readonly binding: SessionBrowserExecutionBindingV1;
	readonly handoff?: BrowserHandoffControllerV1;
}): RuntimeBrowserExecutionContextV1 {
	assertBinding(input.binding);
	if (!input.sandboxRoot.startsWith("/") || input.sandboxRoot === "/")
		throw new Error("RUNTIME_BROWSER_SANDBOX_ROOT_INVALID");
	if (input.capability.status !== "available")
		throw new Error("RUNTIME_BROWSER_CAPABILITY_UNAVAILABLE");
	if (input.binding.capabilityVersion !== input.capability.capabilityVersion)
		throw new Error("RUNTIME_BROWSER_CAPABILITY_VERSION_MISMATCH");
	const session = createChromiumBrowserSessionControllerV1({
		sandboxRoot: input.sandboxRoot,
		binding: {
			agentId: input.binding.agentId,
			conversationId: input.binding.conversationId,
			sessionGeneration: input.binding.sessionGeneration,
			resourceFence: input.binding.resourceFence,
			workloadRevision: input.binding.workloadRevision,
			imageDigest: input.binding.imageDigest,
		},
		capability: input.capability,
	});
	return createBrowserSessionDriverContextV1({
		session,
		capability: input.capability,
		binding: {
			agentId: input.binding.agentId,
			conversationId: input.binding.conversationId,
			sessionGeneration: input.binding.sessionGeneration,
			resourceFence: input.binding.resourceFence,
			workloadRevision: input.binding.workloadRevision,
			imageDigest: input.binding.imageDigest,
		},
		subjectId: input.binding.subjectId,
		...(input.handoff ? { handoff: input.handoff } : {}),
	});
}
