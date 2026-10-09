import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** Freezes every reachable object without recursion depth limits. */
function deepFreeze(value: unknown) {
	const pending = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (next === null || typeof next !== "object" || Object.isFrozen(next))
			continue;
		Object.freeze(next);
		for (const child of Object.values(next)) pending.push(child);
	}
}

export class DurableJsonFile<T> {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private closePromise: Promise<void> | undefined;
	private persistenceFailed = false;
	/** The frozen copy of the committed state, until the next commit replaces it. */
	private frozen: T | undefined;
	/** The committed state as last written, kept once an unchanged check needs it. */
	private committed: string | undefined;

	private constructor(
		private readonly path: string,
		private state: T,
	) {}

	static async open<T>(path: string, initialState: T) {
		await mkdir(dirname(path), { recursive: true });
		const state = await readFile(path, "utf8").then(
			(value) => JSON.parse(value) as T,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return structuredClone(initialState);
				throw error;
			},
		);
		const file = new DurableJsonFile(path, state);
		if (!(await file.exists())) await file.persist(JSON.stringify(state));
		return file;
	}

	read() {
		if (this.persistenceFailed)
			throw new Error("Durable state requires recovery");
		return structuredClone(this.state);
	}

	/**
	 * A frozen copy of the committed state for callers that only look values up.
	 * It is copied once per committed version and shared until the next commit,
	 * so a reader no longer copies the whole state on every read (#1637). The
	 * committed objects themselves stay unfrozen for existing holders.
	 */
	snapshot(): T {
		if (this.persistenceFailed)
			throw new Error("Durable state requires recovery");
		if (this.frozen === undefined) {
			const copy = structuredClone(this.state);
			deepFreeze(copy);
			this.frozen = copy;
		}
		return this.frozen;
	}

	async readCommitted() {
		// Observe all mutations already queued by this caller's read boundary.
		// This joins persistence without taking a lock across a Driver callback.
		await this.queue;
		return this.read();
	}

	update<R>(
		change: (draft: T) => R | Promise<R>,
		options: {
			/** Skip the rewrite when the change left the committed state as it was. */
			readonly skipUnchanged?: boolean;
		} = {},
	): Promise<R> {
		if (this.closed)
			return Promise.reject(new Error("Durable state is closed"));
		const run = this.queue.then(async () => {
			if (this.persistenceFailed)
				throw new Error("Durable state requires recovery");
			const draft = structuredClone(this.state);
			const result = await change(draft);
			const serialized = JSON.stringify(draft);
			// Memory equals disk until a failed persist poisons this file, so an
			// unchanged state is already durable. The update keeps its place in
			// the write order, and the committed state and its snapshot stay.
			if (options.skipUnchanged) {
				this.committed ??= JSON.stringify(this.state);
				if (serialized === this.committed) return result;
			}
			try {
				await this.persist(serialized);
			} catch (error) {
				// Rename may have succeeded before a directory fsync/close failed. The
				// disk can be ahead of memory; only a fresh open may recover that state.
				this.persistenceFailed = true;
				throw error;
			}
			this.state = draft;
			this.committed = serialized;
			this.frozen = undefined;
			return result;
		});
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closed = true;
			this.closePromise = this.queue;
		}
		return this.closePromise;
	}

	private async exists() {
		return readFile(this.path).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
	}

	private async persist(serialized: string) {
		const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
		const file = await open(temporaryPath, "wx", 0o600);
		try {
			await file.writeFile(`${serialized}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, this.path);
		const directory = await open(dirname(this.path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
}
