import { join, resolve } from "node:path";
import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import {
	type BrowserContext,
	type BrowserType,
	chromium,
} from "playwright-core";

export type BrowserContextBindingV1 = Readonly<{
	agentId: string;
	conversationId: string;
	sessionGeneration: number;
	resourceFence: number;
}>;

export type BrowserContextManagerSnapshotV1 = Readonly<{
	status: "not_started" | "starting" | "ready" | "crashed" | "closed";
	agentId?: string;
	conversationId?: string;
	sessionGeneration?: number;
	resourceFence?: number;
	capabilityVersion?: number;
}>;

type BrowserContextManagerOptionsV1 = Readonly<{
	sandboxRoot: string;
	browserType: BrowserType;
	executablePath?: string;
}>;

type ActiveContext = Readonly<{
	binding: BrowserContextBindingV1;
	context: BrowserContext;
	capabilityVersion: number;
}>;

function assertBinding(binding: BrowserContextBindingV1): void {
	if (
		!binding ||
		typeof binding.agentId !== "string" ||
		binding.agentId.length === 0 ||
		typeof binding.conversationId !== "string" ||
		binding.conversationId.length === 0 ||
		!Number.isSafeInteger(binding.sessionGeneration) ||
		binding.sessionGeneration < 1 ||
		!Number.isSafeInteger(binding.resourceFence) ||
		binding.resourceFence < 1
	)
		throw new Error("BROWSER_CONTEXT_BINDING_INVALID");
}

function sameBinding(
	left: BrowserContextBindingV1,
	right: BrowserContextBindingV1,
): boolean {
	return (
		left.agentId === right.agentId &&
		left.conversationId === right.conversationId &&
		left.sessionGeneration === right.sessionGeneration &&
		left.resourceFence === right.resourceFence
	);
}

export function createBrowserContextManagerV1(
	options: BrowserContextManagerOptionsV1,
) {
	if (
		typeof options.sandboxRoot !== "string" ||
		!options.sandboxRoot.startsWith("/")
	)
		throw new Error("BROWSER_CONTEXT_SANDBOX_ROOT_INVALID");
	const profileRoot = join(resolve(options.sandboxRoot), "browser-profile");
	let active: ActiveContext | undefined;
	let pending: Promise<BrowserContext> | undefined;
	let pendingBinding: BrowserContextBindingV1 | undefined;
	let snapshot: BrowserContextManagerSnapshotV1 = { status: "not_started" };
	let closedByManager = false;

	function readSnapshot(): BrowserContextManagerSnapshotV1 {
		return { ...snapshot };
	}

	async function acquire(
		binding: BrowserContextBindingV1,
		capability: BrowserCapabilityProjectionV1,
	): Promise<BrowserContext> {
		assertBinding(binding);
		if (capability.status !== "available")
			throw new Error(capability.errorCode);
		if (active) {
			if (!sameBinding(active.binding, binding))
				throw new Error("BROWSER_CONTEXT_BINDING_CONFLICT");
			return active.context;
		}
		if (pending) {
			if (!pendingBinding || !sameBinding(pendingBinding, binding))
				throw new Error("BROWSER_CONTEXT_BINDING_CONFLICT");
			return pending;
		}
		snapshot = {
			status: "starting",
			agentId: binding.agentId,
			conversationId: binding.conversationId,
			sessionGeneration: binding.sessionGeneration,
			resourceFence: binding.resourceFence,
			capabilityVersion: capability.capabilityVersion,
		};
		closedByManager = false;
		pendingBinding = binding;
		pending = options.browserType
			.launchPersistentContext(profileRoot, {
				headless: true,
				acceptDownloads: true,
				...(options.executablePath
					? { executablePath: options.executablePath }
					: {}),
				viewport: {
					width: Math.min(1280, capability.policy.maxViewportWidth),
					height: Math.min(720, capability.policy.maxViewportHeight),
				},
			})
			.then((context) => {
				active = {
					binding,
					context,
					capabilityVersion: capability.capabilityVersion,
				};
				snapshot = {
					status: "ready",
					agentId: binding.agentId,
					conversationId: binding.conversationId,
					sessionGeneration: binding.sessionGeneration,
					resourceFence: binding.resourceFence,
					capabilityVersion: capability.capabilityVersion,
				};
				context.on("close", () => {
					if (active?.context !== context) return;
					active = undefined;
					snapshot = {
						...snapshot,
						status: closedByManager ? "closed" : "crashed",
					};
				});
				return context;
			})
			.catch((error) => {
				snapshot = { ...snapshot, status: "crashed" };
				throw error;
			})
			.finally(() => {
				pending = undefined;
				pendingBinding = undefined;
			});
		return pending;
	}

	async function close(binding: BrowserContextBindingV1): Promise<void> {
		assertBinding(binding);
		if (pending) await pending;
		if (!active) {
			snapshot = { ...snapshot, status: "closed" };
			return;
		}
		if (!sameBinding(active.binding, binding))
			throw new Error("BROWSER_CONTEXT_BINDING_CONFLICT");
		closedByManager = true;
		const context = active.context;
		active = undefined;
		await context.close();
		snapshot = {
			...snapshot,
			status: "closed",
		};
	}

	return { acquire, resume: acquire, close, snapshot: readSnapshot };
}

export function createChromiumBrowserContextManagerV1(
	options: Omit<BrowserContextManagerOptionsV1, "browserType">,
) {
	return createBrowserContextManagerV1({ ...options, browserType: chromium });
}
