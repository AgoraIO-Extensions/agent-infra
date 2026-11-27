import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { openCodexModelTransport } from "./codex-model-transport.js";
import type { RuntimeExternalActionAuthorizer } from "./driver.js";
import { paseoModelRequest } from "./paseo-model-request.js";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { openPiPodDaemon, piPodPaths } from "./paseo-pod.js";
import { PaseoTransport } from "./paseo-transport.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

export interface PaseoCodexRuntimeOption {
	readonly modelOptionId: string;
	readonly model: string;
	readonly reasoningLevels: readonly string[];
	readonly endpoint: string;
	readonly authentication: "api-key" | "bearer";
}

export interface PaseoCodexRuntimeOptions {
	readonly textOnly?: boolean;
	readonly authorizeModelAction: RuntimeExternalActionAuthorizer;
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly PaseoCodexRuntimeOption[];
}

/** One Session Pod owns the SDK daemon; only its loopback proxy receives execution credentials. */
export async function openPaseoCodexRuntime(options: PaseoCodexRuntimeOptions) {
	if (
		!options.authorizeModelAction ||
		options.modelOptions.some(
			(option) => option.authentication !== "bearer" || "credential" in option,
		)
	)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	return SessionRuntimeDriver.open({
		path: options.path,
		workspaceRoot: piPodPaths.workspaces,
		configVersion: options.configVersion,
		defaultModelOptionId: options.defaultModelOptionId,
		defaultReasoningLevel: options.defaultReasoningLevel,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: option.model,
			reasoningLevels: option.reasoningLevels,
		})),
		supportsAttachments: true,
		workspaceAttachments: true,
		supportsResultFiles: true,
		sandboxReferences: true,
		supportsInput: (input) => {
			const text = "text" in input ? input.text : "";
			return (
				(text.trim().length > 0 || input.attachments.length > 0) &&
				!text.trimStart().startsWith("/")
			);
		},
		cursorPrefix: "codex",
		nativeCommandSourceVersion: "0.153.0",
		paseoCommandDiscovery: true,
		// The companion retires the original process tree when the Host pipe closes.
		retireSession: async () => {},
		completionStatus: (reason) =>
			reason === "stop"
				? "completed"
				: reason === "aborted"
					? "cancelled"
					: reason === "error"
						? "failed"
						: "unknown",
		openSession: async (session) => {
			let currentSession = session;
			const option = options.modelOptions.find(
				(value) => value.modelOptionId === session.selection.modelOptionId,
			);
			if (!option || session.browser || !session.codexThread)
				throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
			await mkdir(session.directory, { recursive: true, mode: 0o700 });
			if ((await realpath(session.directory)) !== session.directory)
				throw new Error("RUNTIME_CONFIGURATION_INVALID");
			let confirmed = false;
			const modelUnknown = Promise.withResolvers<void>();
			let markingUnknown: Promise<void> | undefined;
			const markUnknown = () =>
				(markingUnknown ??=
					currentSession.markUnknown?.() ?? Promise.resolve());
			const openRequest = () =>
				paseoModelRequest(
					currentSession,
					options.authorizeModelAction,
					() => {
						confirmed = true;
					},
					async () => {
						modelUnknown.resolve();
						await markUnknown();
					},
				);
			const model = option.model;
			const proxy = await openCodexModelTransport(
				[
					{
						internalModel: model,
						model: option.model,
						endpoint: option.endpoint,
					},
				],
				{
					officialLane: options.textOnly ? "text-only" : true,
					beforeRequest: async (context, signal) => {
						confirmed = false;
						signal.throwIfAborted();
						await currentSession.admit();
						if (!transport)
							throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
						try {
							await transport.bindCodexModelThread(context.threadId);
						} catch (error) {
							modelUnknown.resolve();
							await markUnknown();
							throw error;
						}
						const request = await openRequest()("main");
						let credential: string | undefined;
						try {
							credential = await request.resolveCredential?.();
						} catch (error) {
							await request.receipt?.("failed", false);
							throw error;
						}
						const assertCurrent = () => {
							signal.throwIfAborted();
							request.revalidate?.();
						};
						assertCurrent();
						return {
							credential,
							assertCurrent,
							started: async () => {
								await request.receipt?.("sent", false);
							},
							finish: async (outcome) => {
								await request.receipt?.(
									outcome.phase === "succeeded" ? "completed" : outcome.phase,
									outcome.phase === "succeeded",
									{
										stage: "stream_validation",
										sent: true,
										durationMs: outcome.durationMs ?? 0,
										...(outcome.phase === "succeeded" && outcome.usage
											? { usage: outcome.usage }
											: {}),
									},
								);
							},
						};
					},
				},
				{
					sessionSelection: {
						internalModel: model,
						reasoningLevel: session.selection.reasoningLevel,
					},
				},
			);
			const access = proxy.modelAccessFor(
				createHash("sha256").update(session.runtimeSessionRef).digest("hex"),
			);
			let daemon: Awaited<ReturnType<typeof openPiPodDaemon>> | undefined;
			let transport: PaseoTransport | undefined;
			const close = async () => {
				try {
					await proxy.close();
				} finally {
					try {
						await transport?.close();
					} finally {
						await daemon?.close();
					}
				}
			};
			try {
				daemon = await openPiPodDaemon({
					textOnly: options.textOnly,
					sessionRef: session.runtimeSessionRef,
					model,
					effort: session.selection.reasoningLevel,
					levels: option.reasoningLevels,
					endpoint: access.endpoint,
					proxyToken: access.credential,
				});
				transport = new PaseoTransport({
					socketPath: daemon.socketPath,
					password: daemon.password,
					template: "codex",
					codexThread: session.codexThread,
					model,
					cwd: session.cwd,
					thinkingOptionId: session.selection.reasoningLevel,
				});
				return await openPaseoNativeSession({
					session: { ...session, markUnknown },
					model,
					transport,
					close,
					exited: daemon.exited,
					turnInterrupted: modelUnknown.promise,
					hasConfirmedModelTurn: () => confirmed,
					...(session.executionId
						? {
								prepareSelection: () =>
									transport?.selectAgent(session.runtimeSessionRef) ??
									Promise.reject(
										new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE"),
									),
							}
						: {}),
					beginCompact: (next) => {
						proxy.assertSessionIdle();
						currentSession = next;
						confirmed = false;
						markingUnknown = undefined;
					},
				});
			} catch (error) {
				await close().catch(() => {});
				throw error;
			}
		},
	});
}
