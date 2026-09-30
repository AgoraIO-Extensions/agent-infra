import { createHash } from "node:crypto";
import type {
	RuntimeOperationFactV2,
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import { retireAcpProcess } from "./acp-process.js";
import { type AcpLaunch, openAcpSession } from "./acp-session.js";
import type { RuntimeExternalActionAuthorizer } from "./driver.js";
import {
	type NativeSessionOptions,
	SessionRuntimeDriver,
} from "./session-runtime-driver.js";

export interface AcpRuntimeModelOption {
	readonly modelOptionId: string;
	readonly nativeModelId: string;
	readonly reasoningLevels: readonly string[];
}
export interface GenericAcpRuntimeDriverOptions {
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly authorizeExternalAction?: RuntimeExternalActionAuthorizer;
	readonly modelOptions: readonly AcpRuntimeModelOption[];
	readonly launch: (
		directory: string,
		selection: RuntimeSelectionV1,
		admit: () => Promise<void>,
		modelRequestIntent?: NativeSessionOptions["modelRequestIntent"],
		modelRequestStarted?: NativeSessionOptions["modelRequestStarted"],
		modelUsage?: (
			usage: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
		) => Promise<void>,
		toolRequestStarted?: (tool: {
			readonly toolCallId: string;
			readonly name: string;
			readonly permitted?: boolean;
			readonly executionBoundary?: true;
		}) => Promise<void>,
		modelRequestFinished?: NativeSessionOptions["modelRequestFinished"],
	) => Promise<AcpLaunch>;
}

/** ACP lifecycle and event adaptation; durable operations are shared with Pi. */
export type GenericAcpRuntimeDriver = SessionRuntimeDriver;
export const GenericAcpRuntimeDriver = {
	open(options: GenericAcpRuntimeDriverOptions) {
		return SessionRuntimeDriver.open({
			...options,
			modelLifecycleAtTransport: true,
			toolLifecycleAtBoundary: true,
			cursorPrefix: "acp",
			retireSession: retireAcpProcess,
			completionStatus: (reason): RuntimeStatusV1 =>
				reason === "end_turn"
					? "completed"
					: reason === "cancelled"
						? "cancelled"
						: ["max_tokens", "max_turn_requests", "refusal"].includes(reason)
							? "failed"
							: "unknown",
			openSession: async ({
				selection,
				admit,
				modelRequestIntent,
				modelRequestStarted,
				modelUsage,
				modelRequestFinished,
				toolRequestStarted,
				toolReceipt,
				update,
				...session
			}) => {
				const phases = new Map<string, string>();
				const pendingPermissions = new Map<string, number>();
				const normalizeToolRequestStarted = (
					callback: typeof toolRequestStarted | undefined,
				) =>
					callback
						? async (tool: {
								readonly toolCallId: string;
								readonly name: string;
								readonly permitted?: boolean;
								readonly executionBoundary?: true;
							}) => {
								if (tool.executionBoundary)
									pendingPermissions.set(
										tool.toolCallId,
										(pendingPermissions.get(tool.toolCallId) ?? 0) + 1,
									);
								try {
									await callback({
										...tool,
										toolCallId: createHash("sha256")
											.update(tool.toolCallId)
											.digest("hex"),
									});
									// A waiting-for-permission status is not an actual start.
									// Permit the native post-authorization start to be recorded.
									if (
										tool.executionBoundary &&
										tool.permitted !== false &&
										phases.get(tool.toolCallId) === "started"
									)
										phases.delete(tool.toolCallId);
								} finally {
									if (tool.executionBoundary) {
										const remaining =
											(pendingPermissions.get(tool.toolCallId) ?? 1) - 1;
										if (remaining)
											pendingPermissions.set(tool.toolCallId, remaining);
										else pendingPermissions.delete(tool.toolCallId);
									}
								}
							}
						: undefined;
				const normalizedToolRequestStarted =
					normalizeToolRequestStarted(toolRequestStarted);
				const normalizeToolReceipt = (callback: typeof toolReceipt) =>
					callback
						? async (receipt: Parameters<NonNullable<typeof toolReceipt>>[0]) =>
								callback({
									...receipt,
									toolCallId: createHash("sha256")
										.update(receipt.toolCallId)
										.digest("hex"),
								})
						: undefined;
				const launch = await options.launch(
					session.directory,
					selection,
					admit,
					modelRequestIntent,
					modelRequestStarted,
					modelUsage,
					normalizedToolRequestStarted,
					modelRequestFinished,
				);
				const native = await openAcpSession({
					...session,
					toolRequestStarted: normalizedToolRequestStarted,
					toolReceipt: normalizeToolReceipt(toolReceipt),
					launch,
					update: async ({ update: event }) => {
						if (
							event.sessionUpdate === "agent_message_chunk" &&
							event.content.type === "text" &&
							event.content.text
						) {
							await update({
								type: "text",
								payload: { delta: event.content.text },
							});
						} else if (
							event.sessionUpdate === "tool_call" ||
							event.sessionUpdate === "tool_call_update"
						) {
							const phase =
								event.status === "completed"
									? "completed"
									: event.status === "failed"
										? "failed"
										: event.status === "in_progress"
											? "started"
											: undefined;
							if (
								phase &&
								!pendingPermissions.has(event.toolCallId) &&
								phases.get(event.toolCallId) !== phase
							) {
								phases.set(event.toolCallId, phase);
								await update({
									type: "tool",
									payload: {
										toolCallId: createHash("sha256")
											.update(event.toolCallId)
											.digest("hex"),
										name:
											typeof event.kind === "string" && event.kind
												? event.kind
												: "unknown",
										phase,
									},
								});
							}
						} else await update();
					},
				});
				return {
					...native,
					startTurn: (next: NativeSessionOptions) => {
						native.startTurn?.({
							...next,
							toolRequestStarted: normalizeToolRequestStarted(
								next.toolRequestStarted,
							),
							toolReceipt: normalizeToolReceipt(next.toolReceipt),
						});
						launch.onTurn?.({
							modelRequestIntent: next.modelRequestIntent,
							modelRequestStarted: next.modelRequestStarted,
							modelUsage: next.modelUsage,
							modelRequestFinished: next.modelRequestFinished,
							toolRequestStarted: normalizeToolRequestStarted(
								next.toolRequestStarted,
							),
						});
					},
				};
			},
		});
	},
};
