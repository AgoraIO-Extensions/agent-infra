import type {
	BrowserCapabilityAvailableV1,
	RuntimeOperationFactV2,
	RuntimeSelectionV1,
	RuntimeStatusV1,
} from "@agent-infra/contracts/runtime";
import {
	type BrowserMcpGatewayV1,
	createBrowserMcpGatewayV1,
} from "./browser-mcp-gateway.js";
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
import {
	createStandardMcpAcpBridge,
	type StandardMcpAcpBridge,
} from "./standard-mcp-acp-bridge.js";
import {
	StandardMcpClient,
	type StandardMcpClientOptions,
} from "./standard-mcp-client.js";

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
	/** Host-owned protected Connection client; only enabled by the verified Pi gate. */
	readonly standardConnectionClient?: StandardMcpClientOptions;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
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
			nativeSkillPrompt: (name, parameters) =>
				`/skill:${name}${parameters.length > 0 ? ` ${parameters}` : ""}`,
			browserCapability: options.browserCapability,
			supportsAttachments: true,
			supportsResultFiles: true,
			supportsConnection: options.standardConnectionClient !== undefined,
			cursorPrefix: "pi",
			nativeCommandSourceVersion: "0.99.0",
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
				// Pi's official MCP extension is enabled only for Host-owned
				// loopback bridges. Connection credentials and Browser state never
				// cross this boundary.
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
				let nativeSessionRef = "";
				let connectionClient: StandardMcpClient | undefined;
				let connectionGateway: StandardMcpAcpBridge | undefined;
				let browserGateway: BrowserMcpGatewayV1 | undefined;
				let mcpExtensionEnabled = false;
				let nativeCancel: (() => Promise<void>) | undefined;
				let nativeClose: (() => Promise<void>) | undefined;
				const launch = await options.launch(
					session.directory,
					session.selection,
					() => callbacks.admit(),
					resolveModelCredential,
				);
				try {
					if (session.browser) {
						const capability =
							typeof options.browserCapability === "function"
								? options.browserCapability()
								: options.browserCapability;
						if (capability?.status !== "available" || !session.executionId)
							throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
						browserGateway = await createBrowserMcpGatewayV1({
							capability,
							context: session.browser,
							executionId: session.executionId,
						});
						const header = browserGateway.server.headers[0];
						if (header?.name !== "Authorization")
							throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
						launch.args = [...launch.args, "--extension", "builtin:mcp"];
						launch.env = {
							...launch.env,
							AGENT_INFRA_PI_BROWSER_MCP_URL: browserGateway.server.url,
							AGENT_INFRA_PI_BROWSER_MCP_TOKEN: header.value.replace(
								/^Bearer /,
								"",
							),
						};
						mcpExtensionEnabled = true;
					}
					if (options.standardConnectionClient) {
						if (!session.connectionReference)
							throw new Error("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
						connectionClient = await StandardMcpClient.open(
							options.standardConnectionClient,
							session.connectionReference,
							AbortSignal.timeout(10_000),
						);
						connectionGateway = await createStandardMcpAcpBridge({
							client: connectionClient,
							execution: session.connectionReference,
							nativeSessionRef: () => nativeSessionRef,
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
										await browserGateway?.close().catch(() => {});
									}
								}
							},
						});
						const header = connectionGateway.server.headers[0];
						if (header?.name !== "Authorization")
							throw new Error("CONNECTION_STANDARD_CLIENT_UNAVAILABLE");
						if (!mcpExtensionEnabled)
							launch.args = [...launch.args, "--extension", "builtin:mcp"];
						launch.env = {
							...launch.env,
							AGENT_INFRA_PI_CONNECTION_MCP_URL: connectionGateway.server.url,
							AGENT_INFRA_PI_CONNECTION_MCP_TOKEN: header.value.replace(
								/^Bearer /,
								"",
							),
						};
					}
					const native = await openPiSession({
						...session,
						recordOperationFact: async (fact: RuntimeOperationFactV2) => {
							await callbacks.recordOperationFact?.(fact);
						},
						modelFact: () => callbacks.modelFact?.(),
						recordToolOperation,
						update: (event) => callbacks.update(event),
						launch,
					});
					nativeSessionRef = native.nativeId;
					nativeCancel = native.cancel;
					nativeClose = native.close;
					return {
						...native,
						reusable: () =>
							options.standardConnectionClient || browserGateway
								? false
								: (native.reusable?.() ?? true),
						startTurn: (next) => {
							native.startTurn?.(next);
							callbacks.admit = next.admit;
							callbacks.update = next.update;
							callbacks.resolveModelCredential = next.resolveModelCredential;
							callbacks.recordOperationFact = next.recordOperationFact;
							callbacks.modelFact = next.modelFact;
							callbacks.recordToolOperation = next.recordToolOperation;
						},
						close: async () => {
							try {
								await native.close();
							} finally {
								await browserGateway?.close().catch(() => {});
								await connectionGateway?.close().catch(() => {});
								await connectionClient?.close().catch(() => {});
							}
						},
					};
				} catch (error) {
					await browserGateway?.close().catch(() => {});
					await connectionGateway?.close().catch(() => {});
					await connectionClient?.close().catch(() => {});
					await launch.close?.().catch(() => {});
					throw error;
				}
			},
		});
	},
};
