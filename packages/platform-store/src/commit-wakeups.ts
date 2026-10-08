import postgres from "postgres";

/** Raised after a committed outbox item becomes available; carries no payload. */
export const outboxWakeChannelV1 = "agent_infra_outbox_available";
/** Raised after a committed Conversation event; carries only the Conversation id. */
export const conversationEventWakeChannelV1 = "agent_infra_conversation_event";

/**
 * Listens to one commit wakeup channel on a dedicated connection. A wakeup is
 * only a hint to read durable state sooner: callers keep their polling and all
 * claim, cursor and authorization checks (Spec §8.2, §10.2).
 */
export class PostgresCommitWakeupListenerV1 {
	readonly #client: ReturnType<typeof postgres>;
	readonly #channel: string;
	readonly #onWake: (payload: string) => void;
	#listening: Promise<{ unlisten(): Promise<void> }> | undefined;

	constructor(options: {
		readonly databaseUrl: string;
		readonly channel:
			| typeof outboxWakeChannelV1
			| typeof conversationEventWakeChannelV1;
		readonly onWake: (payload: string) => void;
	}) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#channel = options.channel;
		this.#onWake = options.onWake;
	}

	/** Resolves once LISTEN is active; postgres.js re-listens after reconnects. */
	async start(): Promise<void> {
		this.#listening ??= this.#client.listen(this.#channel, (payload) => {
			try {
				this.#onWake(payload);
			} catch {
				// A wakeup consumer failure must not stop later wakeups.
			}
		});
		await this.#listening;
	}

	async close(): Promise<void> {
		const listening = this.#listening;
		this.#listening = undefined;
		try {
			if (listening) await (await listening).unlisten();
		} catch {
			// The connection is closed below either way.
		}
		await this.#client.end({ timeout: 5 });
	}
}

export interface ConversationEventWatcherV1 {
	/** Resolves with "woken" after a committed event of this Conversation, or
	 * with "timeout" after `timeoutMs`; a wakeup that arrives between waits is
	 * kept for the next wait. Rejects only when `signal` aborts. */
	wait(timeoutMs: number, signal: AbortSignal): Promise<"woken" | "timeout">;
	close(): void;
}

/** In-process fan-out of Conversation event wakeups to open streams. */
export class ConversationEventWakeHubV1 {
	readonly #watchers = new Map<string, Set<Watcher>>();

	/** Called with the Conversation id carried by a committed event wakeup. */
	notify(conversationId: string): void {
		for (const watcher of this.#watchers.get(conversationId) ?? [])
			watcher.wake();
	}

	/** The first wait returns at once so events committed before the watch
	 * started are read without waiting for the poll interval. */
	watch(conversationId: string): ConversationEventWatcherV1 {
		const watcher = new Watcher(() => {
			const set = this.#watchers.get(conversationId);
			set?.delete(watcher);
			if (set?.size === 0) this.#watchers.delete(conversationId);
		});
		const set = this.#watchers.get(conversationId) ?? new Set<Watcher>();
		set.add(watcher);
		this.#watchers.set(conversationId, set);
		return watcher;
	}

	get watchedConversations(): number {
		return this.#watchers.size;
	}
}

class Watcher implements ConversationEventWatcherV1 {
	#pending = true;
	#resolve: (() => void) | undefined;
	readonly #release: () => void;

	constructor(release: () => void) {
		this.#release = release;
	}

	wake() {
		this.#pending = true;
		this.#resolve?.();
	}

	async wait(
		timeoutMs: number,
		signal: AbortSignal,
	): Promise<"woken" | "timeout"> {
		signal.throwIfAborted();
		if (this.#pending) {
			this.#pending = false;
			return "woken";
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<"woken" | "timeout">((resolve, reject) => {
				this.#resolve = () => resolve("woken");
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
		} finally {
			this.#resolve = undefined;
			this.#pending = false;
			clearTimeout(timer);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	close() {
		this.#resolve = undefined;
		this.#release();
	}
}
