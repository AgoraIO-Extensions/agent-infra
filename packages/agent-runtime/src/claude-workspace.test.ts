import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeWorkspaceTools } from "./claude-workspace.js";

describe("Claude workspace result hook", () => {
	it("records Write and Edit only as tool facts and publishes no result file (#3226)", async () => {
		const onStarted = vi.fn(async () => {});
		const onCompleted = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(
			"/private/runtime/workspace",
			"/private/runtime/memory",
			{ onStarted, onCompleted },
		);
		const matcher = tools.hooks?.PostToolUse?.[0];
		if (!matcher) throw new Error("missing PostToolUse matcher");
		const hook = matcher.hooks[0];
		if (!hook) throw new Error("missing PostToolUse hook");
		for (const [toolUseId, toolName, response] of [
			[
				"tool-1",
				"Write",
				{
					type: "create",
					filePath: "/private/runtime/workspace/out.txt",
					content: "result",
				},
			],
			[
				"tool-3",
				"Edit",
				{
					filePath: "/private/runtime/workspace/out.txt",
					oldString: "old",
					newString: "new",
					structuredPatch: [],
				},
			],
		] as const)
			await expect(
				hook(
					{
						hook_event_name: "PostToolUse",
						tool_name: toolName,
						tool_input: { file_path: "/private/runtime/workspace/out.txt" },
						tool_response: response,
						tool_use_id: toolUseId,
					} as never,
					toolUseId,
					{ signal: new AbortController().signal },
				),
			).resolves.toEqual({});
		expect(onStarted.mock.calls).toEqual([
			["tool-1", "Write"],
			["tool-3", "Edit"],
		]);
		expect(onCompleted.mock.calls).toEqual(onStarted.mock.calls);
		// 没有工具事实回调时不再注册 PostToolUse：写入工具不会触发任何结果文件路径。
		expect(
			claudeWorkspaceTools(
				"/private/runtime/workspace",
				"/private/runtime/memory",
			).hooks?.PostToolUse,
		).toBeUndefined();
	});

	it("records local tools only after the native completion hook without an intent barrier", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "claude-workspace-hook-")),
		);
		const workspace = join(root, "workspace");
		const memory = join(root, "memory");
		await mkdir(workspace);
		await mkdir(memory);
		const onStarted = vi.fn(async () => {});
		const onCompleted = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(workspace, memory, {
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
		expect(onStarted).not.toHaveBeenCalled();
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
		const tools = claudeWorkspaceTools(workspace, memory, {
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

	it("settles failed native tool execution through the failure hook", async () => {
		const onStarted = vi.fn(async () => {});
		const onFailed = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(
			"/private/runtime/workspace",
			"/private/runtime/memory",
			{ onStarted, onFailed },
		);
		const failure = tools.hooks?.PostToolUseFailure?.[0]?.hooks[0];
		if (!failure) throw new Error("missing PostToolUseFailure hook");
		await failure(
			{
				hook_event_name: "PostToolUseFailure",
				tool_name: "Read",
				tool_input: { file_path: "/private/runtime/workspace/out.txt" },
				tool_use_id: "tool-failed",
				error: "read failed",
				duration_ms: 12,
			} as never,
			"tool-failed",
			{ signal: new AbortController().signal },
		);
		expect(onStarted).toHaveBeenCalledWith("tool-failed", "Read");
		expect(onFailed).toHaveBeenCalledWith("tool-failed", "Read", 12);
	});
});

it("allows Read from the deployment-owned Skill root but never Write/Edit", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "claude-skill-root-")),
	);
	const workspace = join(root, "workspace");
	const memory = join(root, "memory");
	const skillRoot = join(root, "skills");
	await mkdir(workspace);
	await mkdir(memory);
	await mkdir(skillRoot);
	const skillFile = join(skillRoot, "SKILL.md");
	await writeFile(skillFile, "skill", "utf8");
	try {
		const tools = claudeWorkspaceTools(workspace, memory, undefined, [
			skillRoot,
		]);
		const before = tools.hooks?.PreToolUse?.[0]?.hooks[0];
		if (!before) throw new Error("missing PreToolUse hook");
		await expect(
			before(
				{
					hook_event_name: "PreToolUse",
					tool_name: "Read",
					tool_input: { file_path: skillFile },
					tool_use_id: "skill-read",
				} as never,
				"skill-read",
				{ signal: new AbortController().signal },
			),
		).resolves.toMatchObject({
			hookSpecificOutput: { permissionDecision: "allow" },
		});
		await expect(
			before(
				{
					hook_event_name: "PreToolUse",
					tool_name: "Write",
					tool_input: { file_path: skillFile },
					tool_use_id: "skill-write",
				} as never,
				"skill-write",
				{ signal: new AbortController().signal },
			),
		).resolves.toMatchObject({
			hookSpecificOutput: { permissionDecision: "deny" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("routes Applied Skill reads through a verified ephemeral file", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "claude-verified-skill-")),
	);
	const workspace = join(root, "workspace");
	const memory = join(root, "memory");
	const skillRoot = join(root, "skills");
	const verified = join(root, "verified", "SKILL.md");
	await mkdir(workspace);
	await mkdir(memory);
	await mkdir(join(root, "verified"), { recursive: true });
	await mkdir(skillRoot);
	const skillFile = join(skillRoot, "workspace-summary", "SKILL.md");
	await mkdir(join(skillRoot, "workspace-summary"));
	await writeFile(skillFile, "tamperable", "utf8");
	try {
		let verifiedReads = 0;
		const cleanupReadOnlyFile = vi.fn(async () => {});
		const tools = claudeWorkspaceTools(
			workspace,
			memory,
			{
				resolveReadOnlyFile: async (filePath) =>
					filePath === skillFile && verifiedReads++ === 0
						? verified
						: undefined,
				cleanupReadOnlyFile,
			},
			[skillRoot],
		);
		const signal = new AbortController().signal;
		const canUse = await tools.canUseTool?.(
			"Read",
			{ file_path: skillFile },
			{ signal, toolUseID: "read", requestId: "request" },
		);
		expect(canUse).toMatchObject({
			behavior: "allow",
			updatedInput: { file_path: verified },
		});
		const before = tools.hooks?.PreToolUse?.[0]?.hooks[0];
		if (!before) throw new Error("missing PreToolUse hook");
		await expect(
			before(
				{
					hook_event_name: "PreToolUse",
					tool_name: "Read",
					tool_input: { file_path: verified },
					tool_use_id: "read",
				} as never,
				"read",
				{ signal },
			),
		).resolves.toMatchObject({
			hookSpecificOutput: {
				permissionDecision: "allow",
				updatedInput: { file_path: verified },
			},
		});
		const after = tools.hooks?.PostToolUse?.[0]?.hooks[0];
		if (!after) throw new Error("missing PostToolUse hook");
		await after(
			{
				hook_event_name: "PostToolUse",
				tool_name: "Read",
				tool_input: { file_path: verified },
				tool_response: { type: "text", content: "skill" },
				tool_use_id: "read",
			} as never,
			"read",
			{ signal },
		);
		expect(cleanupReadOnlyFile).toHaveBeenCalledWith(verified);
		const external = await tools.canUseTool?.(
			"Read",
			{ file_path: join(skillRoot, "workspace-summary", "external.txt") },
			{ signal, toolUseID: "external", requestId: "request" },
		);
		expect(external).toMatchObject({ behavior: "deny" });
		const stale = await tools.canUseTool?.(
			"Read",
			{ file_path: skillFile },
			{ signal, toolUseID: "stale", requestId: "request" },
		);
		expect(stale).toMatchObject({ behavior: "deny" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// #3217：列举与搜索类原生工具只在本 Conversation 的目录内可用，shell 与网络工具仍关闭。
describe("Claude workspace list and search tools", () => {
	async function fixture() {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "claude-workspace-search-")),
		);
		const workspace = join(root, "workspace");
		const memory = join(root, "memory");
		const skillRoot = join(root, "skills");
		const outside = join(root, "outside");
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(memory);
		await mkdir(skillRoot);
		await mkdir(outside);
		await symlink(outside, join(workspace, "escape"));
		const tools = claudeWorkspaceTools(workspace, memory, undefined, [
			skillRoot,
		]);
		const decide = async (name: string, input: Record<string, unknown>) =>
			(
				await tools.canUseTool?.(name, input, {
					signal: new AbortController().signal,
					toolUseID: `${name}-use`,
					requestId: "request",
				})
			)?.behavior;
		return { root, workspace, memory, skillRoot, outside, tools, decide };
	}

	it("declares list and search tools but not shell, network or sub-agent tools", async () => {
		const f = await fixture();
		try {
			expect(f.tools.tools).toEqual(
				expect.arrayContaining(["Glob", "Grep", "TodoWrite"]),
			);
			for (const name of ["Bash", "WebFetch", "WebSearch", "Agent", "Task"]) {
				expect(f.tools.tools).not.toContain(name);
				expect(await f.decide(name, { command: "ls" })).toBe("deny");
			}
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});

	it("allows Glob and Grep inside the Conversation directories", async () => {
		const f = await fixture();
		try {
			for (const [name, input] of [
				["Glob", { pattern: "**/*.ts" }],
				["Glob", { pattern: "*.md", path: join(f.workspace, "src") }],
				["Glob", { pattern: "*", path: f.memory }],
				["Grep", { pattern: "TODO", path: f.workspace, glob: "**/*.ts" }],
				["Grep", { pattern: "name:", path: f.skillRoot }],
				["TodoWrite", { todos: [] }],
			] as const)
				expect(await f.decide(name, input)).toBe("allow");
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});

	it("denies list and search outside the Conversation directories", async () => {
		const f = await fixture();
		try {
			for (const [name, input] of [
				["Glob", { pattern: "*", path: f.outside }],
				["Glob", { pattern: "*", path: f.root }],
				["Glob", { pattern: "*", path: join(f.workspace, "..") }],
				["Glob", { pattern: "*", path: join(f.workspace, "escape") }],
				["Glob", { pattern: `${f.outside}/*` }],
				["Glob", { pattern: "../outside/*" }],
				["Glob", { pattern: "src/../../outside/*" }],
				["Grep", { pattern: "x", path: f.outside }],
				["Grep", { pattern: "x", glob: "../**" }],
				["Grep", { pattern: "x", glob: "/etc/*" }],
				["Grep", { pattern: "x", path: "/proc" }],
				["Glob", { pattern: "*", path: "relative\0" }],
			] as const)
				expect(await f.decide(name, input)).toBe("deny");
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
});

it("revalidates the fixed shell boundary for every Bash permission and preserves file policy", async () => {
	const authorizeShell = vi
		.fn()
		.mockResolvedValueOnce(true)
		.mockResolvedValue(false);
	const tools = claudeWorkspaceTools("/private/workspace", "/private/memory", {
		authorizeShell,
	});
	const options = {
		signal: new AbortController().signal,
		toolUseID: "shell",
		requestId: "request",
	};
	expect(tools.tools).toContain("Bash");
	expect(
		await tools.canUseTool?.("Bash", { command: "true" }, options),
	).toMatchObject({ behavior: "allow" });
	expect(
		await tools.canUseTool?.("Bash", { command: "true" }, options),
	).toMatchObject({ behavior: "deny" });
	expect(
		await tools.canUseTool?.(
			"Read",
			{ file_path: "/private/host-secret" },
			options,
		),
	).toMatchObject({ behavior: "deny" });
	expect(authorizeShell).toHaveBeenCalledTimes(2);
});

it("does not let an obsolete throwing intent callback become a Bash execution barrier", async () => {
	const onIntent = vi.fn(async () => {
		throw new Error("SYNTHETIC_INTENT_WRITE_FAILED");
	});
	const callbacks = {
		authorizeShell: async () => true,
		authorize: async () => true,
		onIntent,
	};
	const tools = claudeWorkspaceTools(
		"/session/workspace",
		"/session/memory",
		callbacks,
	);
	const before = tools.hooks?.PreToolUse?.[0]?.hooks[0];
	if (!before) throw Error();
	await expect(
		before(
			{
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "shell",
				tool_input: { command: "true" },
			} as never,
			"shell",
			{ signal: new AbortController().signal },
		),
	).resolves.toMatchObject({
		hookSpecificOutput: { permissionDecision: "allow" },
	});
	expect(onIntent).not.toHaveBeenCalled();
});
