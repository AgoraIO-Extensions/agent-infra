import { join, resolve } from "node:path";
import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import {
	type BrowserContext,
	type BrowserType,
	chromium,
} from "playwright-core";
import { verifyChromiumInstallationV1 } from "./browser-installation.js";

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
	browserType: Pick<BrowserType, "launchPersistentContext">;
	executablePath?: string;
}>;

type ActiveContext = Readonly<{
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

function captureBinding(
	binding: BrowserContextBindingV1,
): BrowserContextBindingV1 {
	const captured = Object.freeze({
		agentId: binding?.agentId,
		conversationId: binding?.conversationId,
		sessionGeneration: binding?.sessionGeneration,
		resourceFence: binding?.resourceFence,
	});
	assertBinding(captured);
	return captured;
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
	let profileBinding: BrowserContextBindingV1 | undefined;
	let snapshot: BrowserContextManagerSnapshotV1 = { status: "not_started" };
	let closedByManager = false;

	function readSnapshot(): BrowserContextManagerSnapshotV1 {
		return { ...snapshot };
	}

	async function acquire(
		binding: BrowserContextBindingV1,
		capability: BrowserCapabilityProjectionV1,
	): Promise<BrowserContext> {
		const acceptedBinding = captureBinding(binding);
		if (capability.status !== "available")
			throw new Error(capability.errorCode);
		if (profileBinding && !sameBinding(profileBinding, acceptedBinding))
			throw new Error("BROWSER_CONTEXT_BINDING_CONFLICT");
		profileBinding ??= acceptedBinding;
		if (active) return active.context;
		if (pending) return pending;
		snapshot = {
			status: "starting",
			agentId: acceptedBinding.agentId,
			conversationId: acceptedBinding.conversationId,
			sessionGeneration: acceptedBinding.sessionGeneration,
			resourceFence: acceptedBinding.resourceFence,
			capabilityVersion: capability.capabilityVersion,
		};
		closedByManager = false;
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
					context,
					capabilityVersion: capability.capabilityVersion,
				};
				snapshot = {
					status: "ready",
					agentId: acceptedBinding.agentId,
					conversationId: acceptedBinding.conversationId,
					sessionGeneration: acceptedBinding.sessionGeneration,
					resourceFence: acceptedBinding.resourceFence,
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
			});
		return pending;
	}

	async function close(binding: BrowserContextBindingV1): Promise<void> {
		const requestedBinding = captureBinding(binding);
		if (profileBinding && !sameBinding(profileBinding, requestedBinding))
			throw new Error("BROWSER_CONTEXT_BINDING_CONFLICT");
		if (pending) await pending;
		if (!active) {
			snapshot = { ...snapshot, status: "closed" };
			return;
		}
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
	options: Omit<
		BrowserContextManagerOptionsV1,
		"browserType" | "executablePath"
	>,
) {
	return createBrowserContextManagerV1({
		sandboxRoot: options.sandboxRoot,
		browserType: {
			async launchPersistentContext(profileRoot, launchOptions) {
				const installation = await verifyChromiumInstallationV1();
				return chromium.launchPersistentContext(profileRoot, {
					...launchOptions,
					executablePath: installation.executable,
					timeout: 15_000,
				});
			},
		},
	});
}
