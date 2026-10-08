import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCapabilityProjectionV1 } from "@agent-infra/contracts/runtime";
import type { BrowserContext, BrowserType } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { createBrowserContextManagerV1 } from "./browser-context.ts";

const availableCapability: BrowserCapabilityProjectionV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact", "files", "handoff"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 4,
		maxPages: 8,
		maxViewportWidth: 1920,
		maxViewportHeight: 1080,
		maxConcurrentActions: 2,
		maxDownloads: 8,
		maxDownloadBytes: 10_000_000,
		maxUploadBytes: 10_000_000,
		maxScreenshotBytes: 10_000_000,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 100_000_000,
		navigationTimeoutMs: 30_000,
		actionTimeoutMs: 15_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: true,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "128.0.6613.0",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "receipt-1",
		probeVersion: "probe-1",
		verifiedAt: "2026-10-06T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact", "files", "handoff"],
	},
};

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	sessionGeneration: 1,
	resourceFence: 3,
} as const;

function fakeBrowserType() {
	const close = vi.fn(async () => undefined);
	const closed = new Set<() => void>();
	const on = vi.fn((event: string, listener: () => void) => {
		if (event === "close") closed.add(listener);
	});
	const context = { close, on } as unknown as BrowserContext;
	const launchPersistentContext = vi.fn(
		async (_userDataDir: string, _options: unknown) => context,
	);
	return {
		crash: () => {
			for (const listener of closed) listener();
		},
		browserType: { launchPersistentContext } as unknown as BrowserType,
		context,
		close,
		launchPersistentContext,
	};
}

describe("Session BrowserContext manager", () => {
	it("rejects foreign pending requests and shares one launch for the original binding", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			let finishLaunch: (context: BrowserContext) => void = () => {};
			fake.launchPersistentContext.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishLaunch = resolve;
					}),
			);
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			const first = manager.acquire(binding, availableCapability);
			const second = manager.resume(binding, availableCapability);
			await expect(
				manager.acquire(
					{ ...binding, conversationId: "foreign" },
					availableCapability,
				),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			await expect(
				manager.close({ ...binding, conversationId: "foreign" }),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			finishLaunch(fake.context);
			expect(await Promise.all([first, second])).toEqual([
				fake.context,
				fake.context,
			]);
			expect(fake.launchPersistentContext).toHaveBeenCalledTimes(1);
			expect(fake.close).not.toHaveBeenCalled();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("keeps ownership after a failed launch while permitting the same binding to retry", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			fake.launchPersistentContext.mockRejectedValueOnce(
				new Error("launch failed"),
			);
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			await expect(
				manager.acquire(binding, availableCapability),
			).rejects.toThrow("launch failed");
			await expect(
				manager.resume(
					{ ...binding, conversationId: "foreign" },
					availableCapability,
				),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			expect(fake.launchPersistentContext).toHaveBeenCalledTimes(1);
			await expect(manager.resume(binding, availableCapability)).resolves.toBe(
				fake.context,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		{ agentId: "foreign-agent" },
		{ conversationId: "foreign-conversation" },
		{ sessionGeneration: 2 },
		{ resourceFence: 4 },
	])("retains profile ownership after a crash (%j)", async (different) => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			await manager.acquire(binding, availableCapability);
			fake.crash();
			expect(manager.snapshot().status).toBe("crashed");
			await expect(
				manager.resume({ ...binding, ...different }, availableCapability),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			await expect(manager.close({ ...binding, ...different })).rejects.toThrow(
				"BROWSER_CONTEXT_BINDING_CONFLICT",
			);
			expect(fake.launchPersistentContext).toHaveBeenCalledTimes(1);
			expect(fake.close).not.toHaveBeenCalled();
			await expect(manager.resume(binding, availableCapability)).resolves.toBe(
				fake.context,
			);
			expect(fake.launchPersistentContext.mock.calls[1]?.[0]).toBe(
				join(root, "browser-profile"),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("rejects a different Session after closing the original profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			await manager.acquire(binding, availableCapability);
			await manager.close(binding);
			await expect(
				manager.resume(
					{ ...binding, conversationId: "foreign" },
					availableCapability,
				),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			await expect(
				manager.close({ ...binding, conversationId: "foreign" }),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			expect(fake.launchPersistentContext).toHaveBeenCalledTimes(1);
			expect(fake.close).toHaveBeenCalledTimes(1);
			await expect(manager.resume(binding, availableCapability)).resolves.toBe(
				fake.context,
			);
			expect(fake.launchPersistentContext.mock.calls[1]?.[0]).toBe(
				join(root, "browser-profile"),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("retains the accepted Session binding when the caller changes it during launch", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			let finishLaunch: (context: BrowserContext) => void = () => {};
			fake.launchPersistentContext.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishLaunch = resolve;
					}),
			);
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			const supplied = {
				...binding,
				conversationId: String(binding.conversationId),
			};
			const opening = manager.acquire(supplied, availableCapability);
			supplied.conversationId = "foreign-conversation";
			finishLaunch(fake.context);
			await opening;
			expect(manager.snapshot()).toMatchObject(binding);
			await expect(
				manager.resume(supplied, availableCapability),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
			await expect(manager.resume(binding, availableCapability)).resolves.toBe(
				fake.context,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("creates one persistent profile and reuses it for the same binding", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			const first = await manager.acquire(binding, availableCapability);
			const second = await manager.resume(binding, availableCapability);

			expect(second).toBe(first);
			expect(fake.launchPersistentContext).toHaveBeenCalledOnce();
			expect(fake.launchPersistentContext.mock.calls[0]?.[0]).toBe(
				join(root, "browser-profile"),
			);
			expect(manager.snapshot()).toMatchObject({
				status: "ready",
				agentId: binding.agentId,
				conversationId: binding.conversationId,
				sessionGeneration: binding.sessionGeneration,
				resourceFence: binding.resourceFence,
			});
			await manager.close(binding);
			expect(fake.close).toHaveBeenCalledOnce();
			expect(manager.snapshot().status).toBe("closed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects unavailable capability and a foreign Session binding", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-infra-browser-context-"));
		try {
			const fake = fakeBrowserType();
			const manager = createBrowserContextManagerV1({
				sandboxRoot: root,
				browserType: fake.browserType,
			});
			await expect(
				manager.acquire(binding, {
					...availableCapability,
					status: "probe_failed",
					errorCode: "BROWSER_CAPABILITY_PROBE_FAILED",
					reason: "probe failed",
					retryable: true,
				}),
			).rejects.toThrow("BROWSER_CAPABILITY_PROBE_FAILED");
			await manager.acquire(binding, availableCapability);
			await expect(
				manager.acquire(
					{ ...binding, sessionGeneration: 2 },
					availableCapability,
				),
			).rejects.toThrow("BROWSER_CONTEXT_BINDING_CONFLICT");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
