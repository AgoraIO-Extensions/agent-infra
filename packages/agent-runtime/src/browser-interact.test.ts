import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createBrowserObserveControllerV1 } from "./browser-observe.ts";

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 1,
	status: "available",
	operations: ["navigate", "observe", "interact", "side_effects"],
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
		operations: ["navigate", "observe", "interact", "side_effects"],
	},
};

class FakeLocator {
	constructor(
		private readonly name: string,
		private readonly calls: Record<string, unknown[]>,
	) {}

	private record(method: string, value: unknown) {
		const entries = this.calls[method] ?? [];
		entries.push(value);
		this.calls[method] = entries;
	}

	async innerText() {
		return this.name;
	}

	async isVisible() {
		return true;
	}

	async getAttribute(name: string) {
		if (name === "role") return this.name === "Submit" ? "button" : null;
		if (name === "type") return "text";
		return null;
	}

	async evaluate() {
		return "button";
	}

	async click(options: unknown) {
		this.record("click", options);
	}

	async fill(value: string, options: unknown) {
		this.record("fill", { value, options });
	}

	async selectOption(value: string, options: unknown) {
		this.record("selectOption", { value, options });
	}

	async check(options: unknown) {
		this.record("check", options);
	}

	async uncheck(options: unknown) {
		this.record("uncheck", options);
	}

	async press(value: string, options: unknown) {
		this.record("press", { value, options });
	}

	async hover(options: unknown) {
		this.record("hover", options);
	}

	async scrollIntoViewIfNeeded(options: unknown) {
		this.record("scroll", options);
	}

	async elementHandle() {
		return { contentFrame: async () => ({}) };
	}
}

class FakePage {
	urlValue = "about:blank";
	handlers = new Map<string, (value: unknown) => void>();
	calls: Record<string, unknown[]> = {};
	names = ["email", "Submit"];

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
	}

	url() {
		return this.urlValue;
	}

	async title() {
		return "Example";
	}

	locator(selector: string) {
		if (selector === "iframe") return { count: async () => 0 };
		if (selector === "body")
			return {
				innerText: async () => "Visible page text",
			};
		const locators = this.names.map(
			(name) => new FakeLocator(name, this.calls),
		);
		return {
			count: async () => locators.length,
			nth: (index: number) => locators[index],
		};
	}
}

function fakeContext(page: FakePage) {
	return {
		route: vi.fn(async () => undefined),
		pages: vi.fn(() => [page]),
		newPage: vi.fn(async () => page),
	};
}

describe("Browser interaction controller", () => {
	it("rejects an action without a Platform operation attempt before page I/O", async () => {
		const page = new FakePage();
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const pageReference = await controller.navigate("https://example.test/");
		const observation = await controller.observe(pageReference);
		const field = observation.elements[0];
		if (!field) throw new Error("expected observed field");
		await expect(
			controller.act({
				kind: "fill",
				page: pageReference,
				target: field,
				value: "blocked@example.test",
			}),
		).resolves.toMatchObject({
			status: "rejected",
			reasonCode: "BROWSER_ACTION_OPERATION_REQUIRED",
		});
		expect(page.calls.fill ?? []).toHaveLength(0);
	});

	it("executes bounded actions and requires an immutable side-effect confirmation", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability,
		});
		const pageReference = await controller.navigate("https://example.test/");
		const observation = await controller.observe(pageReference);
		const field = observation.elements[0];
		const submit = observation.elements[1];
		if (!field || !submit) throw new Error("expected observed controls");
		const operation = (name: string) => ({
			operationRef: `browser-operation-${name}`,
			attemptRef: `browser-attempt-${name}`,
		});

		await expect(
			controller.act({
				kind: "fill",
				page: pageReference,
				target: field,
				value: "alice@example.test",
				...operation("fill"),
			}),
		).resolves.toMatchObject({ status: "completed", kind: "fill" });
		await expect(
			controller.act({
				kind: "press",
				page: pageReference,
				target: field,
				key: "Enter",
				...operation("press"),
			}),
		).resolves.toMatchObject({ status: "completed", kind: "press" });
		await expect(
			controller.act({
				kind: "click",
				page: pageReference,
				target: submit,
				sideEffect: true,
				...operation("missing-authorization"),
			}),
		).resolves.toMatchObject({
			status: "rejected",
			reasonCode: "BROWSER_ACTION_AUTHORIZATION_REQUIRED",
		});

		const request = {
			kind: "click" as const,
			page: pageReference,
			target: submit,
			sideEffect: true,
			idempotencyKey: "submit-once",
			...operation("submit"),
			authorization: {
				subjectId: "subject-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
			},
		};
		const preview = await controller.act(request);
		expect(preview.status).toBe("rejected");
		expect(preview.reasonCode).toBe(
			"BROWSER_SIDE_EFFECT_CONFIRMATION_REQUIRED",
		);
		if (!preview.confirmation) throw new Error("expected confirmation preview");
		const completed = await controller.act({
			...request,
			actionId: preview.actionId,
			confirmation: preview.confirmation,
		});
		expect(completed.status).toBe("completed");
		expect(page.calls.click).toHaveLength(1);
		await expect(
			controller.act({
				...request,
				actionId: preview.actionId,
				confirmation: preview.confirmation,
			}),
		).resolves.toMatchObject({
			status: "completed",
			actionId: preview.actionId,
		});
		expect(page.calls.click).toHaveLength(1);

		const secondPage = new FakePage();
		context.pages.mockReturnValue([page, secondPage]);
		const tabs = controller.listPages();
		expect(tabs).toHaveLength(2);
		await expect(
			controller.act({
				kind: "switch_tab",
				page: pageReference,
				targetPage: tabs[1],
				...operation("switch-tab"),
			}),
		).resolves.toMatchObject({ status: "completed", page: tabs[1] });
	});
});
