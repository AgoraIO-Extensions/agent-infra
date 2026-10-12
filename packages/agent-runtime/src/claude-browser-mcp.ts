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
const maxContentItems = 64;

type BrowserToolInput = Readonly<Record<string, unknown>>;

function boundedContentItems(
	items: RuntimeBrowserToolExecutionResultV1["contentItems"],
) {
	const content: { type: "text"; text: string }[] = [];
	let remainingBytes = maxContentBytes;
	for (const item of items) {
		if (remainingBytes === 0 || content.length >= maxContentItems) break;
		if (item.type !== "inputText") continue;
		let text = "";
		for (const character of item.text) {
			const bytes = Buffer.byteLength(character, "utf8");
			if (bytes > remainingBytes) {
				remainingBytes = 0;
				break;
			}
			text += character;
			remainingBytes -= bytes;
		}
		if (text.length > 0) content.push({ type: "text", text });
	}
	return content;
}

function mergeAbortSignals(
	left: AbortSignal,
	right: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const signals = right ? [left, right] : [left];
	if (signals.some((signal) => signal.aborted)) controller.abort();
	else for (const signal of signals) signal.addEventListener("abort", abort);
	return {
		signal: controller.signal,
		dispose: () => {
			for (const signal of signals) signal.removeEventListener("abort", abort);
		},
	};
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
	const content = boundedContentItems(result.contentItems);
	if (completed)
		return {
			content,
			isError: false,
		};
	return {
		content: [
			{
				type: "text" as const,
				text:
					result.phase === "unknown"
						? "BROWSER_EXECUTION_UNKNOWN"
						: "BROWSER_EXECUTION_FAILED",
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
			async (arguments_, extra) => {
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
				const requestSignal =
					extra &&
					typeof extra === "object" &&
					"signal" in extra &&
					extra.signal instanceof AbortSignal
						? extra.signal
						: undefined;
				const merged = mergeAbortSignals(options.signal, requestSignal);
				try {
					merged.signal.throwIfAborted();
					const result = await executeTool(request, merged.signal);
					if (!result) throw new Error("BROWSER_EXECUTION_UNAVAILABLE");
					merged.signal.throwIfAborted();
					return resultToCallToolResult(result, request);
				} catch {
					return {
						content: [
							{
								type: "text" as const,
								text: merged.signal.aborted
									? "BROWSER_EXECUTION_CANCELLED"
									: "BROWSER_EXECUTION_FAILED",
							},
						],
						isError: true,
					};
				} finally {
					merged.dispose();
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
