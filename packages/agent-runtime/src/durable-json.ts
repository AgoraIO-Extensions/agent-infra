import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export class DurableJsonFile<T> {
	private queue: Promise<void> = Promise.resolve();
	private persistenceFailed = false;

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
		if (!(await file.exists())) await file.persist(state);
		return file;
	}

	read() {
		if (this.persistenceFailed)
			throw new Error("Durable state requires recovery");
		return structuredClone(this.state);
	}

	async readCommitted() {
		// Observe all mutations already queued by this caller's read boundary.
		// This joins persistence without taking a lock across a Driver callback.
		await this.queue;
		return this.read();
	}

	async close() {
		await this.queue;
	}

	update<R>(change: (draft: T) => R | Promise<R>): Promise<R> {
		const run = this.queue.then(async () => {
			if (this.persistenceFailed)
				throw new Error("Durable state requires recovery");
			const draft = structuredClone(this.state);
			const result = await change(draft);
			try {
				await this.persist(draft);
			} catch (error) {
				// Rename may have succeeded before a directory fsync/close failed. The
				// disk can be ahead of memory; only a fresh open may recover that state.
				this.persistenceFailed = true;
				throw error;
			}
			this.state = draft;
			return result;
		});
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
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

	private async persist(state: T) {
		const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
		const file = await open(temporaryPath, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
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
