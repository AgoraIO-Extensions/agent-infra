import { createHash } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { projectDiscoveredPaseoCommands } from "./native-metadata-projection.js";
import {
	isPaseoSubmissionConflict,
	type PaseoTransport,
} from "./paseo-transport.js";
import type {
	NativeSession,
	NativeSessionOptions,
} from "./session-runtime-driver.js";
import { boundedRuntimeSkillRead } from "./skill-hub-directory.js";

type SessionInput = {
	session: NativeSessionOptions;
	model: string;
	transport: Pick<
		PaseoTransport,
		| "ensureAgent"
		| "refetchAgent"
		| "commands"
		| "subscribe"
		| "timeline"
		| "send"
		| "cancel"
	>;
	hasConfirmedModelTurn: () => boolean;
	close: () => Promise<void>;
	exited?: Promise<void>;
	beginCompact?: (session: NativeSessionOptions) => void;
	prepareSelection?: () => Promise<void>;
};

const unknown = () => new Error("RUNTIME_ACCEPTANCE_UNKNOWN");

function shellPhase(status: string, exitCode: number | null | undefined) {
	if (status === "running") return "started";
	if (status === "failed" || status === "canceled") return "failed";
	if (status === "completed" && Number.isSafeInteger(exitCode))
		return exitCode === 0 ? "completed" : "failed";
}

// Paseo omits the original Pi extension/prompt source and skill path.
const sdkText = (limit: number) =>
	z
		.string()
		.max(limit)
		.refine(
			(value) =>
				value.isWellFormed() &&
				Buffer.byteLength(value) <= limit &&
				[...value].every(
					(c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127,
				),
		);
const sdkCommands = z
	.array(
		z.strictObject({
			name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
			description: sdkText(4096),
			argumentHint: sdkText(1024),
			kind: z.enum(["command", "skill"]).optional(),
		}),
	)
	.max(128);

export async function openPaseoNativeSession({
	session,
	transport,
	model,
	hasConfirmedModelTurn,
	close,
	exited,
	beginCompact,
	prepareSelection,
}: SessionInput): Promise<
	NativeSession & { handleCancellationStreamLoss(): Promise<boolean> }
> {
	const id = session.runtimeSessionRef;
	const nativeId = `paseo:${id}`;
	if (session.nativeId !== undefined) {
		if (session.nativeId !== nativeId)
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
		await prepareSelection?.();
		if (session.nativeId !== nativeId || !(await transport.refetchAgent(id)))
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	} else await transport.ensureAgent(id);
	const lifetime = new AbortController();
	let retiring: Promise<void> | undefined;
	const retire = () => (retiring ??= Promise.resolve().then(close));
	void exited?.then(
		() => lifetime.abort(),
		() => lifetime.abort(),
	);
	let active: { messageId: string; text: string } | undefined;
	// A model connection may close before the daemon publishes the requested stop.
	let cancellation: "requested" | "interrupted" | "confirmed" | undefined;
	function recordCancellationTerminal(reason: string) {
		if (reason === "aborted" && cancellation) cancellation = "confirmed";
		else if (cancellation === "interrupted") throw unknown();
	}
	return {
		nativeId,
		supportsImagePrompt: false,
		...(beginCompact
			? ({
					async compact(commandSession, authority, onSubmit) {
						const signal = AbortSignal.any([
							authority.signal,
							lifetime.signal,
							AbortSignal.timeout(120_000),
						]);
						const assertCurrent = () => {
							signal.throwIfAborted();
							authority.assertCurrent();
						};
						assertCurrent();
						if (active || !commandSession.executionId) throw unknown();
						const before = await transport.timeline(id, {
							direction: "tail",
							limit: 1,
						});
						assertCurrent();
						if (
							before.agent?.activeTurn !== null ||
							!before.epoch ||
							before.error ||
							before.reset ||
							before.staleCursor ||
							before.gap ||
							before.hasNewer ||
							(before.entries.length > 0 && !before.endCursor)
						)
							throw unknown();
						const previous = before.endCursor?.seq ?? 0;
						const compactRequest = {
							messageId: commandSession.executionId,
							text: "/compact",
						};
						active = compactRequest;
						try {
							beginCompact(commandSession);
							await transport.send(
								id,
								commandSession.executionId,
								"/compact",
								() => {
									assertCurrent();
									onSubmit();
								},
							);
							await commandSession.admit();
							for (;;) {
								assertCurrent();
								const page = await transport.timeline(id, {
									direction: "tail",
									limit: 8,
								});
								assertCurrent();
								if (
									page.epoch !== before.epoch ||
									page.error ||
									page.reset ||
									page.staleCursor ||
									page.gap ||
									page.hasNewer
								)
									throw unknown();
								const rows = page.entries.filter(
									(row) => row.seqEnd > previous,
								);
								const [request, ...following] = rows;
								// Paseo appends informational notices after a completed compaction.
								const compactions = following.filter(
									(row) =>
										row.item.type !== "notification" ||
										(row.item.level !== "info" && row.item.level !== "warning"),
								);
								if (
									request &&
									(request.seqStart !== previous + 1 ||
										request.item.type !== "user_message" ||
										request.item.clientMessageId !==
											commandSession.executionId ||
										request.item.text !== "/compact")
								)
									throw unknown();
								if (
									compactions.some(
										(row) =>
											row.item.type !== "compaction" ||
											row.item.trigger !== "manual",
									)
								)
									throw unknown();
								const last = compactions.at(-1);
								if (
									last?.item.type === "compaction" &&
									last.item.status === "completed" &&
									page.agent?.activeTurn === null
								) {
									if (!hasConfirmedModelTurn()) throw unknown();
									await commandSession.update({
										type: "tool",
										payload: {
											toolCallId: commandSession.executionId,
											name: "native.compact",
											phase: "completed",
										},
									});
									return { stopReason: "stop" };
								}
								await delay(150, undefined, { signal });
							}
						} catch (error) {
							lifetime.abort();
							await retire().catch(() => {});
							throw error;
						} finally {
							if (active === compactRequest) active = undefined;
						}
					},
				} satisfies Pick<NativeSession, "compact">)
			: {}),
		async handleCancellationStreamLoss() {
			if (!cancellation) return false;
			if (cancellation === "requested") {
				cancellation = "interrupted";
				await session.notePendingCancellation?.();
			}
			return true;
		},
		async select(requested, effort) {
			if (
				requested !== model ||
				effort !== session.selection.reasoningLevel ||
				!(await transport.refetchAgent(id))
			)
				throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
		},
		async discoverCommands({ signal, expiresAt, revalidate }) {
			const remaining = expiresAt - Date.now();
			if (
				!Number.isSafeInteger(expiresAt) ||
				remaining <= 0 ||
				remaining > 2_147_483_647
			)
				throw new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
			const current = AbortSignal.any([
				signal,
				lifetime.signal,
				AbortSignal.timeout(remaining),
			]);
			try {
				current.throwIfAborted();
				const rows = await boundedRuntimeSkillRead({
					pending: transport.commands(id, current, revalidate),
					signal: current,
					expiresAt,
				});
				current.throwIfAborted();
				const commands = sdkCommands.parse(rows);
				if (
					Date.now() >= expiresAt ||
					new Set(commands.map((row) => row.name)).size !== commands.length ||
					Buffer.byteLength(JSON.stringify(commands)) > 30_000
				)
					throw new Error();
				return { nativeId, commands, readAt: Date.now() };
			} catch {
				throw new Error("RUNTIME_NATIVE_COMMAND_DIRECTORY_UNAVAILABLE");
			}
		},
		async setAutoCompaction(enabled, messageId, authority, onSubmit) {
			const signal = AbortSignal.any([
				authority.signal,
				lifetime.signal,
				AbortSignal.timeout(15_000),
			]);
			const assertCurrent = () => {
				signal.throwIfAborted();
				authority.assertCurrent();
			};
			const text = enabled ? "/autocompact on" : "/autocompact off";
			const confirmation = enabled
				? "Auto-compaction enabled."
				: "Auto-compaction disabled.";
			assertCurrent();
			if (active || !messageId) throw unknown();
			const before = await transport.timeline(id, {
				direction: "tail",
				limit: 1,
			});
			assertCurrent();
			if (
				before.agent?.activeTurn !== null ||
				!before.epoch ||
				before.error ||
				before.reset ||
				before.staleCursor ||
				before.gap ||
				before.hasNewer ||
				(before.entries.length > 0 && !before.endCursor)
			)
				throw unknown();
			const previous = before.endCursor?.seq ?? 0;
			await transport.send(id, messageId, text, () => {
				assertCurrent();
				onSubmit?.();
			});
			// Pi handles this command out of band. On the exclusive, idle daemon its
			// two ungrouped rows must immediately follow the pre-submit cursor.
			for (;;) {
				assertCurrent();
				const page = await transport.timeline(id, {
					direction: "tail",
					limit: 3,
				});
				assertCurrent();
				if (
					page.epoch !== before.epoch ||
					page.error ||
					page.reset ||
					page.staleCursor ||
					page.gap ||
					page.hasNewer ||
					page.agent?.activeTurn !== null
				)
					throw unknown();
				const rows = page.entries.filter((r) => r.seqEnd > previous);
				const [request, result] = rows;
				if (
					rows.length > 2 ||
					(request &&
						(request.seqStart !== previous + 1 ||
							request.seqEnd !== request.seqStart ||
							request.turnId ||
							request.item.type !== "user_message" ||
							request.item.clientMessageId !== messageId ||
							request.item.text !== text))
				)
					throw unknown();
				if (result) {
					if (
						!request ||
						result.seqStart !== previous + 2 ||
						result.seqEnd !== result.seqStart ||
						result.turnId ||
						result.item.type !== "assistant_message" ||
						result.item.text !== confirmation
					)
						throw unknown();
					return { stopReason: "stop" };
				}
				await delay(150, undefined, { signal });
			}
		},
		async prompt(input) {
			const prompt =
				typeof input === "string"
					? input
					: input.every((block) => block.type === "text")
						? input
								.map((block) => (block.type === "text" ? block.text : ""))
								.join("\n")
						: undefined;
			const messageId = session.executionId;
			if (
				active ||
				!messageId ||
				typeof prompt !== "string" ||
				(prompt.trimStart().startsWith("/") &&
					!(prompt === "/review" && session.openCodeReview))
			)
				throw unknown();
			lifetime.signal.throwIfAborted();
			cancellation = undefined;
			const request = { messageId, text: prompt };
			active = request;
			const terminals = new Map<string, "stop" | "aborted" | "error">();
			const observation = new AbortController();
			const events = new EventTarget();
			const signal = AbortSignal.any([lifetime.signal, observation.signal]);
			let sent = false;
			let timelineChanged = false;
			const shellPhases = new Map<string, "started" | "completed" | "failed">();
			let published = "";
			let boundTurn: string | undefined;
			let epoch: string | undefined;
			let unsubscribe: (() => Promise<void>) | undefined;
			try {
				unsubscribe = await transport.subscribe(id, ({ event }) => {
					if (
						event.type === "subscription_restored" ||
						event.type === "error" ||
						event.type === "replacement"
					) {
						observation.abort();
						return;
					}
					if (
						event.type === "timeline" &&
						(event.item.type === "assistant_message" ||
							(event.provider === "codex" &&
								event.item.type === "tool_call" &&
								event.item.detail.type === "shell"))
					) {
						timelineChanged = true;
						events.dispatchEvent(new Event("change"));
					}
					if (
						event.type === "turn_completed" ||
						event.type === "turn_canceled" ||
						event.type === "turn_failed"
					) {
						if (!event.turnId || terminals.size >= 32) {
							observation.abort();
							return;
						}
						terminals.set(
							event.turnId,
							event.type === "turn_completed"
								? "stop"
								: event.type === "turn_canceled"
									? "aborted"
									: "error",
						);
						events.dispatchEvent(new Event("change"));
					}
				});
				signal.throwIfAborted();
				const review = session.openCodeReview;
				if (review) {
					const { command, authority } = review;
					if (
						command.executionId !== messageId ||
						command.nativeSessionRef !== id ||
						prompt !== "/review"
					)
						throw unknown();
					const validate = async () => {
						await authority.revalidate();
					};
					const rows = await transport.commands(
						id,
						authority.signal,
						validate,
						true,
					);
					const commands = sdkCommands.parse(rows);
					const catalog = projectDiscoveredPaseoCommands({
						nativeSessionRef: id,
						nativeId,
						configVersion: session.modelFact?.()?.configVersion ?? "",
						directory: { nativeId, commands },
						openCodeReviewVersion: command.capabilitySourceVersion,
					});
					if (
						catalog.revision !== command.directoryRevision ||
						!catalog.capabilities.some(
							(row) => row.id === command.capabilityId && row.name === "review",
						)
					)
						throw unknown();
					await validate();
				}
				await transport.send(id, messageId, prompt, () => {
					review?.authority.assertCurrent();
					review?.onSubmit();
					sent = true;
				});
				// SDK notices wake the reader. Only a timeline page containing this
				// exact submission may supply text or identify its terminal stream event.
				for (;;) {
					signal.throwIfAborted();
					if (!timelineChanged && !terminals.size) {
						await once(events, "change", { signal });
						continue;
					}
					timelineChanged = false;
					// Terminal events arriving during refetch require a subsequent page.
					const observedTerminals = new Map(terminals);
					terminals.clear();
					const page = await transport.timeline(id, {
						direction: "tail",
						limit: 1,
						wholeTurns: true,
					});
					signal.throwIfAborted();
					if (
						page.gap ||
						page.reset ||
						page.staleCursor ||
						page.error ||
						page.hasNewer ||
						(epoch !== undefined && page.epoch !== epoch)
					)
						throw unknown();
					const matches = page.entries.filter(
						({ item }) =>
							item.type === "user_message" &&
							item.clientMessageId === messageId &&
							item.text === prompt,
					);
					if (!matches.length && !boundTurn && !observedTerminals.size)
						continue;
					const turnId = matches[0]?.turnId;
					if (
						matches.length !== 1 ||
						!turnId ||
						(boundTurn !== undefined && boundTurn !== turnId)
					)
						throw unknown();
					boundTurn = turnId;
					epoch = page.epoch;
					const status = observedTerminals.get(turnId);
					if (status === "stop" && !hasConfirmedModelTurn()) throw unknown();
					if (page.agent?.provider === "codex") {
						for (const row of page.entries) {
							const item = row.item;
							if (
								row.turnId !== turnId ||
								item.type !== "tool_call" ||
								item.name !== "shell" ||
								item.detail.type !== "shell" ||
								!item.callId
							)
								continue;
							const phase = shellPhase(item.status, item.detail.exitCode);
							if (!phase) continue;
							const toolCallId = createHash("sha256")
								.update(item.callId)
								.digest("hex");
							const previous = shellPhases.get(toolCallId);
							if (
								previous === phase ||
								(previous !== undefined && phase === "started")
							)
								continue;
							if (previous !== undefined && previous !== "started")
								throw unknown();
							if (shellPhases.size >= 4096 && !previous) throw unknown();
							shellPhases.set(toolCallId, phase);
							await session.recordToolOperation?.(toolCallId, "shell", phase);
							await session.update({
								type: "tool",
								payload: { toolCallId, name: "shell", phase },
							});
						}
					}
					const answer = page.entries
						.filter((row) => row.turnId === turnId)
						.map(({ item }) =>
							item.type === "assistant_message" ? item.text : "",
						)
						.join("");
					if (!answer.startsWith(published)) throw unknown();
					if (answer.length > published.length) {
						await session.update({
							type: "text",
							payload: { delta: answer.slice(published.length) },
						});
						published = answer;
					}
					if (status) {
						recordCancellationTerminal(status);
						return { stopReason: status };
					}
				}
			} catch (error) {
				if (sent) {
					await session.markUnknown?.();
					// A later timeline or thread conflict cannot undo an SDK submission.
					if (isPaseoSubmissionConflict(error)) throw unknown();
				} else if (
					!session.openCodeReview &&
					!isPaseoSubmissionConflict(error)
				) {
					await session.markUnknown?.();
				}
				throw error;
			} finally {
				active = undefined;
				await unsubscribe?.();
			}
		},
		async cancel() {
			// The private daemon is exclusive to this Session and is retired before another turn opens.
			const operation = active;
			if (!operation) {
				if (retiring) return retiring;
				throw unknown();
			}
			if (operation.text === "/compact") {
				const page = await transport.timeline(id, {
					direction: "tail",
					limit: 8,
				});
				if (
					active !== operation ||
					page.error ||
					page.gap ||
					page.staleCursor ||
					page.reset ||
					page.hasNewer ||
					!page.entries.some(
						({ item }) =>
							item.type === "user_message" &&
							item.clientMessageId === operation.messageId &&
							item.text === operation.text,
					)
				)
					throw unknown();
				try {
					await transport.cancel(id);
				} finally {
					lifetime.abort();
					await retire();
				}
				return;
			}
			const page = await transport.timeline(id, {
				direction: "tail",
				limit: 1,
				wholeTurns: true,
			});
			const current = page.agent?.activeTurn?.turnId;
			if (
				active !== operation ||
				!current ||
				page.error ||
				page.gap ||
				page.staleCursor ||
				page.reset ||
				page.hasNewer ||
				!page.entries.some(
					({ turnId, item }) =>
						turnId === current &&
						item.type === "user_message" &&
						item.clientMessageId === operation.messageId &&
						item.text === operation.text,
				)
			)
				throw unknown();
			cancellation ??= "requested";
			await transport.cancel(id);
		},
		async close() {
			lifetime.abort();
			await retire();
		},
	};
}
