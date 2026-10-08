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
		click: vi.fn(async (): Promise<void> => undefined),
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

function executionBinding(pageRevision: number) {
	return {
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		capabilityVersion: capability.capabilityVersion,
		pageRevision,
		sessionGeneration: 2,
		resourceFence: 7,
	} as const;
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
			url: "https://example.test/app",
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
				url: "https://example.test/app",
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
				url: "https://example.test/app",
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
				url: "https://example.test/app",
				origin: "https://example.test",
				capabilityVersion: 1,
				sessionGeneration: 2,
				resourceFence: 7,
			}),
		).rejects.toThrow("BROWSER_PAGE_RECOVERY_REVISION_MISMATCH");
		await expect(
			controller.recoverPage({
				pageId: reference.pageId,
				pageRevision: reference.pageRevision,
				tabIndex: 0,
				url: "https://example.test/other",
				origin: "https://example.test",
				capabilityVersion: 1,
				sessionGeneration: 2,
				resourceFence: 7,
			}),
		).rejects.toThrow("BROWSER_PAGE_RECOVERY_URL_MISMATCH");
	});
});

describe("Browser action cancellation barrier", () => {
	it("converges an in-flight action to unknown and blocks completed replay", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability: {
				...capability,
				operations: ["navigate", "observe", "interact"],
			},
		});
		const reference = await controller.navigate("https://example.test/app");
		const observation = await controller.observe(reference);
		const target = observation.elements[0];
		if (!target) throw new Error("expected element");
		let releaseClick!: () => void;
		page.pageLocator.click = vi.fn(
			() => new Promise<void>((resolve) => (releaseClick = resolve)),
		);
		const executionBinding = {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			capabilityVersion: 1,
			pageRevision: reference.pageRevision,
			sessionGeneration: 2,
			resourceFence: 3,
		} as const;
		const request = {
			actionId: "cancelled-action",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			idempotencyKey: "cancelled-action-key",
			kind: "click" as const,
			page: reference,
			target,
			executionBinding,
		};
		const pending = controller.executeAction(request);
		await Promise.resolve();
		expect(controller.cancelAction("cancelled-action")).toBe(true);
		expect(controller.cancelAction("cancelled-action")).toBe(true);
		releaseClick();
		await expect(pending).resolves.toMatchObject({
			status: "unknown",
			reasonCode: "BROWSER_ACTION_CANCELLED_UNCONFIRMED",
		});
		expect(controller.cancelAction("cancelled-action")).toBe(false);
		expect(
			controller.readAction({ actionId: "cancelled-action", executionBinding }),
		).toMatchObject({
			status: "unknown",
		});
		await expect(controller.executeAction(request)).resolves.toMatchObject({
			status: "unknown",
			reasonCode: "BROWSER_ACTION_CANCELLED_UNCONFIRMED",
		});
	});
});

describe("Browser action outcome readback", () => {
	it("reads terminal records without browser I/O and rejects conflicting keys", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability: {
				...capability,
				operations: ["navigate", "observe", "interact"],
			},
		});
		const reference = await controller.navigate("https://example.test/app");
		const observation = await controller.observe(reference);
		const target = observation.elements[0];
		if (!target) throw new Error("expected element");
		const request = {
			actionId: "readback-action",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			idempotencyKey: "readback-key",
			kind: "click" as const,
			page: reference,
			target,
		};
		await expect(controller.executeAction(request)).resolves.toMatchObject({
			status: "completed",
		});
		expect(
			controller.readAction({ actionId: "readback-action" }),
		).toMatchObject({
			status: "completed",
		});
		expect(
			controller.readAction({ idempotencyKey: "readback-key" }),
		).toMatchObject({
			status: "completed",
		});
		expect(controller.readAction({ actionId: "missing" })).toBeNull();
		expect(() =>
			controller.readAction({
				actionId: "readback-action",
				idempotencyKey: "missing",
			}),
		).toThrow("BROWSER_ACTION_READBACK_CONFLICT");
	});
	it("indexes actionId-only rejected outcomes for readback", async () => {
		const page = new FakePage();
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const result = await controller.executeAction({
			actionId: "rejected-only",
			kind: "click",
			page: { pageId: "missing", pageRevision: 1 },
		});
		expect(result.status).toBe("rejected");
		expect(controller.readAction({ actionId: "rejected-only" })).toEqual(
			result,
		);
	});
	it("retains and validates execution binding in action readback", async () => {
		const page = new FakePage();
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability,
		});
		const binding = {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			capabilityVersion: 1,
			pageRevision: 1,
			sessionGeneration: 2,
			resourceFence: 3,
		} as const;
		const result = await controller.executeAction({
			actionId: "bound-action",
			kind: "click",
			page: { pageId: "missing", pageRevision: 1 },
			executionBinding: binding,
		});
		expect(
			controller.readAction({
				actionId: "bound-action",
				executionBinding: binding,
			}),
		).toEqual(result);
		expect(() =>
			controller.readAction({
				actionId: "bound-action",
				executionBinding: { ...binding, executionId: "other" },
			}),
		).toThrow("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		expect(() =>
			controller.readAction({
				actionId: "bound-action",
				executionBinding: { ...binding, sessionGeneration: 9 },
			}),
		).toThrow("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		expect(() =>
			controller.readAction({
				actionId: "bound-action",
				executionBinding: { ...binding, resourceFence: 9 },
			}),
		).toThrow("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		const mutableBinding = { ...binding, executionId: "execution-1" as string };
		const mutableResult = await controller.executeAction({
			actionId: "immutable-action",
			kind: "click",
			page: { pageId: "missing", pageRevision: 1 },
			executionBinding: mutableBinding,
		});
		mutableBinding.executionId = "mutated";
		expect(mutableResult.executionBinding).toEqual(binding);
		expect(
			controller.readAction({
				actionId: "immutable-action",
				executionBinding: binding,
			}),
		).toEqual(mutableResult);
	});
	it("retains execution binding and rejects cross-binding readback", async () => {
		const page = new FakePage();
		const context = fakeContext(page);
		const controller = createBrowserObserveControllerV1({
			context: context as never,
			capability: {
				...capability,
				operations: ["navigate", "observe", "interact"],
			},
		});
		const reference = await controller.navigate("https://example.test/app");
		const observation = await controller.observe(reference);
		const target = observation.elements[0];
		if (!target) throw new Error("expected element");
		const binding = executionBinding(reference.pageRevision);
		const result = await controller.executeAction({
			actionId: "bound-action",
			idempotencyKey: "bound-key",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "click",
			page: reference,
			target,
			executionBinding: binding,
		});
		expect(result).toMatchObject({
			status: "completed",
			executionBinding: binding,
		});
		expect(
			controller.readAction({
				actionId: "bound-action",
				executionBinding: binding,
			}),
		).toMatchObject({ status: "completed", executionBinding: binding });
		expect(() =>
			controller.readAction({
				actionId: "bound-action",
				executionBinding: { ...binding, executionId: "other-execution" },
			}),
		).toThrow("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		expect(() => controller.readAction({ actionId: "bound-action" })).toThrow(
			"BROWSER_ACTION_READBACK_BINDING_CONFLICT",
		);
		expect(() =>
			controller.readAction({ idempotencyKey: "bound-key" }),
		).toThrow("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		expect(
			Reflect.set(result, "executionBinding", {
				...binding,
				executionId: "altered",
			}),
		).toBe(false);
		if (!result.executionBinding) throw new Error("expected execution binding");
		expect(Reflect.set(result.executionBinding, "executionId", "altered")).toBe(
			false,
		);
		const conflict = await controller.executeAction({
			actionId: "different-binding",
			idempotencyKey: "bound-key",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "click",
			page: reference,
			target,
			executionBinding: { ...binding, executionId: "other-execution" },
		});
		expect(conflict).toMatchObject({
			status: "rejected",
			reasonCode: "BROWSER_ACTION_IDEMPOTENCY_CONFLICT",
		});
		await expect(
			controller.executeAction({
				actionId: "bound-action",
				operationRef: "operation-2",
				attemptRef: "attempt-2",
				kind: "click",
				page: reference,
				target,
				executionBinding: {
					...binding,
					pageRevision: reference.pageRevision + 1,
				},
			}),
		).rejects.toThrow("BROWSER_ACTION_BINDING_INVALID");
		expect(
			controller.readAction({
				actionId: "bound-action",
				executionBinding: binding,
			}),
		).toMatchObject({ status: "completed", executionBinding: binding });

		const rejectedBinding = executionBinding(1);
		const inherited = Object.create(rejectedBinding);
		const inheritedResult = await controller.executeAction({
			actionId: "inherited-binding",
			kind: "click",
			page: { pageId: "missing", pageRevision: 1 },
			executionBinding: inherited,
		});
		expect(inheritedResult.executionBinding).toEqual(rejectedBinding);
		expect(
			controller.readAction({
				actionId: "inherited-binding",
				executionBinding: rejectedBinding,
			}),
		).toEqual(inheritedResult);
		const rejected = await controller.executeAction({
			actionId: "bound-rejected",
			kind: "click",
			page: { pageId: "missing", pageRevision: 1 },
			executionBinding: rejectedBinding,
		});
		expect(rejected).toMatchObject({
			status: "rejected",
			executionBinding: rejectedBinding,
		});
		expect(
			controller.readAction({
				actionId: "bound-rejected",
				executionBinding: rejectedBinding,
			}),
		).toMatchObject({ status: "rejected", executionBinding: rejectedBinding });
	});

	it("excludes non-binding metadata from the snapshot and idempotency digest", async () => {
		const page = new FakePage();
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability: {
				...capability,
				operations: ["navigate", "observe", "interact"],
			},
		});
		const reference = await controller.navigate("https://example.test/app");
		const target = (await controller.observe(reference)).elements[0];
		if (!target) throw new Error("expected element");
		const binding = executionBinding(reference.pageRevision);
		const supplied = { ...binding, metadata: { value: "original" } };
		const request = {
			actionId: "metadata-action",
			idempotencyKey: "metadata-key",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "click" as const,
			page: reference,
			target,
			executionBinding: supplied,
		};
		const result = await controller.executeAction(request);
		expect(result.executionBinding).toEqual(binding);
		supplied.metadata.value = "changed";
		expect(await controller.executeAction(request)).toEqual(result);
		expect(page.pageLocator.click).toHaveBeenCalledTimes(1);
	});

	it("captures the dispatch binding before awaiting Browser I/O", async () => {
		const page = new FakePage();
		const controller = createBrowserObserveControllerV1({
			context: fakeContext(page) as never,
			capability: {
				...capability,
				operations: ["navigate", "observe", "interact"],
			},
		});
		const reference = await controller.navigate("https://example.test/app");
		const target = (await controller.observe(reference)).elements[0];
		if (!target) throw new Error("expected element");
		const original = executionBinding(reference.pageRevision);
		const mutable = { ...original, executionId: "execution-1" as string };
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		page.pageLocator.click = vi.fn(async () => {
			entered.resolve();
			await release.promise;
		});
		const request = {
			actionId: "captured-action",
			operationRef: "operation-1",
			attemptRef: "attempt-1",
			kind: "click" as const,
			page: reference,
			target,
			executionBinding: mutable,
		};
		const pending = controller.executeAction(request);
		await entered.promise;
		mutable.executionId = "changed-during-dispatch";
		release.resolve();
		expect(await pending).toMatchObject({
			status: "completed",
			executionBinding: original,
		});
		const calls = page.pageLocator.click.mock.calls.length;
		expect(
			controller.readAction({
				actionId: "captured-action",
				executionBinding: original,
			}),
		).toMatchObject({ executionBinding: original });
		expect(() =>
			controller.readAction({
				actionId: "captured-action",
				executionBinding: mutable,
			}),
		).toThrow("BROWSER_ACTION_READBACK_BINDING_CONFLICT");
		expect(page.pageLocator.click).toHaveBeenCalledTimes(calls);
		page.pageLocator.click = vi.fn(async () => {
			throw new Error("fixture failure");
		});
		const failed = await controller.executeAction({
			...request,
			actionId: "failed-action",
			executionBinding: original,
		});
		expect(failed).toMatchObject({
			status: "failed",
			executionBinding: original,
		});
		expect(
			controller.readAction({
				actionId: "failed-action",
				executionBinding: original,
			}),
		).toEqual(failed);
	});
});
