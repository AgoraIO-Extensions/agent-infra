import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { workspacePathAllowed } from "./workspace-path.js";

/** Fixed core tools; Bash, subagents, MCP, network tools and arbitrary file roots remain unavailable. */
export function claudeWorkspaceTools(
	workspace: string,
	memory: string,
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
						async (input) => ({
							hookSpecificOutput: {
								hookEventName: "PreToolUse",
								permissionDecision:
									input.hook_event_name === "PreToolUse" &&
									(await permits(input.tool_name, input.tool_input))
										? "allow"
										: "deny",
								permissionDecisionReason: "Conversation workspace policy",
							},
						}),
					],
				},
			],
		},
	};
}
