import { createHash } from "node:crypto";
import type {
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import { retireAcpProcess } from "./acp-process.js";
import { type AcpLaunch, openAcpSession } from "./acp-session.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

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
	readonly modelOptions: readonly AcpRuntimeModelOption[];
	readonly launch: (
		directory: string,
		selection: RuntimeSelectionV1,
		admit: () => Promise<void>,
	) => Promise<AcpLaunch>;
}

/** ACP lifecycle and event adaptation; durable operations are shared with Pi. */
export type GenericAcpRuntimeDriver = SessionRuntimeDriver;
export const GenericAcpRuntimeDriver = {
	open(options: GenericAcpRuntimeDriverOptions) {
		return SessionRuntimeDriver.open({
			...options,
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
			openSession: async ({ selection, admit, update, ...session }) => {
				const phases = new Map<string, string>();
				return openAcpSession({
					...session,
					launch: await options.launch(session.directory, selection, admit),
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
										: "started";
							if (phases.get(event.toolCallId) !== phase) {
								phases.set(event.toolCallId, phase);
								await update({
									type: "tool",
									payload: {
										toolCallId: createHash("sha256")
											.update(event.toolCallId)
											.digest("hex"),
										name:
											event.kind === "read"
												? "Read"
												: event.kind === "edit"
													? "Edit"
													: "unavailable",
										phase,
									},
								});
							}
						} else await update();
					},
				});
			},
		});
	},
};
