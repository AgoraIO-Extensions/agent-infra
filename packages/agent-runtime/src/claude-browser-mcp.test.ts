import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeBrowserMcpServer } from "./claude-browser-mcp.js";

const sdk = vi.hoisted(() => ({
	createSdkMcpServer: vi.fn((options: Record<string, unknown>) => ({
		type: "sdk",
		name: options.name,
		instance: { tools: options.tools },
	})),
	tool: vi.fn(
		(
			name: string,
			description: string,
			inputSchema: unknown,
			handler: (input: unknown, extra: unknown) => Promise<unknown>,
		) => ({ name, description, inputSchema, handler }),
	),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);

const capability: BrowserCapabilityAvailableV1 = {
	schemaVersion: 1,
	capabilityVersion: 3,
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
		maxDownloads: 1,
		maxDownloadBytes: 1024,
		maxUploadBytes: 1024,
		maxScreenshotBytes: 1024,
		maxBrowserDurationMs: 60_000,
		maxRetainedProfileBytes: 100_000,
		navigationTimeoutMs: 15_000,
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
		verifiedAt: "2026-10-10T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe", "interact"],
	},
};

const browser = (
	executeTool: NonNullable<
		Parameters<typeof createClaudeBrowserMcpServer>[0]["context"]
	>["executeTool"],
) => ({
	capabilityVersion: capability.capabilityVersion,
	binding: {
		agentId: "agent-a",
		conversationId: "conversation-a",
		sessionGeneration: 2,
		resourceFence: 8,
		workloadRevision: 4,
		imageDigest: `sha256:${"d".repeat(64)}`,
	},
	executeTool,
});

afterEach(() => vi.clearAllMocks());

it("registers only bounded Browser tools for a verified request-local context", async () => {
	const executeTool = vi.fn(async (request) => ({
		actionId: request.actionId,
		operationRef: request.operationRef,
		attemptRef: request.attemptRef,
		binding: request.binding,
		phase: "completed" as const,
		contentItems: [{ type: "inputText" as const, text: "observed" }],
		success: true,
	}));
	const server = createClaudeBrowserMcpServer({
		capability,
		context: browser(executeTool),
		executionId: "execution-a",
		signal: new AbortController().signal,
	});
	const tools = sdk.tool.mock.results.map((entry) => entry.value) as Array<{
		name: string;
		inputSchema: { _zod?: unknown };
		handler: (input: unknown, extra: unknown) => Promise<unknown>;
	}>;
	expect(server).toMatchObject({ type: "sdk", name: "agent-infra-browser" });
	expect(tools.map((tool) => tool.name)).toEqual([
		"browser_navigate",
		"browser_observe",
		"browser_interact",
	]);
	expect(tools.every((tool) => tool.inputSchema._zod)).toBe(true);
	const navigate =
		tools[0] ??
		(() => {
			throw new Error("missing tool");
		})();
	expect(await navigate.handler({ url: "https://example.test/" }, {})).toEqual({
		content: [{ type: "text", text: "observed" }],
		isError: false,
	});
	expect(executeTool).toHaveBeenCalledWith(
		expect.objectContaining({
			tool: "browser_navigate",
			arguments: { url: "https://example.test/" },
			binding: {
				agentId: "agent-a",
				conversationId: "conversation-a",
				executionId: "execution-a",
				sessionGeneration: 2,
				resourceFence: 8,
				capabilityVersion: 3,
				pageRevision: 1,
			},
		}),
		expect.any(AbortSignal),
	);
});

it("fails closed when Browser context or capability is unavailable", () => {
	const signal = new AbortController().signal;
	expect(
		createClaudeBrowserMcpServer({
			capability,
			context: undefined,
			executionId: "execution-a",
			signal,
		}),
	).toBeUndefined();
	expect(
		createClaudeBrowserMcpServer({
			capability: undefined,
			context: browser(undefined),
			executionId: "execution-a",
			signal,
		}),
	).toBeUndefined();
	expect(sdk.tool).not.toHaveBeenCalled();
});

it("does not turn failed, mismatched or cancelled Browser calls into success", async () => {
	const executeTool = vi
		.fn()
		.mockResolvedValueOnce({
			actionId: "foreign",
			operationRef: "foreign",
			attemptRef: "foreign",
			binding: {
				agentId: "agent-a",
				conversationId: "conversation-a",
				executionId: "execution-a",
				sessionGeneration: 2,
				resourceFence: 8,
				capabilityVersion: 3,
				pageRevision: 1,
			},
			phase: "completed",
			contentItems: [{ type: "inputText", text: "forged" }],
			success: true,
		})
		.mockResolvedValueOnce({
			actionId: "unused",
			operationRef: "unused",
			attemptRef: "unused",
			binding: {
				agentId: "agent-a",
				conversationId: "conversation-a",
				executionId: "execution-a",
				sessionGeneration: 2,
				resourceFence: 8,
				capabilityVersion: 3,
				pageRevision: 1,
			},
			phase: "failed",
			contentItems: [],
			success: false,
			failureCode: "operation_failed",
		});
	const controller = new AbortController();
	const server = createClaudeBrowserMcpServer({
		capability,
		context: browser(executeTool),
		executionId: "execution-a",
		signal: controller.signal,
	});
	expect(server).toBeDefined();
	const tools = sdk.tool.mock.results.map((entry) => entry.value) as Array<{
		handler: (
			input: unknown,
			extra: unknown,
		) => Promise<{
			isError: boolean;
		}>;
	}>;
	const input = { pageId: "page", pageRevision: 1 };
	expect(await tools[1]?.handler(input, {})).toMatchObject({ isError: true });
	expect(await tools[1]?.handler(input, {})).toMatchObject({ isError: true });
	controller.abort();
	expect(await tools[1]?.handler(input, {})).toMatchObject({ isError: true });
});
