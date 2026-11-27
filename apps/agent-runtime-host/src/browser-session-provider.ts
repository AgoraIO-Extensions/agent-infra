import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
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

/** Apply the retention budget while Chromium is stopped. Links are counted without following them. */
async function limitRetainedProfile(root: string, maximum: number) {
	let bytes = 0;
	const pending = [root];
	try {
		while (pending.length && bytes <= maximum) {
			const path = pending.pop();
			if (!path) break;
			const stat = await lstat(path);
			bytes += stat.size;
			if (stat.isDirectory() && bytes <= maximum) {
				const directory = await opendir(path);
				for await (const entry of directory)
					pending.push(join(path, entry.name));
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (bytes > maximum) await rm(root, { recursive: true, force: true });
}

/**
 * Assemble a Session-owned Browser Driver context from deployment inputs.
 * The caller owns the request-local binding and handoff controller; this
 * factory creates no durable Browser or Runtime authority.
 */
export function createSessionBrowserExecutionContextV1(input: {
	readonly sandboxRoot: string;
	readonly readOnlyWeb?: true;
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
		readOnlyWeb: input.readOnlyWeb,
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
	const context = createBrowserSessionDriverContextV1({
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
	const profile = join(input.sandboxRoot, "browser-profile");
	const limit = input.capability.policy.maxRetainedProfileBytes;
	let preparing: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let deadline: AbortSignal | undefined;
	const close = () =>
		(closing ??= (async () => {
			await preparing;
			await session.close();
			await limitRetainedProfile(profile, limit);
		})());
	const execute = context.executeTool;
	if (!execute) throw new Error("RUNTIME_BROWSER_SESSION_BINDING_INVALID");
	return {
		...context,
		async executeTool(request, signal, revalidate) {
			if (closing) throw new Error("RUNTIME_BROWSER_SESSION_CLOSED");
			if (!deadline) {
				deadline = AbortSignal.timeout(
					input.capability.policy.maxBrowserDurationMs,
				);
				deadline.addEventListener(
					"abort",
					() => {
						void close().catch(() => undefined);
					},
					{ once: true },
				);
			}
			const bounded = AbortSignal.any([signal, deadline]);
			preparing ??= limitRetainedProfile(profile, limit);
			await preparing;
			bounded.throwIfAborted();
			if (closing) throw new Error("RUNTIME_BROWSER_SESSION_CLOSED");
			revalidate?.();
			return execute(request, bounded, revalidate);
		},
		close,
	};
}
