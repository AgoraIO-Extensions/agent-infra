import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { workspacePathAllowed } from "./workspace-path.js";

export type ClaudeFileWriteOutput = Readonly<{
	filePath: string;
	content?: string;
	structuredPatch?: readonly unknown[];
}>;

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
	resolveReadOnlyFile?: (
		filePath: string,
		signal: AbortSignal,
	) => Promise<string | undefined>;
	cleanupReadOnlyFile?: (filePath: string) => Promise<void>;
}>;

/** Fixed core tools; Bash, subagents, MCP, network tools and arbitrary file roots remain unavailable. */
export function claudeWorkspaceTools(
	workspace: string,
	memory: string,
	onResultFile?: (output: ClaudeFileWriteOutput) => Promise<void>,
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
		tools: ["Read", "Write", "Edit"],
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
			...(onResultFile || onToolOperation
				? {
						PostToolUse: [
							{
								hooks: [
									async (input) => {
										const toolUseId =
											"tool_use_id" in input ? input.tool_use_id : undefined;
										try {
											if (
												onToolOperation &&
												input.hook_event_name === "PostToolUse"
											)
												await onToolOperation.onStarted?.(
													typeof toolUseId === "string"
														? toolUseId
														: "unknown-tool-use",
													input.tool_name,
												);
											if (
												onToolOperation &&
												input.hook_event_name === "PostToolUse"
											)
												await onToolOperation.onCompleted?.(
													typeof toolUseId === "string"
														? toolUseId
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
														(
															input.tool_response as {
																structuredPatch?: unknown;
															}
														).structuredPatch,
													))
											) {
												await onResultFile(
													input.tool_response as ClaudeFileWriteOutput,
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
