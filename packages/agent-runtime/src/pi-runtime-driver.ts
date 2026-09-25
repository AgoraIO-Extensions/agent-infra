import type {
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import {
	type NativeProcessLaunch,
	retireNativeProcess,
} from "./native-process.js";
import { openPiSession } from "./pi-session.js";
import {
	type NativeSessionOptions,
	SessionRuntimeDriver,
	type SessionRuntimeModelOption,
} from "./session-runtime-driver.js";

export interface PiRuntimeDriverOptions {
	path: string;
	configVersion: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	modelOptions: readonly SessionRuntimeModelOption[];
	modelLifecycleAtTransport?: boolean;
	launch: (
		directory: string,
		selection: RuntimeSelectionV1,
		admit: () => Promise<void>,
		modelRequestIntent?: () => Promise<void>,
		modelRequestStarted?: () => Promise<void>,
		modelUsage?: NativeSessionOptions["modelUsage"],
		toolRequestStarted?: (tool: {
			readonly toolCallId: string;
			readonly name: string;
		}) => Promise<void>,
		modelRequestFinished?: NativeSessionOptions["modelRequestFinished"],
	) => Promise<NativeProcessLaunch>;
}

export type PiRuntimeDriver = SessionRuntimeDriver;
export const PiRuntimeDriver = {
	open(options: PiRuntimeDriverOptions) {
		return SessionRuntimeDriver.open({
			...options,
			cursorPrefix: "pi",
			retireSession: (directory) =>
				retireNativeProcess(directory, "AGENT_INFRA_PI_OWNER"),
			completionStatus: (reason): RuntimeStatusV1 =>
				reason === "stop"
					? "completed"
					: reason === "aborted"
						? "cancelled"
						: ["error", "length"].includes(reason)
							? "failed"
							: "unknown",
			openSession: async (session) => {
				const callbacks = {
					admit: session.admit,
					modelRequestIntent: session.modelRequestIntent,
					modelRequestStarted: session.modelRequestStarted,
					modelRequestFinished: session.modelRequestFinished,
					modelUsage: session.modelUsage,
					toolRequestStarted: session.toolRequestStarted,
					update: session.update,
				};
				const launch = await options.launch(
					session.directory,
					session.selection,
					() => callbacks.admit(),
					async () => {
						await callbacks.modelRequestIntent?.();
					},
					async () => {
						await callbacks.modelRequestStarted?.();
					},
					async (usage) => {
						await callbacks.modelUsage?.(usage);
					},
					async (tool) => {
						await callbacks.toolRequestStarted?.(tool);
					},
					async (state, usage) => {
						await callbacks.modelRequestFinished?.(state, usage);
					},
				);
				const native = await openPiSession({
					...session,
					update: (event) => callbacks.update(event),
					launch,
				});
				return {
					...native,
					startTurn: (next) => {
						callbacks.admit = next.admit;
						callbacks.modelRequestIntent = next.modelRequestIntent;
						callbacks.modelRequestStarted = next.modelRequestStarted;
						callbacks.modelRequestFinished = next.modelRequestFinished;
						callbacks.modelUsage = next.modelUsage;
						callbacks.toolRequestStarted = next.toolRequestStarted;
						callbacks.update = next.update;
						launch.onTurn?.({
							modelUsage: next.modelUsage,
							toolRequestStarted: next.toolRequestStarted,
						});
					},
				};
			},
		});
	},
};
