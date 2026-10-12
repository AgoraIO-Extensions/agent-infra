import { randomUUID } from "node:crypto";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import {
	createSdkMcpServer,
	type McpSdkServerConfigWithInstance,
	tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { type ZodTypeAny, z } from "zod";
import { toZod } from "./claude-standard-mcp.js";
import {
	type CodexBrowserToolDescriptorV1,
	createCodexBrowserToolDescriptorsV1,
} from "./codex-browser-tools.js";
import type {
	RuntimeBrowserExecutionContextV1,
	RuntimeBrowserToolExecutionRequestV1,
	RuntimeBrowserToolExecutionResultV1,
} from "./driver.js";

const maxContentBytes = 16_384;

type BrowserToolInput = Readonly<Record<string, unknown>>;

function boundedText(value: unknown): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length <= maxContentBytes
		? text
		: `${text.slice(0, maxContentBytes - 1)}…`;
}

function pageRevision(
	descriptor: CodexBrowserToolDescriptorV1,
	input: BrowserToolInput,
): number {
	if (descriptor.operation === "navigate" || descriptor.operation === "handoff")
		return 1;
	const revision = input.pageRevision;
	if (!Number.isSafeInteger(revision) || (revision as number) < 1)
		throw new Error("BROWSER_PAGE_REFERENCE_INVALID");
	return revision as number;
}

function resultToCallToolResult(
	result: RuntimeBrowserToolExecutionResultV1,
	request: RuntimeBrowserToolExecutionRequestV1,
) {
	const identityMatches =
		result.actionId === request.actionId &&
		result.operationRef === request.operationRef &&
		result.attemptRef === request.attemptRef &&
		result.binding.agentId === request.binding.agentId &&
		result.binding.conversationId === request.binding.conversationId &&
		result.binding.executionId === request.binding.executionId &&
		result.binding.sessionGeneration === request.binding.sessionGeneration &&
		result.binding.resourceFence === request.binding.resourceFence &&
		result.binding.capabilityVersion === request.binding.capabilityVersion &&
		result.binding.pageRevision === request.binding.pageRevision;
	if (!identityMatches)
		return {
			content: [
				{ type: "text" as const, text: "BROWSER_RESULT_IDENTITY_MISMATCH" },
			],
			isError: true,
		};
	const completed = result.phase === "completed" && result.success;
	const content = result.contentItems
		.filter((item) => item.type === "inputText")
		.map((item) => ({ type: "text" as const, text: boundedText(item.text) }));
	if (completed)
		return {
			content,
			isError: false,
		};
	return {
		content:
			content.length > 0
				? content
				: [
						{
							type: "text" as const,
							text: boundedText(result.failureCode ?? result.phase),
						},
					],
		isError: true,
	};
}

/**
 * Build the in-process Claude MCP server from an already verified Browser
 * capability. The server carries only request-local execution authority; all
 * Browser state and action semantics remain in the supplied context.
 */
export function createClaudeBrowserMcpServer(options: {
	readonly capability: BrowserCapabilityAvailableV1 | undefined;
	readonly context: RuntimeBrowserExecutionContextV1 | undefined;
	readonly executionId: string;
	readonly signal: AbortSignal;
}): McpSdkServerConfigWithInstance | undefined {
	const context = options.context;
	if (
		options.capability?.status !== "available" ||
		!context ||
		context.capabilityVersion !== options.capability.capabilityVersion ||
		typeof context.executeTool !== "function"
	)
		return undefined;
	const executeTool = context.executeTool;
	if (typeof executeTool !== "function") return undefined;
	const descriptors = createCodexBrowserToolDescriptorsV1(options.capability);
	if (descriptors.length === 0) return undefined;
	const tools = descriptors.map((descriptor) => {
		const parsed = toZod(descriptor.inputSchema);
		if (!(parsed instanceof z.ZodObject))
			throw new Error("BROWSER_TOOL_SCHEMA_INVALID");
		return sdkTool(
			descriptor.name,
			descriptor.description,
			parsed as unknown as Record<string, ZodTypeAny>,
			async (arguments_) => {
				const input = arguments_ as BrowserToolInput;
				const request: RuntimeBrowserToolExecutionRequestV1 = {
					tool: descriptor.name,
					arguments: input,
					actionId: randomUUID(),
					operationRef: randomUUID(),
					attemptRef: randomUUID(),
					binding: {
						agentId: context.binding.agentId,
						conversationId: context.binding.conversationId,
						executionId: options.executionId,
						sessionGeneration: context.binding.sessionGeneration,
						resourceFence: context.binding.resourceFence,
						capabilityVersion: context.capabilityVersion,
						pageRevision: pageRevision(descriptor, input),
					},
				};
				try {
					options.signal.throwIfAborted();
					const result = await executeTool(request, options.signal);
					if (!result) throw new Error("BROWSER_EXECUTION_UNAVAILABLE");
					options.signal.throwIfAborted();
					return resultToCallToolResult(result, request);
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: boundedText(
									error instanceof Error
										? error.message
										: "BROWSER_EXECUTION_FAILED",
								),
							},
						],
						isError: true,
					};
				}
			},
			{ alwaysLoad: true },
		);
	});
	return createSdkMcpServer({
		name: "agent-infra-browser",
		version: "1",
		tools,
		alwaysLoad: true,
	});
}
