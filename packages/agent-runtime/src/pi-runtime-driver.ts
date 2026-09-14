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
	SessionRuntimeDriver,
	type SessionRuntimeModelOption,
} from "./session-runtime-driver.js";

export interface PiRuntimeDriverOptions {
	path: string;
	configVersion: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	modelOptions: readonly SessionRuntimeModelOption[];
	launch: (
		directory: string,
		selection: RuntimeSelectionV1,
		admit: () => Promise<void>,
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
				const callbacks = { admit: session.admit, update: session.update };
				const native = await openPiSession({
					...session,
					update: (event) => callbacks.update(event),
					launch: await options.launch(
						session.directory,
						session.selection,
						() => callbacks.admit(),
					),
				});
				return {
					...native,
					startTurn: (next) => {
						callbacks.admit = next.admit;
						callbacks.update = next.update;
					},
				};
			},
		});
	},
};
