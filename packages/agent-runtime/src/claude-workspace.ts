import type {
	HookCallbackMatcher,
	HookInput,
	Options,
} from "@anthropic-ai/claude-agent-sdk";
import { workspacePathAllowed } from "./workspace-path.js";

export type ClaudeToolRequestObserver = (request: {
	name: string;
	toolUseID: string;
	permitted: boolean;
}) => Promise<void>;

export type ClaudeToolExecutionObserver = (request: {
	name: string;
	toolUseID: string;
}) => Promise<void>;

/** Fixed core tools; Bash, subagents, MCP, network tools and arbitrary file roots remain unavailable. */
export function claudeWorkspaceTools(
	workspace: string,
	memory: string,
	observer?: ClaudeToolRequestObserver,
	executionObserver?: ClaudeToolExecutionObserver,
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
							if (input.hook_event_name !== "PreToolUse") return {};
							const permitted = await permits(
								input.tool_name,
								input.tool_input,
							);
							try {
								await observer?.({
									name: input.tool_name,
									toolUseID: input.tool_use_id,
									permitted,
								});
							} catch {
								return {
									hookSpecificOutput: {
										hookEventName: "PreToolUse" as const,
										permissionDecision: "deny" as const,
										permissionDecisionReason:
											"Conversation workspace policy unavailable",
									},
								};
							}
							if (permitted) return {};
							return {
								hookSpecificOutput: {
									hookEventName: "PreToolUse" as const,
									permissionDecision: "deny" as const,
									permissionDecisionReason: "Conversation workspace policy",
								},
							};
						},
					],
				},
			],
			PostToolUse: [executionHook(executionObserver, "PostToolUse")],
			PostToolUseFailure: [
				executionHook(executionObserver, "PostToolUseFailure"),
			],
		},
	};
}

function executionHook(
	executionObserver: ClaudeToolExecutionObserver | undefined,
	hookEventName: "PostToolUse" | "PostToolUseFailure",
): HookCallbackMatcher {
	return {
		hooks: [
			async (input: HookInput) => {
				if (input.hook_event_name === hookEventName)
					if ("tool_name" in input && "tool_use_id" in input)
						try {
							await executionObserver?.({
								name: input.tool_name,
								toolUseID: input.tool_use_id,
							});
						} catch {
							// The tool has already run; its result remains authoritative.
						}
				return {};
			},
		],
	};
}
