import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceSnapshotFileSpoolV1 } from "./workspace-snapshot-spool.js";

const directories: string[] = [];
async function fixture(maximumActiveSpools = 2) {
	const directory = await mkdtemp(join(tmpdir(), "snapshot-spool-test-"));
	directories.push(directory);
	return {
		directory,
		spool: createWorkspaceSnapshotFileSpoolV1({
			directory,
			maximumActiveSpools,
		}),
	};
}
function stream(chunks: Uint8Array[]) {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index++];
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
	});
}
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("workspace snapshot filesystem spool", () => {
	it("writes privately, replays exact independent bytes and disposes idempotently", async () => {
		const f = await fixture();
		const bytes = Buffer.alloc(256 * 1024, 73);
		const result = await f.spool.spool(
			stream([bytes.subarray(0, 17), bytes.subarray(17)]),
			bytes.length,
		);
		const [child] = await readdir(f.directory);
		expect(child).toBeDefined();
		const directory = join(f.directory, child ?? "");
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(join(directory, "archive.tar.gz"))).mode & 0o777).toBe(
			0o600,
		);
		expect(result.sizeBytes).toBe(bytes.length);
		for (let replay = 0; replay < 2; replay += 1)
			expect(
				Buffer.from(await new Response(result.replay()).arrayBuffer()),
			).toEqual(bytes);
		await Promise.all([result.dispose(), result.dispose()]);
		expect(await readdir(f.directory)).toEqual([]);
		expect(() => result.replay()).toThrow();
	});

	it("stops an oversized input and removes its partial file", async () => {
		const f = await fixture();
		let cancelled = false;
		const input = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(Buffer.alloc(64));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(f.spool.spool(input, 100)).rejects.toMatchObject({
			code: "limit_exceeded",
		});
		expect(cancelled).toBe(true);
		expect(await readdir(f.directory)).toEqual([]);
	});

	it("aborts a stalled request without retaining the open writer or spool slot", async () => {
		const f = await fixture(1);
		const abort = new AbortController();
		let cancelled = false;
		let ready: () => void = () => {};
		const pulling = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const input = new ReadableStream<Uint8Array>({
			pull() {
				ready();
			},
			cancel() {
				cancelled = true;
			},
		});
		const pending = f.spool.spool(input, 100, { signal: abort.signal });
		await pulling;
		abort.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(cancelled).toBe(true);
		expect(await readdir(f.directory)).toEqual([]);
		const next = await f.spool.spool(stream([Buffer.from("next")]), 100);
		await next.dispose();
	});

	it("bounds retained temporary files until disposal releases a slot", async () => {
		const f = await fixture(1);
		const first = await f.spool.spool(stream([Buffer.from("a")]), 100);
		await expect(
			f.spool.spool(stream([Buffer.from("b")]), 100),
		).rejects.toMatchObject({ code: "busy" });
		expect(await readdir(f.directory)).toHaveLength(1);
		await first.dispose();
		const second = await f.spool.spool(stream([Buffer.from("c")]), 100);
		await second.dispose();
	});

	it("cleans empty input and reports bounded filesystem errors", async () => {
		const f = await fixture();
		await expect(f.spool.spool(stream([]), 100)).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(await readdir(f.directory)).toEqual([]);
		const unavailable = createWorkspaceSnapshotFileSpoolV1({
			directory: join(f.directory, "missing-private-directory"),
		});
		await expect(
			unavailable.spool(stream([Buffer.from("a")]), 100),
		).rejects.toMatchObject({
			message: "Workspace snapshot spool unavailable",
		});
	});
});
