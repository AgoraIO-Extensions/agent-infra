import { BrowserCapabilityAvailableV1Schema } from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import { createBrowserSessionDriverContextV1 } from "./browser-driver-context.js";
import type {
	BrowserActionRecordV1,
	BrowserObservationV1,
} from "./browser-observe.js";
import type { BrowserSessionControllerV1 } from "./browser-session.js";

const capability = BrowserCapabilityAvailableV1Schema.parse({
	schemaVersion: 1,
	capabilityVersion: 3,
	status: "available",
	operations: ["navigate", "observe", "interact", "handoff"],
	policy: {
		allowedOrigins: ["https://example.test/"],
		maxContexts: 1,
		maxTabs: 2,
		maxPages: 4,
		maxViewportWidth: 1280,
		maxViewportHeight: 720,
		maxConcurrentActions: 1,
		maxDownloads: 1,
		maxDownloadBytes: 1024,
		maxUploadBytes: 1024,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 1_000_000,
		navigationTimeoutMs: 15_000,
		actionTimeoutMs: 5_000,
		requireSideEffectConfirmation: true,
		allowUserHandoff: true,
	},
	provenance: {
		browser: "chromium",
		chromiumVersion: "1",
		playwrightVersion: "1",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	conformance: {
		schemaVersion: 1,
		receiptId: "receipt-1",
		probeVersion: "probe-1",
		verifiedAt: "2026-10-12T00:00:00.000Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact", "handoff"],
	},
});

const binding = {
	agentId: "agent-1",
	conversationId: "conversation-1",
	sessionGeneration: 1,
	resourceFence: 2,
	workloadRevision: 4,
	imageDigest: `sha256:${"a".repeat(64)}`,
};

const page = { pageId: "page-1", pageRevision: 2 };
const observation: BrowserObservationV1 = {
	page,
	origin: "https://example.test",
	title: "Example",
	text: "hello",
	tabCount: 1,
	frameCount: 1,
	elements: [],
};
const record: BrowserActionRecordV1 = {
	actionId: "action-1",
	operationRef: "operation-1",
	attemptRef: "attempt-1",
	kind: "click",
	status: "completed",
	page,
	sideEffect: false,
	createdAt: "2026-10-12T00:00:00.000Z",
};

function session(
	options: Partial<Pick<BrowserSessionControllerV1, "act" | "readAction">> = {},
): BrowserSessionControllerV1 {
	return {
		start: vi.fn(),
		navigate: vi.fn().mockResolvedValue(page),
		observe: vi.fn().mockResolvedValue(observation),
		act: options.act ?? vi.fn().mockResolvedValue(record),
		readAction: options.readAction ?? vi.fn().mockReturnValue(null),
		cancelAction: vi.fn().mockReturnValue(true),
		close: vi.fn(),
		recoverPage: vi.fn().mockResolvedValue(page),
		snapshot: vi.fn(),
	};
}

describe("createBrowserSessionDriverContextV1", () => {
	it("adapts navigate, observe and interact through the existing Session facade", async () => {
		const browser = session();
		const context = createBrowserSessionDriverContextV1({
			session: browser,
			capability,
			binding,
			subjectId: "user-1",
		});
		const navigate = await context.executeTool?.(
			{
				tool: "browser_navigate",
				arguments: { url: "https://example.test/" },
				actionId: "action-navigate",
				operationRef: "operation-navigate",
				attemptRef: "attempt-navigate",
				binding: {
					...binding,
					executionId: "execution-1",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			new AbortController().signal,
		);
		expect(navigate).toMatchObject({ phase: "completed", success: true });
		expect(browser.navigate).toHaveBeenCalledWith("https://example.test/");
		const observed = await context.executeTool?.(
			{
				tool: "browser_observe",
				arguments: page,
				actionId: "action-observe",
				operationRef: "operation-observe",
				attemptRef: "attempt-observe",
				binding: {
					...binding,
					executionId: "execution-1",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			new AbortController().signal,
		);
		expect(observed).toMatchObject({
			phase: "completed",
			contentItems: [{ type: "inputText" }],
		});
		const interacted = await context.executeTool?.(
			{
				tool: "browser_interact",
				arguments: { ...page, elementId: "element-1", kind: "click" },
				actionId: "action-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				binding: {
					...binding,
					executionId: "execution-1",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			new AbortController().signal,
		);
		expect(interacted).toMatchObject({ phase: "completed", success: true });
		expect(browser.act).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "click", actionId: "action-1" }),
			expect.any(AbortSignal),
		);
	});

	it("forwards cancellation to the existing Session action barrier", async () => {
		let release: (() => void) | undefined;
		const browser = session({
			act: vi.fn(
				() =>
					new Promise<BrowserActionRecordV1>((resolve) => {
						release = () => resolve({ ...record, status: "unknown" });
					}),
			),
		});
		const context = createBrowserSessionDriverContextV1({
			session: browser,
			capability,
			binding,
			subjectId: "user-1",
		});
		const controller = new AbortController();
		const pending = context.executeTool?.(
			{
				tool: "browser_interact",
				arguments: { ...page, elementId: "element-1", kind: "click" },
				actionId: "action-cancel",
				operationRef: "operation-cancel",
				attemptRef: "attempt-cancel",
				binding: {
					...binding,
					executionId: "execution-1",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			controller.signal,
		);
		await vi.waitFor(() => expect(browser.act).toHaveBeenCalled());
		controller.abort();
		expect(browser.cancelAction).toHaveBeenCalledWith("action-cancel");
		release?.();
		await expect(pending).resolves.toMatchObject({
			phase: "unknown",
			success: false,
			failureCode: "BROWSER_ACTION_CANCELLED_UNCONFIRMED",
		});
	});

	it("recovers a terminal controller result after an unknown action outcome", async () => {
		const recovered = {
			...record,
			executionBinding: {
				...binding,
				executionId: "execution-recovery",
				capabilityVersion: 3,
				pageRevision: 2,
			},
		};
		const readAction = vi.fn(() => recovered);
		const browser = session({
			act: vi.fn().mockResolvedValue({ ...record, status: "unknown" }),
			readAction,
		});
		const context = createBrowserSessionDriverContextV1({
			session: browser,
			capability,
			binding,
			subjectId: "user-1",
		});
		const result = await context.executeTool?.(
			{
				tool: "browser_interact",
				arguments: { ...page, elementId: "element-1", kind: "click" },
				actionId: "action-1",
				operationRef: "operation-1",
				attemptRef: "attempt-1",
				binding: {
					...binding,
					executionId: "execution-recovery",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			new AbortController().signal,
		);
		expect(result).toMatchObject({ phase: "completed", success: true });
		expect(readAction).toHaveBeenCalledOnce();
	});

	it("fails closed for unsupported tools and stale page references", async () => {
		const context = createBrowserSessionDriverContextV1({
			session: session(),
			capability,
			binding,
			subjectId: "user-1",
		});
		const unsupported = await context.executeTool?.(
			{
				tool: "browser_files",
				arguments: {},
				actionId: "action-files",
				operationRef: "operation-files",
				attemptRef: "attempt-files",
				binding: {
					...binding,
					executionId: "execution-1",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			new AbortController().signal,
		);
		expect(unsupported).toMatchObject({ phase: "failed", success: false });
		const stale = await context.executeTool?.(
			{
				tool: "browser_observe",
				arguments: { pageId: "page-1", pageRevision: 0 },
				actionId: "action-stale",
				operationRef: "operation-stale",
				attemptRef: "attempt-stale",
				binding: {
					...binding,
					executionId: "execution-1",
					capabilityVersion: 3,
					pageRevision: 2,
				},
			},
			new AbortController().signal,
		);
		expect(stale).toMatchObject({ phase: "failed", success: false });
	});

	it("rejects a foreign execution binding before Session I/O", async () => {
		const browser = session();
		const context = createBrowserSessionDriverContextV1({
			session: browser,
			capability,
			binding,
			subjectId: "user-1",
		});
		await expect(
			context.executeTool?.(
				{
					tool: "browser_navigate",
					arguments: { url: "https://example.test/" },
					actionId: "foreign-action",
					operationRef: "foreign-operation",
					attemptRef: "foreign-attempt",
					binding: {
						...binding,
						conversationId: "foreign-conversation",
						executionId: "execution-1",
						capabilityVersion: capability.capabilityVersion,
						pageRevision: 1,
					},
				},
				new AbortController().signal,
			),
		).rejects.toThrow("BROWSER_DRIVER_CONTEXT_BINDING_MISMATCH");
		expect(browser.navigate).not.toHaveBeenCalled();
		for (const change of [
			{ workloadRevision: 99 },
			{ imageDigest: `sha256:${"f".repeat(64)}` },
		]) {
			await expect(
				context.executeTool?.(
					{
						tool: "browser_navigate",
						arguments: { url: "https://example.test/" },
						actionId: "foreign-action",
						operationRef: "foreign-operation",
						attemptRef: "foreign-attempt",
						binding: {
							...binding,
							...change,
							executionId: "execution-1",
							capabilityVersion: capability.capabilityVersion,
							pageRevision: 1,
						},
					},
					new AbortController().signal,
				),
			).rejects.toThrow("BROWSER_DRIVER_CONTEXT_BINDING_MISMATCH");
		}
		expect(browser.navigate).not.toHaveBeenCalled();
	});
});
