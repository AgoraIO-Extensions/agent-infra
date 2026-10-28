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
import {
	type BrowserMcpGatewayV1,
	createBrowserMcpGatewayV1,
} from "./browser-mcp-gateway.js";
import type {
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
} from "./driver.js";
import { openCodeToolName } from "./opencode-tools.js";
import {
	type NativeSessionOptions,
	SessionRuntimeDriver,
} from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";
import {
	createStandardMcpAcpBridge,
	type StandardMcpAcpBridge,
} from "./standard-mcp-acp-bridge.js";
import {
	StandardMcpClient,
	type StandardMcpClientOptions,
} from "./standard-mcp-client.js";

export interface AcpRuntimeModelOption {
	readonly modelOptionId: string;
	readonly nativeModelId: string;
	readonly reasoningLevels: readonly string[];
}
export interface GenericAcpRuntimeDriverOptions {
	/** Deployment-owned verified Browser projection; never selected by a wire command. */
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly AcpRuntimeModelOption[];
	/** OpenCode supports multiple prompts on one ACP Session with refreshed Keys. */
	readonly reuseNativeSession?: boolean;
	/**
	 * #3226：标准模板（OpenCode）解析最终回答中的 `sandbox:` 引用；未经验证的 ACP 自定义
	 * Agent 只适用 image/resource_link 块映射。
	 */
	readonly sandboxReferences?: boolean;
	/**
	 * #3225：标准模板（OpenCode）把附件物化到 Conversation 工作区并追加清单，不依赖图片协商；
	 * ACP 自定义 Agent 不设置，附件仍只按协商的 ACP image 输入传递。
	 */
	readonly workspaceAttachments?: boolean;
	readonly authorizeModelAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	/** Host-owned protected Connection client; only enabled by a verified ACP gate. */
	readonly standardConnectionClient?: StandardMcpClientOptions;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	/** Controlled native Skill prompt mapping; never receives caller paths or credentials. */
	readonly nativeSkillPrompt?: (name: string, parameters: string) => string;
	readonly launch: (
		directory: string,
		selection: RuntimeSelectionV1,
		admit: () => Promise<void>,
		resolveModelCredential?: () => Promise<string>,
	) => Promise<AcpLaunch>;
}

/** ACP lifecycle and event adaptation; durable operations are shared with Pi. */
export type GenericAcpRuntimeDriver = SessionRuntimeDriver;
export const GenericAcpRuntimeDriver = {
	async open(options: GenericAcpRuntimeDriverOptions) {
		const browserCapability =
			typeof options.browserCapability === "function"
				? options.browserCapability()
				: options.browserCapability;
		// The ACP handshake that decides image input happens before a Session is
		// created, so the last negotiated answer gates attachment input before any
		// bridge read or Session side effect. An unknown answer fails closed.
		let negotiatedImageInput: boolean | undefined;
		let readinessProbe: Promise<RuntimeCapabilitiesV1> | undefined;
		const driver = await SessionRuntimeDriver.open({
			...options,
			...(browserCapability
				? { browserCapability }
				: { browserCapability: undefined }),
			...(options.nativeSkillPrompt
				? { nativeSkillPrompt: options.nativeSkillPrompt }
				: {}),
			// The Driver consumes attachments when the peer negotiated image input;
			// readiness reports that negotiated fact per peer, and each request
			// enforces it before reading bytes.
			supportsAttachments: true,
			supportsResultFiles: true,
			attachmentsNegotiated: () => negotiatedImageInput === true,
			cursorPrefix: "acp",
			nativeCommandSourceVersion: "1.4.0",
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
				const modelOption = options.modelOptions.find(
					(option) => option.modelOptionId === selection.modelOptionId,
				);
				if (!modelOption)
					throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
				const callbacks = {
					admit,
					update,
					resultBlock: session.resultBlock,
					resolveModelCredential: session.resolveModelCredential,
					recordOperationFact: session.recordOperationFact,
					modelFact: {
						configVersion: options.configVersion,
						modelOptionId: selection.modelOptionId,
						modelId: modelOption.nativeModelId.replace(
							/[^A-Za-z0-9._:-]/g,
							"_",
						),
						reasoningLevel: selection.reasoningLevel,
					},
				};
				// ACP sessions can process multiple prompts over one native Session.
				// Keep the resolver stable inside the launch, while replacing its
				// per-Execution callback before every reused Turn.
				const resolveModelCredential = session.resolveModelCredential
					? async () => {
							const resolver = callbacks.resolveModelCredential;
							if (!resolver) throw new Error("RUNTIME_AUTHORIZATION_DENIED");
							return resolver();
						}
					: undefined;
				const phases = new Map<string, string>();
				const toolNames = new Map<string, string>();
				const launch = await options.launch(
					session.directory,
					selection,
					() => callbacks.admit(),
					resolveModelCredential,
				);
				const executionBrowser = session.browser;
				const executionCapability =
					typeof options.browserCapability === "function"
						? options.browserCapability()
						: options.browserCapability;
				let gateway: BrowserMcpGatewayV1 | undefined;
				let connectionGateway: StandardMcpAcpBridge | undefined;
				let connectionClient: StandardMcpClient | undefined;
				let nativeCancel: (() => Promise<void>) | undefined;
				let nativeClose: (() => Promise<void>) | undefined;
				try {
					if (executionBrowser) {
						if (!executionCapability || !session.executionId)
							throw new Error("RUNTIME_BROWSER_EXECUTION_UNAVAILABLE");
						gateway = await createBrowserMcpGatewayV1({
							capability: executionCapability,
							context: executionBrowser,
							executionId: session.executionId,
						});
					}
					if (options.standardConnectionClient) {
						if (!session.connectionReference)
							throw new Error("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
						const client = await StandardMcpClient.open(
							options.standardConnectionClient,
							session.connectionReference,
							AbortSignal.timeout(10_000),
						);
						connectionClient = client;
						connectionGateway = await createStandardMcpAcpBridge({
							client,
							execution: session.connectionReference,
							nativeSessionRef: () => session.runtimeSessionRef,
							recordOperationFact: callbacks.recordOperationFact,
							authorizeToolAction: options.authorizeToolAction,
							onBlocked: async () => {
								try {
									await session.markUnknown?.();
								} finally {
									try {
										await nativeCancel?.();
									} catch {
										await nativeClose?.().catch(() => {});
									} finally {
										await connectionGateway?.close().catch(() => {});
										await connectionClient?.close().catch(() => {});
									}
								}
							},
						});
					}
				} catch (error) {
					await connectionGateway?.close().catch(() => {});
					await connectionClient?.close().catch(() => {});
					await launch.close?.().catch(() => {});
					throw error;
				}
				const servers = [
					...(gateway ? [gateway.server] : []),
					...(connectionGateway ? [connectionGateway.server] : []),
				];
				const launchWithGateway = servers.length
					? {
							...launch,
							mcpServers: servers,
							close: async () => {
								try {
									await launch.close?.();
								} finally {
									await connectionGateway?.close();
									await gateway?.close();
								}
							},
						}
					: launch;
				const launchWithBrowser = launchWithGateway;
				const native = await openAcpSession({
					...session,
					launch: launchWithBrowser,
					recordOperationFact: callbacks.recordOperationFact,
					modelFact: () => callbacks.modelFact,
					update: async ({ update: event }) => {
						if (event.sessionUpdate === "agent_message_chunk") {
							if (event.content.type === "text" && event.content.text) {
								await callbacks.update({
									type: "text",
									payload: { delta: event.content.text },
								});
								return;
							}
							// #3226：image 块直接发布，resource_link 按工作区引用处理；Turn 正常结束时
							// 与回答内引用一并处理。
							if (event.content.type === "image")
								callbacks.resultBlock?.({
									type: "image",
									data: event.content.data,
								});
							else if (event.content.type === "resource_link")
								callbacks.resultBlock?.({
									type: "resource_link",
									uri: event.content.uri,
								});
							await callbacks.update();
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
								const name =
									toolNames.get(event.toolCallId) ??
									(launch.nativeCommandMode === "opencode"
										? openCodeToolName(event)
										: undefined) ??
									(event.kind === "read"
										? "Read"
										: event.kind === "edit"
											? "Edit"
											: event.kind === "execute" &&
													launch.nativeCommandMode === "opencode"
												? "Bash"
												: "unavailable");
								toolNames.set(event.toolCallId, name);
								await callbacks.update({
									type: "tool",
									payload: {
										toolCallId: createHash("sha256")
											.update(event.toolCallId)
											.digest("hex"),
										name,
										phase,
									},
								});
							}
						} else await callbacks.update();
					},
				});
				nativeCancel = native.cancel;
				nativeClose = native.close;
				negotiatedImageInput = native.supportsImagePrompt;
				if (gateway || connectionGateway) {
					return {
						...native,
						cancel: async () => {
							try {
								await native.cancel();
							} finally {
								await connectionGateway?.close();
								await gateway?.close();
							}
						},
					};
				}
				return options.reuseNativeSession &&
					!options.standardConnectionClient &&
					!session.browser
					? {
							...native,
							startTurn: (next: NativeSessionOptions) => {
								native.startTurn?.(next);
								callbacks.admit = next.admit;
								callbacks.update = next.update;
								callbacks.resultBlock = next.resultBlock;
								callbacks.resolveModelCredential = next.resolveModelCredential;
								callbacks.recordOperationFact = next.recordOperationFact;
								const nextOption = options.modelOptions.find(
									(option) =>
										option.modelOptionId === next.selection.modelOptionId,
								);
								if (!nextOption)
									throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
								callbacks.modelFact = {
									configVersion: options.configVersion,
									modelOptionId: next.selection.modelOptionId,
									modelId: nextOption.nativeModelId.replace(
										/[^A-Za-z0-9._:-]/g,
										"_",
									),
									reasoningLevel: next.selection.reasoningLevel,
								};
								phases.clear();
								toolNames.clear();
								launch.beginTurn?.();
							},
							reuseFor: ({ browser }) => browser === undefined,
						}
					: native;
			},
		});
		if (
			options.standardConnectionClient &&
			typeof driver.getCapabilities === "function"
		) {
			const baseGetCapabilities = driver.getCapabilities.bind(driver);
			driver.getCapabilities = async () => ({
				...(await baseGetCapabilities()),
				connection: true,
			});
		}
		return Object.assign(driver, {
			/**
			 * Probe only the ACP handshake and Session creation. A readiness probe
			 * must not submit a prompt or otherwise consume a model/Connection.
			 */
			probeReadiness: async (
				signal: AbortSignal,
			): Promise<RuntimeCapabilitiesV1> => {
				if (signal.aborted) throw new Error("RUNTIME_READINESS_UNAVAILABLE");
				// Concurrent authenticated checks share one native initialization.
				// Retire it on completion or failure; never cache a ready result.
				readinessProbe ??= probeAcpReadiness(options, signal).finally(() => {
					readinessProbe = undefined;
				});
				const capabilities = await readinessProbe;
				if (signal.aborted) throw new Error("RUNTIME_READINESS_UNAVAILABLE");
				negotiatedImageInput = capabilities.attachments;
				return {
					...capabilities,
					// #3225：工作区附件不依赖图片协商；图片只在协商后另外作为 image 块。
					attachments:
						options.workspaceAttachments === true || capabilities.attachments,
					connection: options.standardConnectionClient !== undefined,
				};
			},
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
	const denyModelAccess = async (): Promise<never> => {
		throw new Error("RUNTIME_READINESS_UNAVAILABLE");
	};
	try {
		const probe = (async () => {
			const selection: RuntimeSelectionV1 = {
				schemaVersion: 1,
				modelOptionId: options.defaultModelOptionId,
				reasoningLevel: options.defaultReasoningLevel,
			};
			session = await openAcpSession({
				launch: await options.launch(
					directory,
					selection,
					denyModelAccess,
					denyModelAccess,
				),
				directory,
				cwd,
				signal,
				update: async () => {},
			});
			if (signal.aborted) throw new Error("RUNTIME_READINESS_UNAVAILABLE");
			const selectionState = session.modelSelection();
			return {
				modelSelection:
					selectionState.models.length > 0 &&
					selectionState.currentModel !== null,
				// ACP image input is optional; advertise attachments only when the
				// peer negotiated it during initialization.
				attachments: session.supportsImagePrompt,
				resultFiles: true,
				connection: false,
				supplementaryInstruction: false,
			} satisfies RuntimeCapabilitiesV1;
		})();
		// openAcpSession drains an interrupted handshake before this directory
		// is removed, including when no Session handle has been returned yet.
		return await probe;
	} catch {
		throw new Error("RUNTIME_READINESS_UNAVAILABLE");
	} finally {
		await session?.close().catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}
