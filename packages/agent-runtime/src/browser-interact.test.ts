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
		private readonly attributeGate: () => Promise<void> | undefined,
		private readonly connected: () => boolean,
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
		await this.attributeGate();
		if (name === "role") return this.name === "Submit" ? "button" : null;
		if (name === "type") return "text";
		return null;
	}

	async evaluate(callback: (node: object) => unknown) {
		return callback({
			tagName: "BUTTON",
			matches: () => false,
			isConnected: this.connected(),
		});
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
		return this;
	}
	async dispose() {}
	async contentFrame() {
		return {};
	}
}

class FakePage {
	urlValue = "about:blank";
	attributeGate?: Promise<void>;
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
			(name) =>
				new FakeLocator(
					name,
					this.calls,
					() => this.attributeGate,
					() => this.names.includes(name),
				),
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
	it("admits one of two simultaneous clicks at a single-action limit", async () => {
		const page = new FakePage();
		page.names[1] = "Show value";
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const reference = await controller.navigate("https://example.test/");
		const target = (await controller.observe(reference)).elements[1];
		if (!target) throw new Error("Expected a test button");
		let releaseAttributes!: () => void;
		page.attributeGate = new Promise<void>((resolve) => {
			releaseAttributes = resolve;
		});
		const first = controller.act({
			kind: "click",
			page: reference,
			target,
			operationRef: "first",
			attemptRef: "first",
			idempotencyKey: "first",
		});
		await Promise.resolve();
		const second = await controller.act({
			kind: "click",
			page: reference,
			target,
			operationRef: "second",
			attemptRef: "second",
			idempotencyKey: "second",
		});
		expect(second).toMatchObject({
			status: "rejected",
			reasonCode: "BROWSER_ACTION_CONCURRENCY_LIMIT",
		});
		await expect(
			controller.navigate("https://example.test/next"),
		).rejects.toThrow("BROWSER_ACTION_CONCURRENCY_LIMIT");
		releaseAttributes();
		const firstResult = await first;
		expect(firstResult.status).toBe("completed");
		expect(page.calls.click).toHaveLength(1);
	});

	it("requires a fresh observation when the page replaces a button", async () => {
		const page = new FakePage();
		page.names = ["Show first value"];
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const reference = await controller.navigate("https://example.test/");
		const target = (await controller.observe(reference)).elements[0];
		if (!target) throw new Error("Expected the first control");
		page.names = ["Show next value"];
		const result = await controller.act({
			kind: "click",
			page: reference,
			target,
			operationRef: "first",
			attemptRef: "first",
		});
		expect(result).toMatchObject({
			status: "rejected",
			reasonCode: "BROWSER_ELEMENT_REFERENCE_STALE",
		});
		expect(page.calls.click).toBeUndefined();
	});
	it("allows a normal local selection in the existing interactive mode", async () => {
		const page = new FakePage();
		page.names = ["Filter results"];
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const reference = await controller.navigate("https://example.test/");
		const target = (await controller.observe(reference)).elements[0];
		if (!target) throw new Error("Missing test selector");
		const result = await controller.act({
			kind: "select",
			page: reference,
			target,
			value: "open",
			operationRef: "select",
			attemptRef: "select",
		});
		expect(result).toMatchObject({ status: "completed", sideEffect: false });
		expect(page.calls.selectOption).toHaveLength(1);
	});

	it.each(["click", "check", "uncheck", "select", "fill"] as const)(
		"uses the observed control to reject a restricted %s before dispatch",
		async (kind) => {
			const page = new FakePage();
			page.names[1] = "Grant permissions";
			const controller = createBrowserObserveControllerV1({
				context: fakeContext(page) as never,
				capability: {
					...capability,
					operations: ["navigate", "observe", "interact"],
				},
			});
			const reference = await controller.navigate("https://example.test/");
			const submit = (await controller.observe(reference)).elements[1]!;
			const result = await controller.act({
				page: reference,
				kind,
				target: { ...submit, name: "", role: "" },
				operationRef: "operation",
				attemptRef: "attempt",
			});
			expect(result).toMatchObject({ status: "rejected", sideEffect: true });
			expect(Object.values(page.calls).flat()).toHaveLength(0);
		},
	);

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
