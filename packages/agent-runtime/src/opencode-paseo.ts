import { openRuntimeMessagesTransport } from "./messages-model-transport.js";
import type { OpenCodeRuntimeOptions } from "./opencode-bootstrap.js";
import { OPENCODE_NATIVE_PROVENANCE } from "./opencode-installation.js";
import { paseoModelRequest } from "./paseo-model-request.js";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { openPiPodDaemon, piPodPaths } from "./paseo-pod.js";
import { PaseoTransport } from "./paseo-transport.js";
import { SessionRuntimeDriver } from "./session-runtime-driver.js";

export function createOpenCodeModelAuthorizer(
	initial: OpenCodeRuntimeOptions["authorizeInitialModelAction"],
	ordinary: NonNullable<OpenCodeRuntimeOptions["authorizeModelAction"]>,
) {
	let next = initial ?? ordinary;
	return async (action: Parameters<typeof ordinary>[0]) => {
		const result = await next(action);
		if (result?.relayKey && result.revalidate) next = ordinary;
		return result;
	};
}

export function openOpenCodePaseoRuntime(options: OpenCodeRuntimeOptions) {
	const authorize = options.authorizeModelAction;
	if (
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
		cursorPrefix: "acp",
		paseoCommandDiscovery: true,
		openCodeReviewVersion: OPENCODE_NATIVE_PROVENANCE.nativeVersion,
		nativeCommandSourceVersion: OPENCODE_NATIVE_PROVENANCE.nativeVersion,
		authorizeModelAction: authorize,
		modelOptions: options.modelOptions.map((option) => ({
			modelOptionId: option.modelOptionId,
			nativeModelId: "anthropic/" + option.model,
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
				client: "opencode",
				textOnly: true,
				admit: session.admit,
				openDiagnosticReceipt: session.openDiagnosticReceipt,
				openRequest: paseoModelRequest(
					session,
					createOpenCodeModelAuthorizer(
						session.nativeId ? undefined : options.authorizeInitialModelAction,
						authorize,
					),
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
				const model = "anthropic/" + option.model;
				transport = new PaseoTransport({
					template: "opencode",
					model,
					cwd: session.cwd,
					thinkingOptionId: session.selection.reasoningLevel,
					socketPath: daemon.socketPath,
					password: daemon.password,
				});
				native = await openPaseoNativeSession({
					transport,
					model,
					session: { ...session, markUnknown },
					close,
					exited: Promise.race([daemon.exited, lost.promise]),
					hasConfirmedModelTurn: () => confirmed,
				});
				const { setAutoCompaction: _piCommand, ...handle } = native;
				return handle;
			} catch (error) {
				await close();
				throw error;
			}
		},
	});
}
