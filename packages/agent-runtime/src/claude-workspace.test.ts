import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		await hook(
			{
				hook_event_name: "PostToolUse",
				tool_name: "Write",
				tool_input: { file_path: "/private/runtime/workspace/out.txt" },
				tool_response: {
					type: "create",
					filePath: "/private/runtime/workspace/out.txt",
					content: "result",
				},
				tool_use_id: "tool-1",
			} as never,
			"tool-1",
			{ signal: new AbortController().signal },
		);
		await hook(
			{
				hook_event_name: "PostToolUse",
				tool_name: "Read",
				tool_input: { file_path: "/private/runtime/workspace/out.txt" },
				tool_response: { type: "text", content: "result" },
				tool_use_id: "tool-2",
			} as never,
			"tool-2",
			{ signal: new AbortController().signal },
		);
		await hook(
			{
				hook_event_name: "PostToolUse",
				tool_name: "Edit",
				tool_input: { file_path: "/private/runtime/workspace/out.txt" },
				tool_response: {
					filePath: "/private/runtime/workspace/out.txt",
					oldString: "old",
					newString: "new",
					structuredPatch: [],
				},
				tool_use_id: "tool-3",
			} as never,
			"tool-3",
			{ signal: new AbortController().signal },
		);
		expect(onResultFile).toHaveBeenCalledTimes(2);
		expect(onResultFile).toHaveBeenNthCalledWith(1, {
			type: "create",
			filePath: "/private/runtime/workspace/out.txt",
			content: "result",
		});
		expect(onResultFile).toHaveBeenNthCalledWith(2, {
			filePath: "/private/runtime/workspace/out.txt",
			oldString: "old",
			newString: "new",
			structuredPatch: [],
		});
	});

	it("reports the native tool dispatch boundary without forwarding tool input", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "claude-workspace-hook-")),
		);
		const workspace = join(root, "workspace");
		const memory = join(root, "memory");
		await mkdir(workspace);
		await mkdir(memory);
		const onStarted = vi.fn(async () => {});
		const onCompleted = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(workspace, memory, undefined, {
			onStarted,
			onCompleted,
		});
		const before = tools.hooks?.PreToolUse?.[0]?.hooks[0];
		const after = tools.hooks?.PostToolUse?.[0]?.hooks[0];
		if (!before || !after) throw new Error("missing tool operation hooks");
		const beforeResult = await before(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: join(workspace, "out.txt") },
				tool_use_id: "tool-1",
			} as never,
			"tool-1",
			{ signal: new AbortController().signal },
		);
		expect(beforeResult).toMatchObject({
			hookSpecificOutput: { permissionDecision: "allow" },
		});
		await after(
			{
				hook_event_name: "PostToolUse",
				tool_name: "Read",
				tool_input: { file_path: join(workspace, "out.txt") },
				tool_response: { type: "text", content: "secret" },
				tool_use_id: "tool-1",
			} as never,
			"tool-1",
			{ signal: new AbortController().signal },
		);
		expect(onStarted).toHaveBeenCalledWith("tool-1", "Read");
		expect(onCompleted).toHaveBeenCalledWith("tool-1", "Read");
		expect(JSON.stringify(onStarted.mock.calls)).not.toContain("secret");
		await rm(root, { recursive: true, force: true });
	});

	it("does not start a fact for a denied tool request", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "claude-workspace-denied-")),
		);
		const workspace = join(root, "workspace");
		const memory = join(root, "memory");
		await mkdir(workspace);
		await mkdir(memory);
		const onStarted = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(workspace, memory, undefined, {
			onStarted,
		});
		const before = tools.hooks?.PreToolUse?.[0]?.hooks[0];
		if (!before) throw new Error("missing PreToolUse hook");
		await before(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: join(root, "other", "out.txt") },
				tool_use_id: "tool-denied",
			} as never,
			"tool-denied",
			{ signal: new AbortController().signal },
		);
		expect(onStarted).not.toHaveBeenCalled();
		await rm(root, { recursive: true, force: true });
	});
});
