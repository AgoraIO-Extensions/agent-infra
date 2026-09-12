import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

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
		const path = resolve(workspace, input.file_path);
		const root = [workspace, memory].find((root) => {
			const within = relative(root, path);
			return (
				within &&
				within !== ".." &&
				!within.startsWith(`..${sep}`) &&
				!isAbsolute(within)
			);
		});
		if (!root) return false;
		try {
			if ((await realpath(root)) !== root) return false;
			let candidate = path;
			while (candidate !== root) {
				try {
					const stat = await lstat(candidate);
					if (
						stat.isSymbolicLink() ||
						(candidate === path && !stat.isFile()) ||
						(candidate !== path && !stat.isDirectory())
					)
						return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
				}
				candidate = dirname(candidate);
			}
			return true;
		} catch {
			return false;
		}
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
