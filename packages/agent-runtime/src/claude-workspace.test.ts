import { describe, expect, it, vi } from "vitest";
import { claudeWorkspaceTools } from "./claude-workspace.js";

describe("Claude workspace result hook", () => {
	it("forwards structured Write output and ignores other tools", async () => {
		const onResultFile = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(
			"/private/runtime/workspace",
			"/private/runtime/memory",
			onResultFile,
		);
		const matcher = tools.hooks?.PostToolUse?.[0];
		if (!matcher) throw new Error("missing PostToolUse matcher");
		const hook = matcher.hooks[0];
		if (!hook) throw new Error("missing PostToolUse hook");
		await hook({
			hook_event_name: "PostToolUse",
			tool_name: "Write",
			tool_input: { file_path: "/private/runtime/workspace/out.txt" },
			tool_response: {
				type: "create",
				filePath: "/private/runtime/workspace/out.txt",
				content: "result",
			},
			tool_use_id: "tool-1",
		} as never, "tool-1", { signal: new AbortController().signal });
		await hook({
			hook_event_name: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "/private/runtime/workspace/out.txt" },
			tool_response: { type: "text", content: "result" },
			tool_use_id: "tool-2",
		} as never, "tool-2", { signal: new AbortController().signal });
		expect(onResultFile).toHaveBeenCalledOnce();
		expect(onResultFile).toHaveBeenCalledWith({
			type: "create",
			filePath: "/private/runtime/workspace/out.txt",
			content: "result",
		});
	});
});
