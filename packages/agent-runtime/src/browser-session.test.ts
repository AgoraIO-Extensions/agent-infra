import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import type { BrowserContext, BrowserType, Page } from "playwright-core";
import { expect, it } from "vitest";
import { createBrowserContextManagerV1 } from "./browser-context.js";
import { createBrowserSessionControllerV1 } from "./browser-session.js";

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 2,
		maxPages: 2,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 0,
		maxDownloadBytes: 0,
		maxUploadBytes: 0,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 1_000_000,
		navigationTimeoutMs: 5_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: false,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "153.0.8010.12",
		playwrightVersion: "1.63.0",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "receipt",
		probeVersion: "probe",
		verifiedAt: "2026-10-09T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe"],
	},
};

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	sessionGeneration: 1,
	resourceFence: 1,
} as const;

function fakePage() {
	let url = "about:blank";
	const listeners = new Map<string, (value: unknown) => void>();
	const button = {
		isVisible: async () => true,
		getAttribute: async (name: string) =>
			name === "aria-label" ? "Continue" : null,
		innerText: async () => "Continue",
		evaluate: async () => "button",
	};
	const page = {
		on: (event: string, listener: (value: unknown) => void) => {
			listeners.set(event, listener);
			return page;
		},
		mainFrame: () => page,
		goto: async (next: string) => {
			url = next;
			listeners.get("framenavigated")?.(page);
		},
		url: () => url,
		title: async () => "Example",
		locator: (selector: string) => {
			if (selector === "body") return { innerText: async () => "Continue" };
			if (selector === "iframe") return { count: async () => 0 };
			return { count: async () => 1, nth: () => button };
		},
	} as unknown as Page;
	return page;
}

function fakeBrowser() {
	const page = fakePage();
	const context = {
		pages: () => [page],
		newPage: async () => page,
		route: async () => undefined,
		close: async () => undefined,
		on: () => context,
	} as unknown as BrowserContext;
	const browserType = {
		launchPersistentContext: async () => context,
	} as unknown as BrowserType;
	return { context, browserType };
}

it("composes one Session facade over Context lifecycle and observe controller", async () => {
	const fake = fakeBrowser();
	const manager = createBrowserContextManagerV1({
		sandboxRoot: "/tmp/browser-session-test",
		browserType: fake.browserType,
	});
	const session = createBrowserSessionControllerV1({
		manager,
		binding,
		capability,
	});
	const [first, second] = await Promise.all([session.start(), session.start()]);
	expect(first).toBe(fake.context);
	expect(second).toBe(fake.context);
	const page = await session.navigate("https://example.test/");
	const observation = await session.observe(page);
	expect(observation).toMatchObject({
		origin: "https://example.test",
		title: "Example",
		text: "Continue",
		tabCount: 1,
	});
	await session.close();
	expect(session.snapshot().status).toBe("closed");
	const restarted = await session.start();
	expect(restarted).toBe(fake.context);
	await session.close();
});
