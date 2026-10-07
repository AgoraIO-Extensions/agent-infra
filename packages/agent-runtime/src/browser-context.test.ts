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
	const context = { close, on: vi.fn() } as unknown as BrowserContext;
	const launchPersistentContext = vi.fn(
		async (_userDataDir: string, _options: unknown) => context,
	);
	return {
		browserType: { launchPersistentContext } as unknown as BrowserType,
		context,
		close,
		launchPersistentContext,
	};
}

describe("Session BrowserContext manager", () => {
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
