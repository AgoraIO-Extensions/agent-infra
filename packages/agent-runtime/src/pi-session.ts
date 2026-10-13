// Pi lifecycle adapted from Paseo PiCliRuntimeSession/buildPiLaunch at d1b705a0cd91617a5707fae25d80cb0be3057950.
// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0; see THIRD_PARTY_NOTICES.md.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RuntimeOperationFactV2 } from "@agent-infra/contracts/runtime";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { NativeProcessLaunch } from "./native-process.js";
import { readPiNativeCommandsV1 } from "./pi-native-command.js";
import { openPiRpc, type PiFrame, piRecord } from "./pi-rpc.js";
import type {
	NativePromptV1,
	NativeSessionOptions,
} from "./session-runtime-driver.js";
import { workspacePathAllowed } from "./workspace-path.js";

function historyCheckpoint(messages: unknown[]) {
	return JSON.stringify({
		count: messages.length,
		digest: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
	});
}

/** Identity facts of one Pi user Turn; image bytes never persist here. */
interface PiUserContent {
	readonly text: string;
	readonly images: readonly {
		readonly mimeType: string;
		readonly digest: string;
	}[];
}

/** Image media types the pinned Pi vision path transports to its providers. */
const piImageMediaTypes = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

function piImageDigest(data: string) {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * Reduces one outgoing or persisted Pi user message to the facts that bind a
 * Turn: its text plus the identity of every native image it carries. Anything
 * outside the pinned text-plus-image shape stays unconfirmed.
 */
function piUserContent(
	message: PiFrame | undefined,
): PiUserContent | undefined {
	const content = message?.content;
	if (!Array.isArray(content) || !content.length) return;
	const head = piRecord(content[0]);
	if (head?.type !== "text" || typeof head.text !== "string") return;
	const images: { mimeType: string; digest: string }[] = [];
	for (const part of content.slice(1)) {
		const image = piRecord(part);
		if (
			image?.type !== "image" ||
			typeof image.data !== "string" ||
			typeof image.mimeType !== "string" ||
			!piImageMediaTypes.has(image.mimeType)
		)
			return;
		images.push({
			mimeType: image.mimeType,
			digest: piImageDigest(image.data),
		});
	}
	return { text: head.text, images };
}

function samePiUserContent(left: PiUserContent, right: PiUserContent) {
	return (
		left.text === right.text &&
		left.images.length === right.images.length &&
		left.images.every(
			(image, index) =>
				image.mimeType === right.images[index]?.mimeType &&
				image.digest === right.images[index]?.digest,
		)
	);
}

/**
 * Validates one prompt against the native Pi RPC representation: a single text
 * message plus optional structured images, never an encoded text substitute.
 */
function normalizePiPrompt(prompt: NativePromptV1): {
	readonly content: PiUserContent;
	readonly images: readonly {
		readonly type: "image";
		readonly data: string;
		readonly mimeType: string;
	}[];
} {
	if (typeof prompt === "string")
		return { content: { text: prompt, images: [] }, images: [] };
	const head = prompt[0];
	if (head?.type !== "text") throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
	const images: { type: "image"; data: string; mimeType: string }[] = [];
	for (const block of prompt.slice(1)) {
		if (
			block.type !== "image" ||
			!piImageMediaTypes.has(block.mimeType) ||
			// Shape only: the shared Driver already owns media type, size and digest
			// validation, and an empty payload must not block the Session here.
			!/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
		)
			throw new Error("RUNTIME_FILE_INPUT_UNAVAILABLE");
		images.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return {
		content: {
			text: head.text,
			images: images.map((image) => ({
				mimeType: image.mimeType,
				digest: piImageDigest(image.data),
			})),
		},
		images,
	};
}

function promptBinding(
	nativeId: string,
	checkpoint: string,
	content: PiUserContent,
) {
	return createHash("sha256")
		.update(
			JSON.stringify([nativeId, checkpoint, content.text, content.images]),
		)
		.digest("hex");
}

const piResultFileMaximumBytes = 10 * 1024 * 1024;

function descriptorPath(fd: number): string | undefined {
	if (process.platform === "linux") return `/proc/self/fd/${fd}`;
}

/** Resolve a completed Pi write/edit to an existing file under its workspace. */
async function readPiResultFile(
	workspace: string,
	inputPath: unknown,
): Promise<{ readonly path: string; readonly content: string } | undefined> {
	if (typeof inputPath !== "string" || !inputPath) return;
	const root = await realpath(workspace).catch(() => undefined);
	if (!root) return;
	const path = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	const candidate = resolve(root, path);
	const lexical = relative(root, candidate);
	if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) return;
	if (!(await workspacePathAllowed(root, join(root, ".memory"), candidate)))
		return;
	const actual = await realpath(candidate).catch(() => undefined);
	if (!actual) return;
	const resolved = relative(root, actual);
	if (!resolved || resolved.startsWith("..") || isAbsolute(resolved)) return;
	const noFollow = constants.O_NOFOLLOW ?? 0;
	const file = await open(actual, constants.O_RDONLY | noFollow).catch(
		() => undefined,
	);
	if (!file) return;
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > piResultFileMaximumBytes) return;
		const opened = descriptorPath(file.fd);
		if (opened) {
			const openedPath = await realpath(opened).catch(() => undefined);
			if (!openedPath) return;
			const openedRelative = relative(root, openedPath);
			if (
				!openedRelative ||
				openedRelative.startsWith("..") ||
				isAbsolute(openedRelative)
			)
				return;
		}
		const bytes = Buffer.allocUnsafe(piResultFileMaximumBytes + 1);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const { bytesRead } = await file.read(
				bytes,
				offset,
				bytes.byteLength - offset,
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > piResultFileMaximumBytes) return;
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, offset),
			);
		} catch {
			return;
		}
		return {
			path: actual,
			content,
		};
	} finally {
		await file.close().catch(() => {});
	}
}

/** Pi 0.86 may precede one text Turn with a structured system-prompt patch. */
function piSystemPrefix(
	message: PiFrame | undefined,
	firstTurn: boolean,
	cwd: string,
) {
	const sections = piRecord(message?.sections);
	if (
		message?.role !== "system" ||
		message.content !== "" ||
		typeof message.timestamp !== "number" ||
		!Number.isFinite(message.timestamp) ||
		!sections ||
		Object.keys(sections).length === 0 ||
		!Object.entries(sections).every(
			([name, value]) =>
				[
					"preamble",
					"tools",
					"rules",
					"docs",
					"cwd",
					"addendum",
					"project_context",
					"skills",
				].includes(name) &&
				(value === null || typeof value === "string"),
		)
	)
		return false;
	const expectedCwd = `<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`;
	if (sections.cwd !== undefined && sections.cwd !== expectedCwd) return false;
	return (
		!firstTurn ||
		(typeof sections.preamble === "string" &&
			sections.preamble.length > 0 &&
			sections.cwd === expectedCwd)
	);
}

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
	const promptBindingFile = join(directory, "prompt-binding.sha256");
	async function readHistory(nativeId: string | undefined) {
		if (!(await lstat(sessionFile)).isFile())
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
		const raw = (await readFile(sessionFile, "utf8")).trim();
		const lines = raw ? raw.split("\n").map((line) => JSON.parse(line)) : [];
		if (!lines.length) {
			if (nativeId) throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
		} else {
			const header = piRecord(lines[0]);
			if (
				header?.type !== "session" ||
				header.version !== 3 ||
				typeof header.id !== "string" ||
				!header.id ||
				(nativeId && header.id !== nativeId) ||
				header.cwd !== options.cwd
			)
				throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
			// Pi's context traversal assumes a valid tree. Reject corrupt cycles and
			// missing parents before its pure helper or CLI can follow those links.
			const ids = new Set<string>();
			for (const line of lines.slice(1)) {
				const entry = piRecord(line);
				if (
					!entry ||
					typeof entry.type !== "string" ||
					typeof entry.id !== "string" ||
					!entry.id ||
					ids.has(entry.id) ||
					(entry.parentId !== null &&
						(typeof entry.parentId !== "string" || !ids.has(entry.parentId)))
				)
					throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				ids.add(entry.id);
			}
		}
		return buildSessionContext(lines.slice(1)).messages;
	}
	try {
		if (!options.nativeId) {
			try {
				const file = await open(sessionFile, "wx", 0o600);
				try {
					await file.sync();
				} finally {
					await file.close();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		const messages = await readHistory(options.nativeId);
		if (options.history) {
			const expected = piRecord(JSON.parse(options.history.checkpoint));
			const count = Number(expected?.count);
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
	} catch {
		await options.launch.close?.();
		throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	}

	let updates = Promise.resolve();
	let active:
		| {
				content: PiUserContent;
				resolve: (result: { stopReason: string; checkpoint: string }) => void;
				reject: (error: Error) => void;
		  }
		| undefined;
	let started = false;
	let currentCheckpoint: string | undefined;
	let exited = false;
	let policyReady = false;
	let currentRecordOperationFact = options.recordOperationFact;
	let currentModelFact = options.modelFact;
	let currentModelOperation:
		| {
				operationRef: string;
				attemptRef: string;
				fact: Extract<RuntimeOperationFactV2, { kind: "model" }>["model"];
				startedAt: number;
				writeFact: (fact: RuntimeOperationFactV2) => Promise<void>;
		  }
		| undefined;
	const phases = new Map<string, string>();
	const toolCalls = new Map<string, { toolName: string; args: unknown }>();
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
							await options.recordToolOperation?.(
								frame.toolCallId,
								frame.toolName === "read"
									? "Read"
									: ["write", "edit"].includes(frame.toolName as string)
										? "Edit"
										: "unavailable",
								phase,
							);
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
					if (
						frame.type === "tool_execution_start" &&
						typeof frame.toolCallId === "string" &&
						typeof frame.toolName === "string"
					)
						toolCalls.set(frame.toolCallId, {
							toolName: frame.toolName,
							args: frame.args,
						});
					if (
						frame.type === "tool_execution_end" &&
						typeof frame.toolCallId === "string"
					) {
						const call = toolCalls.get(frame.toolCallId);
						toolCalls.delete(frame.toolCallId);
						if (
							call &&
							call.toolName === frame.toolName &&
							["write", "edit"].includes(call.toolName) &&
							frame.isError === false
						) {
							const args = piRecord(call.args);
							const result = await readPiResultFile(options.cwd, args?.path);
							if (result) await options.resultFile?.(result);
						}
					}
					if (frame.type === "agent_end") {
						const confirmed = currentCheckpoint
							? await confirmedTerminal(currentCheckpoint, target.content)
							: undefined;
						if (!confirmed) throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
						const { stopReason, checkpoint } = confirmed;
						const persisted = await open(sessionFile, "r");
						try {
							await persisted.sync();
						} finally {
							await persisted.close();
						}
						// Pi can retain an in-memory message after a native append fails.
						// Confirm the durable tree before publishing a recoverable terminal.
						if (
							historyCheckpoint(await readHistory(confirmed.nativeId)) !==
							checkpoint
						)
							throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
						const completion = active;
						const modelOperation = currentModelOperation;
						if (modelOperation) {
							const failed = ["error", "aborted"].includes(stopReason);
							await modelOperation.writeFact({
								kind: "model",
								operationRef: modelOperation.operationRef,
								attemptRef: modelOperation.attemptRef,
								phase: failed ? "failed" : "completed",
								finishedAt: new Date().toISOString(),
								durationMs: Math.max(0, Date.now() - modelOperation.startedAt),
								...(failed
									? {
											failureCode:
												stopReason === "aborted"
													? ("interrupted" as const)
													: ("operation_failed" as const),
										}
									: {}),
								model: modelOperation.fact,
							});
						}
						active = undefined;
						currentModelOperation = undefined;
						completion?.resolve({ stopReason, checkpoint });
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
	async function confirmedTerminal(
		checkpoint: string,
		expected?: PiUserContent,
	) {
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
		const hasSystemPrefix = current[0]?.role === "system";
		const userIndex = hasSystemPrefix ? 1 : 0;
		const input = piUserContent(current[userIndex]);
		// A live Turn is bound to the exact prompt this Driver dispatched; a
		// recovered Turn to the durable binding of its last observed prompt.
		let inputMatches =
			expected !== undefined &&
			input !== undefined &&
			samePiUserContent(input, expected);
		if (expected === undefined && input !== undefined) {
			try {
				if ((await lstat(promptBindingFile)).isFile()) {
					const binding = (await readFile(promptBindingFile, "utf8")).trim();
					inputMatches =
						binding ===
						promptBinding(String(state.sessionId), checkpoint, input);
				}
			} catch {
				// A missing or damaged binding leaves the original Turn unknown.
			}
		}
		if (
			(hasSystemPrefix &&
				!piSystemPrefix(current[0], count === 0, options.cwd)) ||
			current[userIndex]?.role !== "user" ||
			input === undefined ||
			current.filter((message) => message?.role === "user").length !== 1 ||
			current
				.slice(userIndex + 1)
				.some(
					(message) =>
						message?.role !== "assistant" && message?.role !== "toolResult",
				) ||
			!inputMatches
		)
			return;
		const last = current.at(-1);
		if (
			last?.role !== "assistant" ||
			!["stop", "aborted", "error", "length"].includes(String(last.stopReason))
		)
			return;
		return {
			nativeId: String(state.sessionId),
			stopReason: String(last.stopReason),
			checkpoint: historyCheckpoint(messages),
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
			startTurn(next: {
				recordOperationFact?: (fact: RuntimeOperationFactV2) => Promise<void>;
				modelFact?: () =>
					| Extract<RuntimeOperationFactV2, { kind: "model" }>["model"]
					| undefined;
			}) {
				currentRecordOperationFact = next.recordOperationFact;
				currentModelFact = next.modelFact;
			},
			async discoverCommands(input: {
				readonly signal: AbortSignal;
				readonly expiresAt: number;
				readonly allowedRoots: readonly string[];
			}) {
				return readPiNativeCommandsV1({
					nativeId,
					expiresAt: input.expiresAt,
					signal: input.signal,
					allowedRoots: input.allowedRoots,
					request: () => rpc.request("get_commands"),
					close: rpc.close,
				});
			},
			reusable: () =>
				!exited && rpc.reusable() && (options.launch.reusable?.() ?? true),
			async checkpoint() {
				const response = piRecord(await rpc.request("get_messages"));
				if (!Array.isArray(response?.messages))
					throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
				currentCheckpoint = historyCheckpoint(response.messages);
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
			async prompt(prompt: NativePromptV1) {
				const { content, images } = normalizePiPrompt(prompt);
				if (active || exited) throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
				if (!currentCheckpoint) throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
				const checkpoint = currentCheckpoint;
				started = false;
				phases.clear();
				toolCalls.clear();
				const terminal = Promise.withResolvers<{
					stopReason: string;
					checkpoint: string;
				}>();
				const target = {
					content,
					resolve: terminal.resolve,
					reject: terminal.reject,
				};
				active = target;
				// Exit may reject the reservation while persistence is still pending.
				void terminal.promise.catch(() => {});
				try {
					const binding = await open(promptBindingFile, "w", 0o600);
					try {
						await binding.writeFile(
							promptBinding(nativeId, checkpoint, content),
						);
						await binding.sync();
					} finally {
						await binding.close();
					}
					const parent = await open(directory, "r");
					try {
						await parent.sync();
					} finally {
						await parent.close();
					}
					if (exited || active !== target)
						throw new Error("RUNTIME_ACCEPTANCE_UNKNOWN");
				} catch (error) {
					if (active === target) active = undefined;
					throw error;
				}
				const operationRef = randomUUID();
				const attemptRef = randomUUID();
				const fact = currentModelFact?.();
				const writeFact = currentRecordOperationFact;
				const startedAt = Date.now();
				if (fact && writeFact)
					currentModelOperation = {
						operationRef,
						attemptRef,
						fact,
						startedAt,
						writeFact,
					};
				try {
					if (fact && writeFact) {
						await writeFact({
							kind: "model",
							operationRef,
							attemptRef,
							phase: "intent",
							model: fact,
						});
						await writeFact({
							kind: "model",
							operationRef,
							attemptRef,
							phase: "started",
							startedAt: new Date(startedAt).toISOString(),
							model: fact,
						});
					}
				} catch (error) {
					if (active === target) active = undefined;
					throw error;
				}
				void rpc
					.request("prompt", {
						message: content.text,
						...(images.length ? { images } : {}),
					})
					.then(async () => {
						if (active === target) await options.update();
					})
					.catch(async () => {
						if (fact && writeFact)
							await writeFact({
								kind: "model",
								operationRef,
								attemptRef,
								phase: "failed",
								finishedAt: new Date().toISOString(),
								durationMs: Math.max(0, Date.now() - startedAt),
								failureCode: "operation_failed",
								model: fact,
							}).catch(() => undefined);
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
