import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createBrowserObserveControllerV1 } from "./browser-observe.ts";

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
		maxViewportWidth: 1920,
		maxViewportHeight: 1080,
		maxConcurrentActions: 1,
		maxDownloads: 2,
		maxDownloadBytes: 1_000_000,
		maxUploadBytes: 1_000_000,
		maxScreenshotBytes: 1_000_000,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 10_000_000,
		navigationTimeoutMs: 5_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: true,
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
		verifiedAt: "2026-10-06T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe"],
	},
};

class FakePage {
	urlValue = "about:blank";
	titleValue = "Example";
	handlers = new Map<string, (value: unknown) => void>();
	pageLocator = {
		innerText: vi.fn(async () => "Visible page text"),
		count: vi.fn(async () => 1),
		nth: vi.fn(() => this.pageLocator),
		isVisible: vi.fn(async () => true),
		getAttribute: vi.fn(async (name: string) =>
			name === "role" ? "button" : "Run",
		),
		evaluate: vi.fn(async () => "button"),
	};

	on(event: string, handler: (value: unknown) => void) {
		this.handlers.set(event, handler);
		return this;
	}

	mainFrame() {
		return this;
	}

	async goto(url: string) {
		this.urlValue = url;
		this.handlers.get("framenavigated")?.(this);
		return null;
	}

	url() {
		return this.urlValue;
	}

	async title() {
		return this.titleValue;
	}

	locator(selector: string) {
		if (selector === "iframe") return { count: async () => 0 };
		return this.pageLocator;
	}
}

function fakeContext(page: FakePage) {
	const routes: unknown[] = [];
	return {
		page,
		routes,
		route: vi.fn(async (_pattern: string, handler: unknown) => {
			routes.push(handler);
		}),
		pages: vi.fn(() => [page]),
		newPage: vi.fn(async () => page),
	};
}

describe("Browser observe controller", () => {
	it("navigates only to approved origins and expires element references on navigation", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability,
		});

		const reference = await controller.navigate("https://example.test/app");
		const observation = await controller.observe(reference);
		expect(observation.origin).toBe("https://example.test");
		expect(observation.text).toBe("Visible page text");
		expect(observation.elements[0]?.role).toBe("button");
		const element = observation.elements[0];
		if (!element) throw new Error("Expected an element reference");
		expect(controller.resolveElement(element)).toBeDefined();

		await controller.navigate("https://example.test/next");
		expect(() => controller.resolveElement(element)).toThrow(
			"BROWSER_ELEMENT_REFERENCE_STALE",
		);
		await expect(
			controller.navigate("https://other.example/app"),
		).rejects.toThrow("BROWSER_NAVIGATION_ORIGIN_DENIED");
	});

	it("rebinds persisted page metadata and invalidates old elements", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability,
			recoveryBinding: { sessionGeneration: 2, resourceFence: 7 },
		});
		const reference = await controller.navigate("https://example.test/app");
		const observation = await controller.observe(reference);
		const element = observation.elements[0];
		if (!element) throw new Error("expected element");
		const rebound = await controller.recoverPage({
			pageId: reference.pageId,
			pageRevision: reference.pageRevision,
			tabIndex: 0,
			origin: "https://example.test",
			capabilityVersion: 1,
			sessionGeneration: 2,
			resourceFence: 7,
		});
		expect(rebound).toEqual(reference);
		expect(() => controller.resolveElement(element)).toThrow(
			"BROWSER_ELEMENT_REFERENCE_STALE",
		);
	});

	it("rejects recovery for missing pages and mismatched bindings", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability,
			recoveryBinding: { sessionGeneration: 2, resourceFence: 7 },
		});
		const reference = await controller.navigate("https://example.test/app");
		context.pages.mockReturnValue([]);
		await expect(
			controller.recoverPage({
				pageId: reference.pageId,
				pageRevision: reference.pageRevision,
				tabIndex: 0,
				origin: "https://example.test",
				capabilityVersion: 1,
				sessionGeneration: 2,
				resourceFence: 7,
			}),
		).rejects.toThrow("BROWSER_PAGE_RECOVERY_PAGE_MISSING");
		context.pages.mockReturnValue([page]);
		await expect(
			controller.recoverPage({
				pageId: reference.pageId,
				pageRevision: reference.pageRevision,
				tabIndex: 0,
				origin: "https://example.test",
				capabilityVersion: 1,
				sessionGeneration: 3,
				resourceFence: 7,
			}),
		).rejects.toThrow("BROWSER_PAGE_RECOVERY_BINDING_MISMATCH");
		await expect(
			controller.recoverPage({
				pageId: reference.pageId,
				pageRevision: reference.pageRevision + 1,
				tabIndex: 0,
				origin: "https://example.test",
				capabilityVersion: 1,
				sessionGeneration: 2,
				resourceFence: 7,
			}),
		).rejects.toThrow("BROWSER_PAGE_RECOVERY_REVISION_MISMATCH");
	});
});
