// Lifecycle adapted from Paseo acp-agent.ts at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.

import { Readable, Writable } from "node:stream";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import {
	client,
	PROTOCOL_VERSION,
	type SessionConfigOption,
	type SessionNotification,
	type ToolCall,
} from "@agentclientprotocol/sdk";
import { spawnAcpProcess } from "./acp-process.js";

import { acpStream } from "./acp-stream.js";

export interface AcpLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	close?: () => Promise<void>;
	authorize?: (
		tool: Pick<ToolCall, "toolCallId" | "kind" | "rawInput">,
	) => Promise<boolean>;
	onTurn?: (callbacks: {
		modelRequestIntent?: () => Promise<void>;
		modelRequestStarted?: () => Promise<void>;
		modelRequestFinished?: (
			state: "completed" | "failed" | "unknown",
			usage?: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
		) => Promise<void>;
		modelUsage?: (
			usage: Extract<RuntimeOperationFactV2, { kind: "model" }>["usage"],
		) => Promise<void>;
		toolRequestStarted?: (tool: {
			readonly toolCallId: string;
			readonly name: string;
			readonly permitted?: boolean;
			readonly executionBoundary?: true;
		}) => Promise<void>;
	}) => void;
}

export async function openAcpSession(options: {
	launch: AcpLaunch;
	directory: string;
	cwd: string;
	nativeId?: string;
	update: (notification: SessionNotification) => Promise<void>;
	toolRequestStarted?: (tool: {
		readonly toolCallId: string;
		readonly name: string;
		readonly permitted?: boolean;
		readonly executionBoundary?: true;
	}) => Promise<void>;
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
	const tools = new Map<
		string,
		Pick<ToolCall, "toolCallId" | "kind" | "rawInput">
	>();
	let activeSessionId: string | undefined;
	let currentToolRequestStarted = options.toolRequestStarted;
	const connection = client({ name: "agent-infra" })
		.onNotification("session/update", async ({ params }) => {
			if (loading || params.sessionId !== activeSessionId) return;
			const update = params.update;
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
			const activeTool = () =>
				!loading &&
				params.sessionId === activeSessionId &&
				tools.has(params.toolCall.toolCallId);
			const allowed =
				activeTool() &&
				tool &&
				once &&
				(await options.launch.authorize?.(tool).catch(() => false));
			const admitted =
				activeTool() && currentToolRequestStarted
					? await currentToolRequestStarted({
							toolCallId: params.toolCall.toolCallId,
							name: tool?.kind ?? params.toolCall.kind ?? "unknown",
							permitted: Boolean(allowed),
							executionBoundary: true,
						}).then(
							() => Boolean(allowed),
							() => false,
						)
					: false;
			const rejected = params.options.find(
				(option) => option.kind === "reject_once",
			);
			return {
				outcome:
					admitted && once
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
		return {
			nativeId,
			startTurn(next: {
				toolRequestStarted?: (tool: {
					readonly toolCallId: string;
					readonly name: string;
					readonly permitted?: boolean;
					readonly executionBoundary?: true;
				}) => Promise<void>;
			}) {
				currentToolRequestStarted = next.toolRequestStarted;
			},
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
					currentModel: model?.currentValue ?? null,
					reasoningLevels: reasoning ? selectValues(reasoning) : [],
					currentReasoning: reasoning?.currentValue ?? null,
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
			async prompt(text: string) {
				tools.clear();
				const responsePromise = connection.agent.request("session/prompt", {
					sessionId: nativeId,
					prompt: [{ type: "text", text }],
				});
				const response = await responsePromise;
				await updates;
				return response;
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
