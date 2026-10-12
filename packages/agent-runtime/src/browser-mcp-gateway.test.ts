import { randomUUID } from "node:crypto";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import {
	createBrowserMcpGatewayV1,
	executeBrowserMcpToolV1,
} from "./browser-mcp-gateway.js";
import type { RuntimeBrowserToolExecutionRequestV1 } from "./driver.js";

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
		receiptId: "controlled-receipt",
		probeVersion: "controlled-probe",
		verifiedAt: "2026-10-10T00:00:00Z",
		manifestDigest: `sha256:${"b".repeat(64)}`,
		evidenceHash: "c".repeat(64),
		operations: ["navigate", "observe"],
	},
};

const gateways: { close(): Promise<void> }[] = [];
afterEach(async () => {
	while (gateways.length) await gateways.pop()?.close();
});

function toolRequest(): RuntimeBrowserToolExecutionRequestV1 {
	return {
		tool: "browser_navigate",
		arguments: { url: "https://example.test/" },
		actionId: "action-cancelled",
		operationRef: "operation-cancelled",
		attemptRef: "attempt-cancelled",
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
			resourceFence: 2,
			workloadRevision: 3,
			imageDigest: `sha256:${"d".repeat(64)}`,
			capabilityVersion: 1,
			pageRevision: 1,
		},
	};
}

it("fails closed when cancellation arrives after Browser controller I/O", async () => {
	const controller = new AbortController();
	const result = await executeBrowserMcpToolV1({
		request: toolRequest(),
		signal: controller.signal,
		executeTool: async (request) => {
			controller.abort();
			return {
				...request,
				phase: "completed" as const,
				contentItems: [{ type: "inputText" as const, text: "forged" }],
				success: true,
			};
		},
	});
	expect(result).toEqual({
		content: [{ type: "text", text: "BROWSER_EXECUTION_UNKNOWN" }],
		isError: true,
	});
});

it("does not call the Browser controller for an already cancelled request", async () => {
	const controller = new AbortController();
	controller.abort();
	const executeTool = async () => {
		throw new Error("must not execute");
	};
	const result = await executeBrowserMcpToolV1({
		request: toolRequest(),
		signal: controller.signal,
		executeTool,
	});
	expect(result).toEqual({
		content: [{ type: "text", text: "BROWSER_EXECUTION_UNKNOWN" }],
		isError: true,
	});
});

it("serves verified Browser tools and forwards calls to the request-local executor", async () => {
	const calls: unknown[] = [];
	const executionId = randomUUID();
	const gateway = await createBrowserMcpGatewayV1({
		capability,
		executionId,
		context: {
			capabilityVersion: 1,
			binding: {
				agentId: "agent-1",
				conversationId: "conversation-1",
				sessionGeneration: 1,
				resourceFence: 2,
				workloadRevision: 3,
				imageDigest: `registry.example/browser@sha256:${"d".repeat(64)}`,
			},
			executeTool: async (request) => {
				calls.push(request);
				return {
					actionId: request.actionId,
					operationRef: request.operationRef,
					attemptRef: request.attemptRef,
					binding: request.binding,
					phase: "completed",
					contentItems: [{ type: "inputText", text: "navigated" }],
					success: true,
				};
			},
		},
	});
	gateways.push(gateway);
	const client = new Client({ name: "browser-gateway-test", version: "1" });
	const transport = new StreamableHTTPClientTransport(
		new URL(gateway.server.url),
		{
			requestInit: {
				headers: Object.fromEntries(
					gateway.server.headers.map((header) => [header.name, header.value]),
				),
			},
		},
	);
	await client.connect(transport);
	const tools = await client.listTools();
	expect(tools.tools.map((tool) => tool.name)).toEqual([
		"browser_navigate",
		"browser_observe",
	]);
	const result = await client.callTool({
		name: "browser_navigate",
		arguments: { url: "https://example.test/" },
	});
	expect(result).toMatchObject({
		isError: false,
		content: [{ type: "text", text: "navigated" }],
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({
		tool: "browser_navigate",
		binding: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId,
			capabilityVersion: 1,
		},
	});
	await client.close();
});

it("rejects requests without the per-gateway bearer", async () => {
	const gateway = await createBrowserMcpGatewayV1({
		capability,
		executionId: randomUUID(),
		context: {
			capabilityVersion: 1,
			binding: {
				agentId: "agent-1",
				conversationId: "conversation-1",
				sessionGeneration: 1,
				resourceFence: 2,
				workloadRevision: 3,
				imageDigest: `registry.example/browser@sha256:${"d".repeat(64)}`,
			},
			executeTool: async () => {
				throw new Error("must not execute");
			},
		},
	});
	gateways.push(gateway);
	const response = await fetch(gateway.server.url, {
		method: "POST",
		body: "{}",
	});
	expect(response.status).toBe(401);
});
