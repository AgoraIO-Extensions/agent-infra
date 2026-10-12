// Lifecycle adapted from Paseo acp-agent.ts at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.

import { Readable, Writable } from "node:stream";
import {
	client,
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
import type { NativePromptV1 } from "./session-runtime-driver.js";

export interface AcpLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	close?: () => Promise<void>;
	authorize?: (
		tool: Pick<ToolCall, "toolCallId" | "kind" | "rawInput">,
	) => Promise<boolean>;
}

export async function openAcpSession(options: {
	launch: AcpLaunch;
	directory: string;
	cwd: string;
	nativeId?: string;
	update: (notification: SessionNotification) => Promise<void>;
}) {
	const native = await spawnAcpProcess(
		options.directory,
		options.cwd,
		options.launch,
	).catch(async () => {
		await options.launch.close?.();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
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
		Pick<ToolCall, "toolCallId" | "kind" | "rawInput">
	>();
	let activeSessionId: string | undefined;
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
						kind: update.kind ?? previous?.kind,
						rawInput: update.rawInput ?? previous?.rawInput,
					});
			}

			updates = updates.then(() => options.update(params));
			await updates.catch(() => {});
		})
		.onRequest("session/request_permission", async ({ params }) => {
			await updates.catch(() => {});
			const tool = tools.get(params.toolCall.toolCallId);
			const once = params.options.find(
				(option) => option.kind === "allow_once",
			);
			const allowed =
				!loading &&
				params.sessionId === activeSessionId &&
				tool &&
				once &&
				(await options.launch.authorize?.(tool).catch(() => false));
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
	try {
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
		const session = options.nativeId
			? await connection.agent.request("session/load", {
					sessionId: options.nativeId,
					cwd: options.cwd,
					mcpServers: [],
				})
			: await connection.agent.request("session/new", {
					cwd: options.cwd,
					mcpServers: [],
				});
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
			async prompt(prompt: NativePromptV1) {
				// ACP content blocks are not consumed yet: only the string form that
				// this driver advertises is rendered, never a structured prompt.
				if (typeof prompt !== "string")
					throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
				const text = prompt;
				tools.clear();
				const response = await connection.agent.request("session/prompt", {
					sessionId: nativeId,
					prompt: [{ type: "text", text }],
				});
				await updates;
				return response;
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
