import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BrowserCapabilityAvailableV1,
	RuntimeCapabilitiesV1,
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
	/** Deployment-owned verified Browser projection; never selected by a wire command. */
	readonly browserCapability?: BrowserCapabilityAvailableV1;
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
	async open(options: GenericAcpRuntimeDriverOptions) {
		const driver = await SessionRuntimeDriver.open({
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
		return Object.assign(driver, {
			/**
			 * Probe only the ACP handshake and Session creation. A readiness probe
			 * must not submit a prompt or otherwise consume a model/Connection.
			 */
			probeReadiness: (signal: AbortSignal): Promise<RuntimeCapabilitiesV1> =>
				probeAcpReadiness(options, signal),
		});
	},
};

async function probeAcpReadiness(
	options: GenericAcpRuntimeDriverOptions,
	signal: AbortSignal,
): Promise<RuntimeCapabilitiesV1> {
	if (signal.aborted) throw new Error("RUNTIME_READINESS_UNAVAILABLE");
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-acp-probe-"));
	const cwd = join(directory, "workspace");
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	let session: Awaited<ReturnType<typeof openAcpSession>> | undefined;
	try {
		const probe = (async () => {
			const selection: RuntimeSelectionV1 = {
				schemaVersion: 1,
				modelOptionId: options.defaultModelOptionId,
				reasoningLevel: options.defaultReasoningLevel,
			};
			session = await openAcpSession({
				launch: await options.launch(directory, selection, async () => {}),
				directory,
				cwd,
				update: async () => {},
			});
			if (signal.aborted) throw new Error("RUNTIME_READINESS_UNAVAILABLE");
			const selectionState = session.modelSelection();
			return {
				modelSelection:
					selectionState.models.length > 0 &&
					selectionState.currentModel !== null,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			} satisfies RuntimeCapabilitiesV1;
		})();
		const interrupted = new Promise<never>((_, reject) => {
			if (signal.aborted) {
				reject(new Error("RUNTIME_READINESS_UNAVAILABLE"));
				return;
			}
			signal.addEventListener(
				"abort",
				() => reject(new Error("RUNTIME_READINESS_UNAVAILABLE")),
				{ once: true },
			);
		});
		return await Promise.race([probe, interrupted]);
	} catch {
		throw new Error("RUNTIME_READINESS_UNAVAILABLE");
	} finally {
		await session?.close().catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}
