import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserCapabilityAvailableV1 } from "@agent-infra/contracts/runtime";
import { createBrowserMcpGatewayV1 } from "./browser-mcp-gateway.js";
import { CLAUDE_NATIVE_PROVENANCE } from "./claude-installation.js";
import type {
	RuntimeBrowserExecutionContextV1,
	RuntimeExternalActionAuthorization,
	RuntimeExternalActionAuthorizationResult,
	RuntimeExternalActionAuthorizer,
} from "./driver.js";
import {
	type DynamicConnectionClientV1,
	resolveConnectionForBridgeV1,
} from "./dynamic-connection.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { paseoModelRequest } from "./paseo-model-request.js";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { openPiPodDaemon, piPodPaths } from "./paseo-pod.js";
import { PaseoTransport } from "./paseo-transport.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";
import type { RuntimeFilesystemSkillDirectoryV1 } from "./skill-hub-directory.js";
import {
	createStandardMcpAcpBridge,
	type StandardMcpAcpBridge,
} from "./standard-mcp-acp-bridge.js";
import type { StandardMcpClientOptions } from "./standard-mcp-client.js";

export interface PaseoClaudeRuntimeOption {
	readonly modelOptionId: string;
	readonly model: string;
	readonly reasoningLevels: readonly string[];
	readonly endpoint: string;
	readonly authentication: "api-key" | "bearer";
}

export interface PaseoClaudeRuntimeOptions {
	readonly paseoCompanion?: true;
	readonly authorizeModelAction: RuntimeExternalActionAuthorizer;
	readonly authorizeToolAction?: (
		action: RuntimeExternalActionAuthorization,
	) => Promise<RuntimeExternalActionAuthorizationResult | undefined>;
	readonly standardConnectionClient?: StandardMcpClientOptions;
	readonly dynamicConnectionClient?: DynamicConnectionClientV1;
	readonly browserCapability?:
		| BrowserCapabilityAvailableV1
		| (() => BrowserCapabilityAvailableV1 | undefined);
	readonly skillDirectory?: RuntimeFilesystemSkillDirectoryV1;
	readonly path: string;
	readonly configVersion: string;
	readonly defaultModelOptionId: string;
	readonly defaultReasoningLevel: string;
	readonly modelOptions: readonly PaseoClaudeRuntimeOption[];
}

function connectionBridgePort(sessionRef: string) {
	return (
		20_000 +
		(createHash("sha256").update(sessionRef).digest().readUInt16BE(0) % 20_000)
	);
}

function connectionBridgeTokenPath(root: string, sessionRef: string) {
	return join(
		root,
		"connection-bridges",
		`${createHash("sha256").update(sessionRef).digest("hex")}.token`,
	);
}

async function readOrCreateConnectionBridgeToken(
	root: string,
	sessionRef: string,
) {
	const directory = join(root, "connection-bridges");
	const tokenPath = connectionBridgeTokenPath(root, sessionRef);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	try {
		const token = (await readFile(tokenPath, "utf8")).trim();
		if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const token = randomBytes(32).toString("base64url");
	try {
		await writeFile(tokenPath, `${token}\n`, { flag: "wx", mode: 0o600 });
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = (await readFile(tokenPath, "utf8")).trim();
		if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) throw error;
		return existing;
	}
}

/** Claude's Messages endpoint remains behind the Host execution-key proxy. */
export function openPaseoClaudeRuntime(options: PaseoClaudeRuntimeOptions) {
	if (
		!options.paseoCompanion ||
		!options.authorizeModelAction ||
		options.modelOptions.some((option) => "credential" in option)
	)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	return SessionRuntimeDriver.open({
		path: options.path,
		configVersion: options.configVersion,
		defaultModelOptionId: options.defaultModelOptionId,
		defaultReasoningLevel: options.defaultReasoningLevel,
		workspaceRoot: piPodPaths.workspaces,
		browserCapability: options.browserCapability,
		...(options.skillDirectory
			? { skillDirectory: options.skillDirectory }
			: {}),
		cursorPrefix: "claude",
		paseoCommandDiscovery: true,
		nativeCommandSourceVersion: CLAUDE_NATIVE_PROVENANCE.nativeVersion,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: option.model,
			reasoningLevels: option.reasoningLevels,
		})),
		supportsAttachments: true,
		workspaceAttachments: true,
		supportsResultFiles: true,
		sandboxReferences: true,
		supportsConnection:
			options.standardConnectionClient !== undefined ||
			options.dynamicConnectionClient !== undefined,
		supportsInput: (input) =>
			(("text" in input && input.text.trim().length > 0) ||
				input.attachments.length > 0) &&
			(!("text" in input) || !input.text.trimStart().startsWith("/")),
		...(options.standardConnectionClient
			? { standardConnectionClient: options.standardConnectionClient }
			: {}),
		...(options.dynamicConnectionClient
			? { dynamicConnectionClient: options.dynamicConnectionClient }
			: {}),
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
			if (
				!option ||
				(session.nativeId !== undefined &&
					!session.nativeId.startsWith("paseo:"))
			)
				throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
			let confirmed = false;
			let native:
				| Awaited<ReturnType<typeof openPaseoNativeSession>>
				| undefined;
			let connectionBridge: StandardMcpAcpBridge | undefined;
			let browserGateway:
				| Awaited<ReturnType<typeof createBrowserMcpGatewayV1>>
				| undefined;
			const unknown = Promise.withResolvers<void>();
			let markingUnknown: Promise<void> | undefined;
			const markUnknown = () =>
				(markingUnknown ??=
					currentSession.markUnknown?.() ?? Promise.resolve());
			const mcpServers: Record<
				string,
				{ type: "http"; url: string; headers: Record<string, string> }
			> = {};
			const closeAuxiliary = async () => {
				await connectionBridge?.close();
				await browserGateway?.close();
			};
			try {
				if (
					options.standardConnectionClient ||
					options.dynamicConnectionClient
				) {
					const bridgeToken = await readOrCreateConnectionBridgeToken(
						options.path,
						session.runtimeSessionRef,
					);
					const resolveCall = async () => {
						if (!currentSession.connectionReference)
							return { refusal: "unavailable" as const };
						const resolved = await resolveConnectionForBridgeV1(
							options,
							currentSession.connectionReference,
							AbortSignal.timeout(10_000),
						);
						if ("refusal" in resolved) return resolved;
						return {
							client: resolved.client,
							execution: currentSession.connectionReference,
							nativeSessionRef: () => currentSession.runtimeSessionRef,
							recordOperationFact: currentSession.recordOperationFact,
							authorizeToolAction: options.authorizeToolAction,
							onBlocked: async () => {
								try {
									await currentSession.markUnknown?.();
								} finally {
									await native?.cancel().catch(() => {});
								}
							},
							close: () => resolved.client.close(),
						};
					};
					const resolved = session.connectionReference
						? await resolveConnectionForBridgeV1(
								options,
								session.connectionReference,
								AbortSignal.timeout(10_000),
							)
						: { refusal: "unavailable" as const };
					try {
						connectionBridge = await createStandardMcpAcpBridge({
							token: bridgeToken,
							...(options.dynamicConnectionClient
								? { declared: options.dynamicConnectionClient.declared }
								: {}),
							...(resolved && "client" in resolved
								? { client: resolved.client }
								: session.connectionReference
									? { refusal: resolved.refusal }
									: {}),
							execution: session.connectionReference,
							nativeSessionRef: () => currentSession.runtimeSessionRef,
							recordOperationFact: currentSession.recordOperationFact,
							authorizeToolAction: options.authorizeToolAction,
							resolveCall,
							listenPort: connectionBridgePort(session.runtimeSessionRef),
							onBlocked: async () => {
								try {
									await currentSession.markUnknown?.();
								} finally {
									await native?.cancel().catch(() => {});
								}
							},
						});
					} catch (error) {
						if (resolved && "client" in resolved)
							await resolved.client.close().catch(() => {});
						throw error;
					}
					mcpServers.connection = {
						type: "http",
						url: connectionBridge.server.url,
						headers: {
							Authorization: connectionBridge.server.headers[0].value,
						},
					};
				}
				const browserCapability =
					typeof options.browserCapability === "function"
						? options.browserCapability()
						: options.browserCapability;
				if (session.browser) {
					if (!browserCapability)
						throw new Error("RUNTIME_BROWSER_MCP_UNAVAILABLE");
					browserGateway = await createBrowserMcpGatewayV1({
						capability: browserCapability,
						context: session.browser as RuntimeBrowserExecutionContextV1,
						executionId: session.executionId ?? "",
					});
					mcpServers.browser = {
						type: "http",
						url: browserGateway.server.url,
						headers: {
							Authorization: browserGateway.server.headers[0].value,
						},
					};
				}
			} catch (error) {
				await closeAuxiliary();
				throw error;
			}
			let proxy: Awaited<ReturnType<typeof openRuntimeMessagesTransport>>;
			try {
				proxy = await openRuntimeMessagesTransport({
					...option,
					client: "claude",
					effort: currentSession.selection.reasoningLevel,
					admit: () => currentSession.admit(),
					openDiagnosticReceipt: () => currentSession.openDiagnosticReceipt?.(),
					openRequest: (purpose) =>
						paseoModelRequest(
							currentSession,
							options.authorizeModelAction,
							() => {
								confirmed = true;
							},
							async () => {
								if (await native?.handleCancellationStreamLoss()) return;
								unknown.resolve();
								await markUnknown();
							},
						)(purpose),
				});
			} catch (error) {
				await closeAuxiliary();
				throw error;
			}
			let daemon: Awaited<ReturnType<typeof openPiPodDaemon>> | undefined;
			let transport: PaseoTransport | undefined;
			const close = async () => {
				try {
					await proxy.close();
				} finally {
					try {
						await transport?.close();
					} finally {
						try {
							await daemon?.close();
						} finally {
							await closeAuxiliary();
						}
					}
				}
			};
			try {
				daemon = await openPiPodDaemon({
					sessionRef: currentSession.runtimeSessionRef,
					model: option.model,
					effort: currentSession.selection.reasoningLevel,
					levels: option.reasoningLevels,
					endpoint: proxy.modelAccess.endpoint,
					proxyToken: proxy.modelAccess.credential,
				});
				transport = new PaseoTransport({
					template: "claude",
					model: option.model,
					cwd: currentSession.cwd,
					thinkingOptionId: currentSession.selection.reasoningLevel,
					socketPath: daemon.socketPath,
					password: daemon.password,
					mcpServers,
				});
				native = await openPaseoNativeSession({
					transport,
					reusable: true,
					session: { ...session, markUnknown },
					onTurnStart: (next) => {
						currentSession = next;
						confirmed = false;
						markingUnknown = undefined;
					},
					model: option.model,
					close,
					exited: Promise.race([daemon.exited, unknown.promise]),
					hasConfirmedModelTurn: () => confirmed,
					beginCompact: (next) => {
						currentSession = next;
						confirmed = false;
						markingUnknown = undefined;
					},
				});
				return native;
			} catch (error) {
				await close();
				throw error;
			}
		},
	});
}
