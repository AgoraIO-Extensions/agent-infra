import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { workspacePathAllowed } from "./workspace-path.js";

export type ClaudeFileWriteOutput = Readonly<{
	filePath: string;
	content?: string;
	structuredPatch?: readonly unknown[];
}>;

export type ClaudeToolOperationCallbacks = Readonly<{
	onStarted?: (toolUseId: string, toolName: string) => Promise<void>;
	onCompleted?: (toolUseId: string, toolName: string) => Promise<void>;
}>;

/** Fixed core tools; Bash, subagents, MCP, network tools and arbitrary file roots remain unavailable. */
export function claudeWorkspaceTools(
	workspace: string,
	memory: string,
	onResultFile?: (output: ClaudeFileWriteOutput) => Promise<void>,
	onToolOperation?: ClaudeToolOperationCallbacks,
): Pick<Options, "tools" | "hooks" | "canUseTool" | "settings"> {
	const permits = async (name: string, input: unknown) => {
		if (
			!["Read", "Write", "Edit"].includes(name) ||
			!input ||
			typeof input !== "object" ||
			!("file_path" in input) ||
			typeof input.file_path !== "string" ||
			input.file_path.includes("\0")
		)
			return false;
		return workspacePathAllowed(workspace, memory, input.file_path);
	};
	return {
		tools: ["Read", "Write", "Edit"],
		settings: {
			autoMemoryEnabled: true,
			autoMemoryDirectory: memory,
			autoDreamEnabled: false,
			claudeMdExcludes: ["**"],
		},
		canUseTool: async (name, input) =>
			(await permits(name, input))
				? { behavior: "allow", updatedInput: input }
				: { behavior: "deny", message: "Tool access is unavailable" },
		hooks: {
			PreToolUse: [
				{
					hooks: [
						async (input) => {
							if (onToolOperation && input.hook_event_name === "PreToolUse")
								await onToolOperation.onStarted?.(
									typeof input.tool_use_id === "string"
										? input.tool_use_id
										: "unknown-tool-use",
									input.tool_name,
								);
							return {
								hookSpecificOutput: {
									hookEventName: "PreToolUse",
									permissionDecision:
										input.hook_event_name === "PreToolUse" &&
										(await permits(input.tool_name, input.tool_input))
											? "allow"
											: "deny",
									permissionDecisionReason: "Conversation workspace policy",
								},
							};
						},
					],
				},
			],
			...(onResultFile || onToolOperation
				? {
						PostToolUse: [
							{
								hooks: [
									async (input) => {
										if (
											onToolOperation &&
											input.hook_event_name === "PostToolUse"
										)
											await onToolOperation.onCompleted?.(
												typeof input.tool_use_id === "string"
													? input.tool_use_id
													: "unknown-tool-use",
												input.tool_name,
											);
										if (
											onResultFile &&
											input.hook_event_name === "PostToolUse" &&
											["Write", "Edit"].includes(input.tool_name) &&
											input.tool_response &&
											typeof input.tool_response === "object" &&
											(input.tool_response as { filePath?: unknown })
												.filePath &&
											(typeof (input.tool_response as { content?: unknown })
												.content === "string" ||
												Array.isArray(
													(input.tool_response as { structuredPatch?: unknown })
														.structuredPatch,
												))
										) {
											await onResultFile(
												input.tool_response as ClaudeFileWriteOutput,
											);
										}
										return {};
									},
								],
							},
						],
					}
				: {}),
		},
	};
}
