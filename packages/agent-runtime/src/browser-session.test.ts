import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import type { BrowserContext, BrowserType, Page } from "playwright-core";
import { expect, it } from "vitest";
import { createBrowserContextManagerV1 } from "./browser-context.js";
import { createBrowserSessionControllerV1 } from "./browser-session.js";

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact"],
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
		operations: ["navigate", "observe", "interact"],
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
		click: async () => undefined,
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
	const listeners = new Set<() => void>();
	let closed = false;
	const context = {
		pages: () => {
			if (closed) throw new Error("Context closed");
			return [page];
		},
		newPage: async () => page,
		route: async () => undefined,
		close: async () => undefined,
		on: (_event: string, listener: () => void) => {
			listeners.add(listener);
			return context;
		},
	} as unknown as BrowserContext;
	const browserType = {
		launchPersistentContext: async () => context,
	} as unknown as BrowserType;
	return {
		context,
		browserType,
		crash: () => {
			closed = true;
			for (const listener of listeners) listener();
		},
	};
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
	expect(first).toEqual({ status: "ready", ...binding, capabilityVersion: 1 });
	expect(second).toEqual(first);
	expect(first).not.toHaveProperty("pages");
	const page = await session.navigate("https://example.test/");
	const observation = await session.observe(page);
	expect(observation).toMatchObject({
		origin: "https://example.test",
		title: "Example",
		text: "Continue",
		tabCount: 1,
	});
	const target = observation.elements[0];
	if (!target) throw new Error("Expected a controlled target");
	const action = await session.act({
		kind: "click",
		page,
		target,
		operationRef: "test-operation",
		attemptRef: "test-attempt",
		idempotencyKey: "test-click",
	});
	expect(action).toMatchObject({ status: "completed" });
	await session.close();
	expect(session.snapshot().status).toBe("closed");
	const restarted = await session.start();
	expect(restarted).toMatchObject({ status: "ready" });
	await session.close();
});

it("creates fresh page references after a Context crash rather than using the old controller", async () => {
	const first = fakeBrowser();
	const second = fakeBrowser();
	let launches = 0;
	const manager = createBrowserContextManagerV1({
		sandboxRoot: "/tmp/browser-session-crash-test",
		browserType: {
			launchPersistentContext: async () =>
				++launches === 1 ? first.context : second.context,
		},
	});
	const session = createBrowserSessionControllerV1({
		manager,
		binding,
		capability,
	});
	const oldPage = await session.navigate("https://example.test/");
	first.crash();
	expect(session.snapshot().status).toBe("crashed");
	const newPage = await session.navigate("https://example.test/restored");
	expect(newPage.pageId).not.toBe(oldPage.pageId);
	await expect(session.observe(oldPage)).rejects.toThrow(
		"BROWSER_PAGE_REFERENCE_STALE",
	);
	expect(await session.observe(newPage)).toMatchObject({ title: "Example" });
	await session.close();
});
