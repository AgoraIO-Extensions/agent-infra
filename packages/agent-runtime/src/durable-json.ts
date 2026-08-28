import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export class DurableJsonFile<T> {
	private queue: Promise<void> = Promise.resolve();

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
		return structuredClone(this.state);
	}

	update<R>(change: (draft: T) => R | Promise<R>): Promise<R> {
		const run = this.queue.then(async () => {
			const draft = structuredClone(this.state);
			const result = await change(draft);
			await this.persist(draft);
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
