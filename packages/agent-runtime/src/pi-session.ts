// Pi lifecycle adapted from Paseo PiCliRuntimeSession/buildPiLaunch at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { NativeProcessLaunch } from "./native-process.js";
import { openPiRpc, piRecord } from "./pi-rpc.js";
import type { NativeSessionOptions } from "./session-runtime-driver.js";

export async function openPiSession(
	options: NativeSessionOptions & { launch: NativeProcessLaunch },
) {
	const directory = join(options.directory, "native");
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		if ((await realpath(directory)) !== directory)
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	} catch {
		await options.launch.close?.();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}
	const sessionFile = join(directory, "session.jsonl");
	try {
		if (options.nativeId) {
			if (!(await lstat(sessionFile)).isFile())
				throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
			const lines = (await readFile(sessionFile, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			if (
				lines[0]?.type !== "session" ||
				lines[0].version !== 3 ||
				lines[0].id !== options.nativeId ||
				lines[0].cwd !== options.cwd
			)
				throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
			if (options.history) {
				const expected = piRecord(JSON.parse(options.history.checkpoint));
				const count = Number(expected?.count);
				const messages = buildSessionContext(lines.slice(1)).messages;
				if (
					!expected ||
					!Number.isSafeInteger(count) ||
					count < 0 ||
					messages.length < count ||
					(options.history.complete && messages.length !== count) ||
					createHash("sha256")
						.update(JSON.stringify(messages.slice(0, count)))
						.digest("hex") !== expected.digest
				)
					throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
			}
		} else {
			try {
				const file = await open(sessionFile, "wx", 0o600);
				await file.sync();
				await file.close();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	} catch {
		await options.launch.close?.();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}

	let updates = Promise.resolve();
	let active:
		| {
				resolve: (result: { stopReason: string; checkpoint: string }) => void;
				reject: (error: Error) => void;
		  }
		| undefined;
	let started = false;
	let currentCheckpoint: string | undefined;
	let exited = false;
	let policyReady = false;
	const phases = new Map<string, string>();
	const rpc = await openPiRpc(
		options.directory,
		options.cwd,
		{
			...options.launch,
			args: [...options.launch.args, "--mode", "rpc", "--session", sessionFile],
		},
		(frame) => {
			if (
				frame.type === "extension_ui_request" &&
				frame.method === "setTitle" &&
				frame.title === "agent-infra-policy-v1"
			) {
				policyReady = true;
				return;
			}
			if (
				frame.type === "extension_ui_request" &&
				typeof frame.id === "string"
			) {
				rpc.send({
					type: "extension_ui_response",
					id: frame.id,
					cancelled: true,
				});
				return;
			}
			if (!active) return;
			const target = active;
			updates = updates
				.then(async () => {
					if (active !== target) return;
					if (frame.type === "agent_start") {
						started = true;
						await options.update();
					}
					if (!started) return;
					const delta = piRecord(frame.assistantMessageEvent);
					// Event dispatch adapted from OpenDesign mapPiRpcEvent, ad9078b87c2d08e537ca3e041c46c124e7380c9c (Apache-2.0).
					if (
						frame.type === "message_update" &&
						delta?.type === "text_delta" &&
						typeof delta.delta === "string"
					)
						await options.update({
							type: "text",
							payload: { delta: delta.delta },
						});
					if (
						["tool_execution_start", "tool_execution_end"].includes(
							frame.type as string,
						) &&
						typeof frame.toolCallId === "string"
					) {
						const phase =
							frame.type === "tool_execution_start"
								? "started"
								: frame.isError === true
									? "failed"
									: "completed";
						if (phases.get(frame.toolCallId) !== phase) {
							phases.set(frame.toolCallId, phase);
							await options.update({
								type: "tool",
								payload: {
									toolCallId: createHash("sha256")
										.update(frame.toolCallId)
										.digest("hex"),
									name:
										frame.toolName === "read"
											? "Read"
											: ["write", "edit"].includes(frame.toolName as string)
												? "Edit"
												: "unavailable",
									phase,
								},
							});
						}
					}
					if (frame.type === "agent_end") {
						const confirmed = currentCheckpoint
							? await confirmedTerminal(currentCheckpoint)
							: undefined;
						if (!confirmed) throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
						const { stopReason, checkpoint } = confirmed;
						const persisted = await open(sessionFile, "r");
						try {
							await persisted.sync();
						} finally {
							await persisted.close();
						}
						const completion = active;
						active = undefined;
						completion.resolve({ stopReason, checkpoint });
					}
				})
				.catch(() => {
					active?.reject(new Error("RUNTIME_ACCEPTANCE_UNKNOWN"));
					active = undefined;
				});
		},
		() => {
			exited = true;
			void updates.finally(() => {
				active?.reject(new Error("RUNTIME_ACCEPTANCE_UNKNOWN"));
				active = undefined;
			});
		},
	);
	async function getState() {
		const state = piRecord(await rpc.request("get_state"));
		if (
			!state ||
			typeof state.sessionId !== "string" ||
			state.sessionFile !== sessionFile ||
			(options.nativeId && state.sessionId !== options.nativeId)
		)
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
		return state;
	}
	async function confirmedTerminal(checkpoint: string) {
		const before = piRecord(JSON.parse(checkpoint));
		if (
			!before ||
			!Number.isSafeInteger(before.count) ||
			Number(before.count) < 0 ||
			typeof before.digest !== "string"
		)
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
		const state = await getState();
		const response = piRecord(await rpc.request("get_messages"));
		if (
			state.isStreaming !== false ||
			state.pendingMessageCount !== 0 ||
			!Array.isArray(response?.messages)
		)
			return;
		const messages = response.messages;
		const count = Number(before.count);
		if (
			messages.length <= count ||
			createHash("sha256")
				.update(JSON.stringify(messages.slice(0, count)))
				.digest("hex") !== before.digest
		)
			return;
		const current = messages.slice(count).map(piRecord);
		if (
			current[0]?.role !== "user" ||
			current.filter((message) => message?.role === "user").length !== 1
		)
			return;
		const last = current.at(-1);
		if (
			last?.role !== "assistant" ||
			!["stop", "aborted", "error", "length"].includes(String(last.stopReason))
		)
			return;
		return {
			stopReason: String(last.stopReason),
			checkpoint: JSON.stringify({
				count: messages.length,
				digest: createHash("sha256")
					.update(JSON.stringify(messages))
					.digest("hex"),
			}),
			text: current
				.filter((message) => message?.role === "assistant")
				.flatMap((message) =>
					Array.isArray(message?.content) ? message.content : [],
				)
				.map(piRecord)
				.filter(
					(part) => part?.type === "text" && typeof part.text === "string",
				)
				.map((part) => part?.text)
				.join(""),
		};
	}

	try {
		const state = await getState();
		if (!policyReady) throw new Error("RUNTIME_WORKSPACE_POLICY_UNAVAILABLE");
		const nativeId = String(state.sessionId);
		const file = await open(sessionFile, "r");
		try {
			await file.sync();
		} finally {
			await file.close();
		}
		const parent = await open(directory, "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
		return {
			nativeId,
			reusable: () =>
				!exited && rpc.reusable() && (options.launch.reusable?.() ?? true),
			async checkpoint() {
				const response = piRecord(await rpc.request("get_messages"));
				if (!Array.isArray(response?.messages))
					throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				currentCheckpoint = JSON.stringify({
					count: response.messages.length,
					digest: createHash("sha256")
						.update(JSON.stringify(response.messages))
						.digest("hex"),
				});
				return currentCheckpoint;
			},
			recover: confirmedTerminal,
			async select(model: string, effort: string) {
				const slash = model.indexOf("/");
				if (slash < 1 || (await getState()).isStreaming !== false)
					throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
				const provider = model.slice(0, slash);
				const modelId = model.slice(slash + 1);
				const configured = piRecord(
					await rpc.request("set_model", { provider, modelId }),
				);
				if (configured?.provider !== provider || configured.id !== modelId)
					throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
				await rpc.request("set_thinking_level", { level: effort });
				const selected = await getState();
				const selectedModel = piRecord(selected.model);
				if (
					selected.thinkingLevel !== effort ||
					selectedModel?.provider !== provider ||
					selectedModel.id !== modelId
				)
					throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
			},
			async prompt(text: string) {
				if (active || exited) throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
				started = false;
				phases.clear();
				const terminal = Promise.withResolvers<{
					stopReason: string;
					checkpoint: string;
				}>();
				const target = { resolve: terminal.resolve, reject: terminal.reject };
				active = target;
				void rpc
					.request("prompt", { message: text })
					.then(() => (active === target ? options.update() : undefined))
					.catch(() => {
						if (active === target) {
							active?.reject(new Error("RUNTIME_ACCEPTANCE_UNKNOWN"));
							active = undefined;
						}
					});
				return terminal.promise;
			},
			async cancel() {
				await rpc.request("abort");
			},
			async close() {
				await rpc.close();
				await updates;
			},
		};
	} catch {
		await rpc.close();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}
}
