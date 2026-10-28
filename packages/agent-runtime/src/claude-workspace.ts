import { resolve } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
	workspaceDirectoryAllowed,
	workspaceGlobAllowed,
	workspacePathAllowed,
} from "./workspace-path.js";

export type ClaudeToolOperationCallbacks = Readonly<{
	onIntent?: (toolUseId: string, toolName: string) => Promise<void>;
	onStarted?: (toolUseId: string, toolName: string) => Promise<void>;
	onCompleted?: (toolUseId: string, toolName: string) => Promise<void>;
	onFailed?: (
		toolUseId: string,
		toolName: string,
		durationMs?: number,
	) => Promise<void>;
	authorize?: () => Promise<boolean>;
	authorizeShell?: () => Promise<boolean>;
	resolveReadOnlyFile?: (
		filePath: string,
		signal: AbortSignal,
	) => Promise<string | undefined>;
	cleanupReadOnlyFile?: (filePath: string) => Promise<void>;
}>;

/** #3217：Claude 标准模板开放的原生工具，Driver 的流式事件与恢复按同一清单识别。 */
export const claudeWorkspaceToolNames: readonly string[] = Object.freeze([
	"Read",
	"Write",
	"Edit",
	"Glob",
	"Grep",
	"TodoWrite",
	"Bash",
]);

/**
 * Fixed core tools. 文件读写、列举与搜索只在本 Conversation 的工作区、memory 与只读 Skill
 * 根内可用（#3217）；Bash 仅在固定子进程边界准入后开放，且每次调用重新准入（#3218）。
 * 子 Agent、网络工具和任意文件根仍不开放。Write/Edit 不隐式发布结果文件。
 */
export function claudeWorkspaceTools(
	workspace: string,
	memory: string,
	onToolOperation?: ClaudeToolOperationCallbacks,
	readOnlyRoots: readonly string[] = [],
): Pick<Options, "tools" | "hooks" | "canUseTool" | "settings"> {
	const approvedReadOnlyPaths = new Map<string, string>();
	const cleanupReadOnlyPaths = new Map<string, string>();
	const cleanupToolReadOnlyFile = async (toolUseId: unknown) => {
		if (typeof toolUseId !== "string") return;
		const filePath = cleanupReadOnlyPaths.get(toolUseId);
		cleanupReadOnlyPaths.delete(toolUseId);
		if (filePath) approvedReadOnlyPaths.delete(filePath);
		for (const [approvedPath, approvedToolUseId] of approvedReadOnlyPaths) {
			if (approvedToolUseId === toolUseId)
				approvedReadOnlyPaths.delete(approvedPath);
		}
		if (filePath) await onToolOperation?.cleanupReadOnlyFile?.(filePath);
	};
	const resolveInput = async (
		name: string,
		input: unknown,
		signal: AbortSignal,
		toolUseId?: string,
	): Promise<Record<string, unknown> | undefined> => {
		if (!input || typeof input !== "object" || Array.isArray(input))
			return undefined;
		const record = input as Record<string, unknown>;
		if (name === "TodoWrite") return record;
		if (name === "Bash") {
			if (
				typeof record.command !== "string" ||
				record.command.includes("\0") ||
				!(await onToolOperation?.authorizeShell?.())
			)
				return undefined;
			return record;
		}
		if (name === "Glob" || name === "Grep") {
			// 未给出 path 时，原生工具在 cwd（本 Conversation 工作区）内搜索。
			if (
				record.path !== undefined &&
				(typeof record.path !== "string" ||
					!(await workspaceDirectoryAllowed(
						[workspace, memory, ...readOnlyRoots],
						resolve(workspace, record.path),
					)))
			)
				return undefined;
			if (
				typeof record.pattern !== "string" ||
				record.pattern.includes("\0") ||
				(name === "Glob" && !workspaceGlobAllowed(record.pattern)) ||
				(name === "Grep" &&
					record.glob !== undefined &&
					(typeof record.glob !== "string" ||
						!workspaceGlobAllowed(record.glob)))
			)
				return undefined;
			return record;
		}
		if (
			!["Read", "Write", "Edit"].includes(name) ||
			!input ||
			typeof input !== "object" ||
			!("file_path" in input) ||
			typeof input.file_path !== "string" ||
			input.file_path.includes("\0")
		)
			return undefined;
		const filePath = input.file_path;
		if (
			name === "Read" &&
			toolUseId !== undefined &&
			approvedReadOnlyPaths.get(filePath) === toolUseId
		) {
			approvedReadOnlyPaths.delete(filePath);
			return input as Record<string, unknown>;
		}
		if (await workspacePathAllowed(workspace, memory, filePath))
			return input as Record<string, unknown>;
		if (name === "Read" && onToolOperation?.resolveReadOnlyFile) {
			const resolved = await onToolOperation.resolveReadOnlyFile(
				filePath,
				signal,
			);
			if (!resolved) return undefined;
			if (toolUseId !== undefined) {
				approvedReadOnlyPaths.set(resolved, toolUseId);
				cleanupReadOnlyPaths.set(toolUseId, resolved);
			}
			return { ...(input as Record<string, unknown>), file_path: resolved };
		}
		if (
			name === "Read" &&
			(
				await Promise.all(
					readOnlyRoots.map((root) =>
						workspacePathAllowed(root, root, filePath),
					),
				)
			).some(Boolean)
		)
			return input as Record<string, unknown>;
		return undefined;
	};
	return {
		tools: claudeWorkspaceToolNames.filter(
			(name) =>
				name !== "Bash" || onToolOperation?.authorizeShell !== undefined,
		),
		settings: {
			autoMemoryEnabled: true,
			autoMemoryDirectory: memory,
			autoDreamEnabled: false,
			claudeMdExcludes: ["**"],
		},
		canUseTool: async (name, input, options) => {
			const updatedInput = await resolveInput(
				name,
				input,
				options.signal,
				options.toolUseID,
			);
			const authorized =
				updatedInput !== undefined &&
				(!onToolOperation?.authorize || (await onToolOperation.authorize()));
			if (!authorized) await cleanupToolReadOnlyFile(options.toolUseID);
			return authorized
				? { behavior: "allow", updatedInput }
				: { behavior: "deny", message: "Tool access is unavailable" };
		},
		hooks: {
			PreToolUse: [
				{
					hooks: [
						async (input) => {
							const toolUseId =
								"tool_use_id" in input && typeof input.tool_use_id === "string"
									? input.tool_use_id
									: undefined;
							const updatedInput =
								input.hook_event_name === "PreToolUse"
									? await resolveInput(
											input.tool_name,
											input.tool_input,
											new AbortController().signal,
											toolUseId,
										)
									: undefined;
							const allowed =
								input.hook_event_name === "PreToolUse" &&
								updatedInput !== undefined &&
								(!onToolOperation?.authorize ||
									(await onToolOperation.authorize()));
							if (
								allowed &&
								onToolOperation &&
								input.hook_event_name === "PreToolUse"
							)
								await onToolOperation.onIntent?.(
									typeof input.tool_use_id === "string"
										? input.tool_use_id
										: "unknown-tool-use",
									input.tool_name,
								);
							const output = {
								hookSpecificOutput: {
									hookEventName: "PreToolUse" as const,
									permissionDecision: allowed
										? ("allow" as const)
										: ("deny" as const),
									permissionDecisionReason: "Conversation workspace policy",
									...(allowed && updatedInput ? { updatedInput } : {}),
								},
							};
							if (!allowed) await cleanupToolReadOnlyFile(toolUseId);
							return output;
						},
					],
				},
			],
			...(onToolOperation
				? {
						PostToolUse: [
							{
								hooks: [
									async (input) => {
										const toolUseId =
											"tool_use_id" in input ? input.tool_use_id : undefined;
										try {
											if (input.hook_event_name === "PostToolUse") {
												await onToolOperation.onStarted?.(
													typeof toolUseId === "string"
														? toolUseId
														: "unknown-tool-use",
													input.tool_name,
												);
												await onToolOperation.onCompleted?.(
													typeof toolUseId === "string"
														? toolUseId
														: "unknown-tool-use",
													input.tool_name,
												);
											}
											return {};
										} finally {
											await cleanupToolReadOnlyFile(toolUseId);
										}
									},
								],
							},
						],
					}
				: {}),
			...(onToolOperation
				? {
						PostToolUseFailure: [
							{
								hooks: [
									async (input) => {
										if (input.hook_event_name !== "PostToolUseFailure")
											return {};
										const toolUseId =
											typeof input.tool_use_id === "string"
												? input.tool_use_id
												: "unknown-tool-use";
										try {
											await onToolOperation.onStarted?.(
												toolUseId,
												input.tool_name,
											);
											await onToolOperation.onFailed?.(
												toolUseId,
												input.tool_name,
												input.duration_ms,
											);
											return {};
										} finally {
											await cleanupToolReadOnlyFile(
												"tool_use_id" in input ? input.tool_use_id : undefined,
											);
										}
									},
								],
							},
						],
					}
				: {}),
		},
	};
}
