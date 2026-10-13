import type {
	BrowserCapabilityAvailableV1,
	RuntimeOperationFactV2,
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import {
	type NativeProcessLaunch,
	retireNativeProcess,
} from "./native-process.js";
import { openPiSession } from "./pi-session.js";
import {
	SessionRuntimeDriver,
	type SessionRuntimeModelOption,
} from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";

export interface PiRuntimeDriverOptions {
	/** Deployment-owned verified Browser projection; never selected by a wire command. */
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
	path: string;
	configVersion: string;
	defaultModelOptionId: string;
	defaultReasoningLevel: string;
	modelOptions: readonly SessionRuntimeModelOption[];
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly authorizeModelAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	launch: (
		directory: string,
		selection: RuntimeSelectionV1,
		admit: () => Promise<void>,
		resolveModelCredential?: () => Promise<string>,
	) => Promise<NativeProcessLaunch>;
}

export type PiRuntimeDriver = SessionRuntimeDriver;
export const PiRuntimeDriver = {
	open(options: PiRuntimeDriverOptions) {
		return SessionRuntimeDriver.open({
			...options,
			// The pinned Pi adapter has no verified Browser transport seam; keep the
			// descriptor surface empty until an extension/ACP callback is available.
			browserCapability: undefined,
			supportsAttachments: true,
			supportsResultFiles: true,
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
				// Pi 0.86 has no MCP session configuration or trusted extension
				// injection point in the pinned launch. Never expose Browser tools
				// through a prompt-only or synthetic descriptor path.
				if (session.browser)
					throw new Error("RUNTIME_BROWSER_EXECUTION_UNAVAILABLE");
				const callbacks = {
					admit: session.admit,
					update: session.update,
					resolveModelCredential: session.resolveModelCredential,
					recordOperationFact: session.recordOperationFact,
					modelFact: session.modelFact,
					recordToolOperation: session.recordToolOperation,
				};
				const recordToolOperation = async (
					toolCallId: string,
					toolId: string,
					phase: "started" | "completed" | "failed",
				) => {
					await callbacks.recordToolOperation?.(toolCallId, toolId, phase);
				};
				// Pi keeps its native transport alive when a later Turn reuses the
				// session. Resolve the current execution's Key through a stable
				// closure whose callback is replaced by startTurn below.
				const resolveModelCredential = session.resolveModelCredential
					? async () => {
							const resolver = callbacks.resolveModelCredential;
							if (!resolver) throw new Error("RUNTIME_AUTHORIZATION_DENIED");
							return resolver();
						}
					: undefined;
				const native = await openPiSession({
					...session,
					recordOperationFact: async (fact: RuntimeOperationFactV2) => {
						await callbacks.recordOperationFact?.(fact);
					},
					modelFact: () => callbacks.modelFact?.(),
					recordToolOperation,
					update: (event) => callbacks.update(event),
					launch: await options.launch(
						session.directory,
						session.selection,
						() => callbacks.admit(),
						resolveModelCredential,
					),
				});
				return {
					...native,
					startTurn: (next) => {
						native.startTurn?.(next);
						callbacks.admit = next.admit;
						callbacks.update = next.update;
						callbacks.resolveModelCredential = next.resolveModelCredential;
						callbacks.recordOperationFact = next.recordOperationFact;
						callbacks.modelFact = next.modelFact;
						callbacks.recordToolOperation = next.recordToolOperation;
					},
				};
			},
		});
	},
};
