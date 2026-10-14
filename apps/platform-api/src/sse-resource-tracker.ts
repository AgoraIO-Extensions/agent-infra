export interface SseResourceSnapshot {
	readonly connections: number;
	readonly pendingEvents: number;
}

interface PendingHandle {
	close(): void;
}

/** Process-local counters for live SSE streams and writes in flight. */
export class SseResourceTracker {
	#connections = 0;
	#pendingEvents = 0;

	open(): PendingHandle {
		this.#connections++;
		let closed = false;
		return {
			close: () => {
				if (closed) return;
				closed = true;
				this.#connections = Math.max(0, this.#connections - 1);
			},
		};
	}

	beginPending(): PendingHandle {
		this.#pendingEvents++;
		let closed = false;
		return {
			close: () => {
				if (closed) return;
				closed = true;
				this.#pendingEvents = Math.max(0, this.#pendingEvents - 1);
			},
		};
	}

	snapshot(): SseResourceSnapshot {
		return {
			connections: this.#connections,
			pendingEvents: this.#pendingEvents,
		};
	}
}
