import { once } from "node:events";
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
}: SessionInput): Promise<NativeSession> {
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
	return {
		nativeId,
		supportsImagePrompt: false,
		async select(requested, effort) {
			if (
				requested !== model ||
				effort !== session.selection.reasoningLevel ||
				!(await transport.refetchAgent(id))
			)
				throw new Error("RUNTIME_MODEL_SELECTION_UNSUPPORTED");
		},
		async discoverCommands({ signal, expiresAt }) {
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
					pending: transport.commands(id, current),
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
			const request = { messageId, text: prompt };
			active = request;
			const terminals = new Map<string, "stop" | "aborted" | "error">();
			const observation = new AbortController();
			const events = new EventTarget();
			const signal = AbortSignal.any([lifetime.signal, observation.signal]);
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
						events.dispatchEvent(new Event("terminal"));
					}
				});
				signal.throwIfAborted();
				await transport.send(id, messageId, prompt);
				// The ACK has no turn ID. Bind a stream terminal to the SDK's accepted
				// user row; timeline snapshots alone carry no terminal receipt.
				for (;;) {
					signal.throwIfAborted();
					if (terminals.size) {
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
							page.hasNewer
						)
							throw unknown();
						const matches = page.entries.filter(
							({ item }) =>
								item.type === "user_message" &&
								item.clientMessageId === messageId &&
								item.text === prompt,
						);
						if (matches.length !== 1 || !matches[0]?.turnId) throw unknown();
						const turnId = matches[0].turnId;
						const status = terminals.get(turnId);
						if (status) {
							if (status === "stop") {
								if (!hasConfirmedModelTurn()) throw unknown();
								const rows = page.entries.filter(
									(row) =>
										row.turnId === turnId &&
										row.item.type === "assistant_message",
								);
								for (const row of rows)
									if (row.item.type === "assistant_message")
										await session.update({
											type: "text",
											payload: { delta: row.item.text },
										});
							}
							return { stopReason: status };
						}
						terminals.clear();
					}
					if (!terminals.size) await once(events, "terminal", { signal });
				}
			} catch (error) {
				await session.markUnknown?.();
				throw error;
			} finally {
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
			await transport.cancel(id);
		},
		async close() {
			lifetime.abort();
			await close();
		},
	};
}
