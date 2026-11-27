import { CLAUDE_NATIVE_PROVENANCE } from "./claude-installation.js";
import type { ClaudeRuntimeDriverOptions } from "./claude-runtime-driver.js";
import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import { paseoModelRequest } from "./paseo-model-request.js";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { openPiPodDaemon, piPodPaths } from "./paseo-pod.js";
import { PaseoTransport } from "./paseo-transport.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

export type PaseoClaudeRuntimeOptions = Pick<
	ClaudeRuntimeDriverOptions,
	| "path"
	| "configVersion"
	| "defaultModelOptionId"
	| "defaultReasoningLevel"
	| "modelOptions"
> & {
	readonly paseoCompanion: true;
	readonly authorizeModelAction: NonNullable<
		ClaudeRuntimeDriverOptions["authorizeModelAction"]
	>;
};

export function openPaseoClaudeRuntime(options: PaseoClaudeRuntimeOptions) {
	const authorize = options.authorizeModelAction;
	if (
		!options.paseoCompanion ||
		!authorize ||
		options.modelOptions.some((option) => option.credential !== undefined)
	)
		throw new Error("RUNTIME_CONFIGURATION_INVALID");
	return SessionRuntimeDriver.open({
		path: options.path,
		configVersion: options.configVersion,
		defaultModelOptionId: options.defaultModelOptionId,
		defaultReasoningLevel: options.defaultReasoningLevel,
		workspaceRoot: piPodPaths.workspaces,
		cursorPrefix: "claude",
		paseoCommandDiscovery: true,
		nativeCommandSourceVersion: CLAUDE_NATIVE_PROVENANCE.nativeVersion,
		authorizeModelAction: authorize,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: option.model,
			reasoningLevels: option.reasoningLevels,
		})),
		supportsInput: (input) =>
			"text" in input &&
			input.attachments.length === 0 &&
			input.text.trim().length > 0 &&
			!input.text.trimStart().startsWith("/"),
		// The companion binds daemon lifetime to the Host's connection.
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
			const option = options.modelOptions.find(
				(o) => o.modelOptionId === session.selection.modelOptionId,
			);
			if (
				!option ||
				session.browser ||
				(session.nativeId && !session.nativeId.startsWith("paseo:"))
			)
				throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
			let confirmed = false;
			let native:
				| Awaited<ReturnType<typeof openPaseoNativeSession>>
				| undefined;
			const lost = Promise.withResolvers<void>();
			let pending: Promise<void> | undefined;
			const markUnknown = () =>
				(pending ??= session.markUnknown?.() ?? Promise.resolve());
			const proxy = await openRuntimeMessagesTransport({
				...option,
				effort: session.selection.reasoningLevel,
				client: "claude",
				textOnly: true,
				admit: session.admit,
				openDiagnosticReceipt: session.openDiagnosticReceipt,
				openRequest: paseoModelRequest(
					session,
					authorize,
					() => {
						confirmed = true;
					},
					async () => {
						if (await native?.handleCancellationStreamLoss()) return;
						lost.resolve();
						await markUnknown();
					},
				),
			});
			let daemon: Awaited<ReturnType<typeof openPiPodDaemon>> | undefined;
			let transport: PaseoTransport | undefined;
			async function close() {
				try {
					await proxy.close();
				} finally {
					try {
						await transport?.close();
					} finally {
						await daemon?.close();
					}
				}
			}
			try {
				daemon = await openPiPodDaemon({
					sessionRef: session.runtimeSessionRef,
					model: option.model,
					effort: session.selection.reasoningLevel,
					levels: option.reasoningLevels,
					endpoint: proxy.modelAccess.endpoint,
					proxyToken: proxy.modelAccess.credential,
				});
				const model = option.model;
				const client = new PaseoTransport({
					template: "claude",
					model,
					cwd: session.cwd,
					thinkingOptionId: session.selection.reasoningLevel,
					socketPath: daemon.socketPath,
					password: daemon.password,
				});
				transport = client;
				native = await openPaseoNativeSession({
					compactProvider: "claude",
					prepareSelection: () => client.selectAgent(session.runtimeSessionRef),
					transport,
					model,
					session: { ...session, markUnknown },
					close,
					exited: Promise.race([daemon.exited, lost.promise]),
					hasConfirmedModelTurn: () => confirmed,
				});
				const {
					setAutoCompaction: _piCommand,
					compact,
					prompt,
					...handle
				} = native;
				return {
					...handle,
					prompt: (input) =>
						prompt(typeof input === "string" ? input.trim() : input).finally(
							() => proxy.close(),
						),
					...(compact
						? {
								compact: (...args: Parameters<typeof compact>) =>
									compact(...args).finally(() => proxy.close()),
							}
						: {}),
				};
			} catch (error) {
				await close();
				throw error;
			}
		},
	});
}
