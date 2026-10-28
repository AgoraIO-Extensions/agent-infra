// Lifecycle adapted from Paseo acp-agent.ts at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.

import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import {
	type ContentBlock,
	client,
	type McpServer,
	PROTOCOL_VERSION,
	type SessionConfigOption,
	type SessionNotification,
	type ToolCall,
} from "@agentclientprotocol/sdk";
import {
	type AcpNativeCommandDirectoryV1,
	createAcpNativeCommandDirectoryV1,
} from "./acp-native-command.js";
import { spawnAcpProcess } from "./acp-process.js";
import { acpStream } from "./acp-stream.js";
import type { RuntimeNativeCommandCommandV1 } from "./driver.js";
import type { NativePromptV1 } from "./session-runtime-driver.js";

function incompleteToolInput(value: unknown) {
	return (
		value == null ||
		(typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0)
	);
}

export interface AcpLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	close?: () => Promise<void>;
	/** Reset per-execution transport state before reusing this native session. */
	beginTurn?: () => void;
	/** A launch can retire reuse after a transport or process failure. */
	reusable?: () => boolean;
	authorize?: (
		tool: Pick<ToolCall, "toolCallId" | "kind" | "rawInput" | "title">,
	) => Promise<boolean>;
	/** Session-scoped MCP servers assembled by the trusted Runtime adapter. */
	mcpServers?: readonly McpServer[];
	/** OpenCode exposes command and compaction RPCs beyond generic ACP prompt. */
	nativeCommandMode?: "opencode";
}

export async function openAcpSession(options: {
	launch: AcpLaunch;
	directory: string;
	cwd: string;
	nativeId?: string;
	/** Cancel initialization before a native Session handle is available. */
	signal?: AbortSignal;
	update: (notification: SessionNotification) => Promise<void>;
	recordOperationFact?: (fact: RuntimeOperationFactV2) => Promise<void>;
	modelFact?: () =>
		| Extract<RuntimeOperationFactV2, { kind: "model" }>["model"]
		| undefined;
}) {
	if (options.signal?.aborted) {
		await options.launch.close?.();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}
	const native = await spawnAcpProcess(
		options.directory,
		options.cwd,
		options.launch,
	).catch(async () => {
		await options.launch.close?.();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	});
	let processExited = false;
	void native.exited.then(() => {
		processExited = true;
	});
	const { child, exited } = native;
	let updates = Promise.resolve();
	let loading = true;
	let commandDirectory: AcpNativeCommandDirectoryV1 | undefined;
	let commandDirectoryUnavailable = false;
	const pendingCommandUpdates = new Map<string, AcpNativeCommandDirectoryV1>();
	let commandDirectoryReady: () => void = () => {};
	const commandsReady = new Promise<void>((resolve) => {
		commandDirectoryReady = resolve;
	});
	const tools = new Map<
		string,
		Pick<ToolCall, "toolCallId" | "kind" | "rawInput" | "title">
	>();
	let activeSessionId: string | undefined;
	let currentRecordOperationFact = options.recordOperationFact;
	const connection = client({ name: "agent-infra" })
		.onNotification("session/update", async ({ params }) => {
			const update = params.update;
			if (update.sessionUpdate === "available_commands_update") {
				if (activeSessionId === undefined) {
					if (commandDirectoryUnavailable) return;
					try {
						if (
							!pendingCommandUpdates.has(params.sessionId) &&
							pendingCommandUpdates.size >= 16
						)
							throw new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
						pendingCommandUpdates.set(
							params.sessionId,
							createAcpNativeCommandDirectoryV1({
								nativeId: params.sessionId,
								commands: update.availableCommands,
							}),
						);
					} catch {
						pendingCommandUpdates.clear();
						commandDirectoryUnavailable = true;
						commandDirectoryReady();
					}
					return;
				}
				if (params.sessionId !== activeSessionId) return;
				try {
					commandDirectory = createAcpNativeCommandDirectoryV1({
						nativeId: params.sessionId,
						commands: update.availableCommands,
					});
				} catch {
					commandDirectoryUnavailable = true;
				}
				commandDirectoryReady();
				return;
			}
			if (loading || params.sessionId !== activeSessionId) return;
			if (
				update.sessionUpdate === "tool_call" ||
				update.sessionUpdate === "tool_call_update"
			) {
				const previous = tools.get(update.toolCallId);
				if (update.status === "completed" || update.status === "failed")
					tools.delete(update.toolCallId);
				else
					tools.set(update.toolCallId, {
						toolCallId: update.toolCallId,
						title: previous?.title ?? update.title ?? "",
						kind: update.kind ?? previous?.kind,
						rawInput: update.rawInput ?? previous?.rawInput,
					});
			}

			updates = updates.then(() => options.update(params));
			await updates.catch(() => {});
		})
		.onRequest("session/request_permission", async ({ params }) => {
			await updates.catch(() => {});
			const requestedInput = params.toolCall.rawInput;
			let tool = tools.get(params.toolCall.toolCallId);
			const deadline = performance.now() + 1000;
			while (
				!processExited &&
				!loading &&
				params.sessionId === activeSessionId &&
				tool &&
				incompleteToolInput(tool.rawInput) &&
				incompleteToolInput(requestedInput) &&
				performance.now() < deadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				await updates.catch(() => {});
				tool = tools.get(params.toolCall.toolCallId);
			}
			const previousInput = tool?.rawInput;
			const incomplete = incompleteToolInput(previousInput);
			const requestIncomplete = incompleteToolInput(requestedInput);
			const inputMatches =
				requestIncomplete ||
				incomplete ||
				isDeepStrictEqual(previousInput, requestedInput);
			const kindMatches =
				params.toolCall.kind == null || params.toolCall.kind === tool?.kind;
			// The announced identity remains authoritative. ACP permission requests can
			// complete arguments before the corresponding tool notification arrives.
			const permissionTool = tool && {
				...tool,
				rawInput:
					incomplete && !requestIncomplete
						? structuredClone(requestedInput)
						: previousInput,
			};
			const once = params.options.find(
				(option) => option.kind === "allow_once",
			);
			const allowed =
				!processExited &&
				!loading &&
				params.sessionId === activeSessionId &&
				permissionTool &&
				once &&
				inputMatches &&
				kindMatches &&
				(await options.launch.authorize?.(permissionTool).catch(() => false));
			const rejected = params.options.find(
				(option) => option.kind === "reject_once",
			);
			return {
				outcome: allowed
					? { outcome: "selected" as const, optionId: once.optionId }
					: rejected
						? { outcome: "selected" as const, optionId: rejected.optionId }
						: { outcome: "cancelled" as const },
			};
		})
		.connect(
			acpStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
		);

	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			commandDirectoryUnavailable = true;
			commandDirectoryReady();
			connection.close();
			await native.close();
			await options.launch.close?.();
			await updates.catch(() => {});
		})();
		return closing;
	};
	const handshakeDeadline = setTimeout(
		() => connection.close(new Error("RUNTIME_ACP_HANDSHAKE_TIMEOUT")),
		30_000,
	);
	const abortHandshake = () =>
		connection.close(new Error("RUNTIME_ACP_HANDSHAKE_INTERRUPTED"));
	options.signal?.addEventListener("abort", abortHandshake, { once: true });
	try {
		if (options.signal?.aborted) throw new Error();
		const initialized = await connection.agent.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: "agent-infra", version: "1" },
		});
		if (
			initialized.protocolVersion !== PROTOCOL_VERSION ||
			!initialized.agentCapabilities?.loadSession
		)
			throw new Error();
		// ACP image input is optional. Successful initialization and Session
		// creation do not establish support, so only the negotiated capability
		// may enable Driver media.
		const supportsImagePrompt =
			initialized.agentCapabilities?.promptCapabilities?.image === true;
		const session = options.nativeId
			? await connection.agent.request("session/load", {
					sessionId: options.nativeId,
					cwd: options.cwd,
					mcpServers: [...(options.launch.mcpServers ?? [])],
				})
			: await connection.agent.request("session/new", {
					cwd: options.cwd,
					mcpServers: [...(options.launch.mcpServers ?? [])],
				});
		if (options.signal?.aborted) throw new Error();
		const nativeId =
			options.nativeId ??
			("sessionId" in session ? session.sessionId : undefined);
		if (typeof nativeId !== "string" || !nativeId) throw new Error();
		let configOptions = session.configOptions ?? [];
		activeSessionId = nativeId;
		loading = false;
		if (pendingCommandUpdates.has(nativeId)) {
			commandDirectory = pendingCommandUpdates.get(nativeId);
			pendingCommandUpdates.delete(nativeId);
			commandDirectoryReady();
		}
		return {
			nativeId,
			startTurn(next: {
				recordOperationFact?: (fact: RuntimeOperationFactV2) => Promise<void>;
			}) {
				currentRecordOperationFact = next.recordOperationFact;
			},
			supportsImagePrompt,
			reusable: () =>
				!processExited &&
				child.exitCode === null &&
				child.signalCode === null &&
				(options.launch.reusable?.() ?? true),
			modelSelection: () => {
				const model = configOptions.find(
					(option) => option.category === "model" || option.id === "model",
				);
				const reasoning = configOptions.find(
					(option) =>
						option.category === "thought_level" || option.id === "effort",
				);
				return {
					models: model ? selectValues(model) : [],
					currentModel:
						typeof model?.currentValue === "string" ? model.currentValue : null,
					reasoningLevels: reasoning ? selectValues(reasoning) : [],
					currentReasoning:
						typeof reasoning?.currentValue === "string"
							? reasoning.currentValue
							: null,
				};
			},
			close,
			exited,
			async select(model: string, effort: string) {
				const deadline = setTimeout(
					() =>
						connection.close(new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED")),
					30_000,
				);
				try {
					const set = async (category: string, id: string, value: string) => {
						const option = configOptions.find(
							(option) => option.category === category || option.id === id,
						);
						if (
							option?.type !== "select" ||
							!selectValues(option).includes(value)
						)
							throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
						const response = await connection.agent.request(
							"session/set_config_option",
							{ sessionId: nativeId, configId: option.id, value },
						);
						configOptions = response.configOptions;
						if (
							configOptions.find((entry) => entry.id === option.id)
								?.currentValue !== value
						)
							throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
					};
					await set("model", "model", model);
					await set("thought_level", "effort", effort);
					if (
						configOptions.find(
							(option) => option.category === "model" || option.id === "model",
						)?.currentValue !== model
					)
						throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
				} finally {
					clearTimeout(deadline);
				}
			},
			async prompt(
				prompt: NativePromptV1,
			): Promise<{ stopReason: string; checkpoint?: string }> {
				tools.clear();
				const content: ContentBlock[] =
					typeof prompt === "string"
						? [{ type: "text", text: prompt }]
						: prompt.map((block) =>
								block.type === "text"
									? { type: "text" as const, text: block.text }
									: {
											type: "image" as const,
											data: block.data,
											mimeType: block.mimeType,
										},
							);
				if (
					!supportsImagePrompt &&
					content.some((block) => block.type === "image")
				)
					throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
				const operationRef = randomUUID();
				const attemptRef = randomUUID();
				const fact = options.modelFact?.();
				const writeFact = currentRecordOperationFact;
				if (fact && writeFact)
					await writeFact({
						kind: "model",
						operationRef,
						attemptRef,
						phase: "intent",
						model: fact,
					});
				const startedAt = Date.now();
				if (fact && writeFact)
					await writeFact({
						kind: "model",
						operationRef,
						attemptRef,
						phase: "started",
						startedAt: new Date(startedAt).toISOString(),
						model: fact,
					});
				try {
					const response = await connection.agent.request("session/prompt", {
						sessionId: nativeId,
						prompt: content,
					});
					await updates;
					if (fact && writeFact)
						await writeFact({
							kind: "model",
							operationRef,
							attemptRef,
							phase: "completed",
							finishedAt: new Date().toISOString(),
							durationMs: Math.max(0, Date.now() - startedAt),
							model: fact,
						});
					return response as { stopReason: string; checkpoint?: string };
				} catch (error) {
					if (fact && writeFact)
						await writeFact({
							kind: "model",
							operationRef,
							attemptRef,
							phase: "unknown",
							finishedAt: new Date().toISOString(),
							durationMs: Math.max(0, Date.now() - startedAt),
							failureCode: "recovery_unconfirmed",
							model: fact,
						});
					throw error;
				}
			},
			async executeNativeCommand(command: RuntimeNativeCommandCommandV1) {
				if (
					commandDirectoryUnavailable ||
					!commandDirectory?.commands.some(
						(entry) => entry.name === command.capabilityName,
					)
				)
					throw new Error("RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED");
				const response =
					options.launch.nativeCommandMode === "opencode"
						? await (
								connection.agent.request as unknown as (
									method: string,
									params: Record<string, unknown>,
								) => Promise<unknown>
							)(
								command.capabilityName === "compact"
									? "session/summarize"
									: "session/command",
								{
									sessionId: nativeId,
									...(command.capabilityName === "compact"
										? {
												customInstructions:
													command.parameters.length > 0
														? command.parameters
														: undefined,
											}
										: {
												name: command.capabilityName,
												args: command.parameters,
											}),
								},
							)
						: await connection.agent.request("session/prompt", {
								sessionId: nativeId,
								prompt: [
									{
										type: "text",
										text: `/${command.capabilityName}${
											command.parameters.length > 0
												? ` ${command.parameters}`
												: ""
										}`,
									},
								],
							});
				await updates;
				return {
					stopReason:
						response &&
						typeof response === "object" &&
						"stopReason" in response &&
						typeof response.stopReason === "string"
							? response.stopReason
							: "end_turn",
					...(response &&
					typeof response === "object" &&
					"checkpoint" in response &&
					typeof response.checkpoint === "string"
						? { checkpoint: response.checkpoint }
						: {}),
				};
			},
			async discoverCommands(input: {
				readonly signal: AbortSignal;
				readonly expiresAt: number;
				readonly allowedRoots: readonly string[];
			}) {
				if (
					input.signal.aborted ||
					input.expiresAt <= Date.now() ||
					commandDirectoryUnavailable
				)
					throw new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
				if (!commandDirectory) {
					const remaining = input.expiresAt - Date.now();
					let timer: ReturnType<typeof setTimeout> | undefined;
					let abort: (() => void) | undefined;
					try {
						const interrupted = new Promise<void>((resolve) => {
							const onAbort = () => resolve();
							abort = onAbort;
							input.signal.addEventListener("abort", onAbort, { once: true });
							timer = setTimeout(onAbort, remaining);
						});
						await Promise.race([commandsReady, interrupted]);
					} finally {
						if (timer) clearTimeout(timer);
						if (abort) input.signal.removeEventListener("abort", abort);
					}
				}
				if (
					input.signal.aborted ||
					input.expiresAt <= Date.now() ||
					commandDirectoryUnavailable ||
					!commandDirectory
				)
					throw new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
				return commandDirectory;
			},
			cancel: () =>
				connection.agent.notify("session/cancel", { sessionId: nativeId }),
		};
	} catch {
		await close();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	} finally {
		clearTimeout(handshakeDeadline);
		options.signal?.removeEventListener("abort", abortHandshake);
	}
}

// OpenDesign models.ts parsing pattern, without its default-model fallback.
function selectValues(option: SessionConfigOption): string[] {
	if (option.type !== "select") return [];
	return option.options.flatMap((value) =>
		"options" in value
			? value.options.map((entry) => entry.value)
			: [value.value],
	);
}
