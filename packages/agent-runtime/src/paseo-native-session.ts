import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { PaseoTransport } from "./paseo-transport.js";
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
};

const unknown = () => new Error("RUNTIME_ACCEPTANCE_UNKNOWN");

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
}: SessionInput): Promise<
	NativeSession & { confirmPendingCancellation(): Promise<boolean> }
> {
	const id = session.runtimeSessionRef;
	const nativeId = `paseo:${id}`;
	if (session.nativeId !== undefined) {
		if (session.nativeId !== nativeId || !(await transport.refetchAgent(id)))
			throw new Error("RUNTIME_NATIVE_SESSION_UNAVAILABLE");
	} else await transport.ensureAgent(id);
	const lifetime = new AbortController();
	void exited?.then(
		() => lifetime.abort(),
		() => lifetime.abort(),
	);
	let active: { messageId: string; text: string } | undefined;
	// A model connection may close before the daemon publishes the requested stop.
	let cancellation:
		| ReturnType<typeof Promise.withResolvers<boolean>>
		| undefined;
	const finishCancellation = (aborted: boolean) =>
		cancellation?.resolve(aborted);
	return {
		nativeId,
		supportsImagePrompt: false,
		async confirmPendingCancellation() {
			if (!cancellation) return false;
			return Promise.race([
				cancellation.promise,
				delay(2000, false, { ref: false }),
			]);
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
		async prompt(prompt) {
			const messageId = session.executionId;
			if (
				active ||
				!messageId ||
				typeof prompt !== "string" ||
				prompt.trimStart().startsWith("/")
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
			let textChanged = false;
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
						event.item.type === "assistant_message"
					) {
						textChanged = true;
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
				await transport.send(id, messageId, prompt);
				// SDK notices wake the reader. Only a timeline page containing this
				// exact submission may supply text or identify its terminal stream event.
				for (;;) {
					signal.throwIfAborted();
					if (!textChanged && !terminals.size) {
						await once(events, "change", { signal });
						continue;
					}
					textChanged = false;
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
						finishCancellation(status === "aborted");
						return { stopReason: status };
					}
				}
			} catch (error) {
				await session.markUnknown?.();
				throw error;
			} finally {
				finishCancellation(false);
				active = undefined;
				await unsubscribe?.();
			}
		},
		async cancel() {
			// The private daemon is exclusive to this Session and is retired before another turn opens.
			const operation = active;
			if (!operation) throw unknown();
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
			cancellation ??= Promise.withResolvers<boolean>();
			try {
				await transport.cancel(id);
			} catch (error) {
				cancellation.resolve(false);
				throw error;
			}
		},
		async close() {
			finishCancellation(false);
			lifetime.abort();
			await close();
		},
	};
}
