import { type FileHandle, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DurableJsonFile } from "./durable-json.js";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

it("refuses stale writes after rename succeeds and directory fsync fails; fresh open recovers the disk", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-json-"));
	directories.push(directory);
	const path = join(directory, "state.json");
	const file = await DurableJsonFile.open(path, { fact: "initial" });
	const handle = await open(directory, "r");
	const prototype = Object.getPrototypeOf(handle) as FileHandle;
	await handle.close();
	const sync = prototype.sync;
	const failure = vi
		.spyOn(prototype, "sync")
		.mockImplementation(async function (this: FileHandle) {
			if ((await this.stat()).isDirectory())
				throw new Error("synthetic directory fsync failure");
			return sync.call(this);
		});
	await expect(
		file.update((draft) => {
			draft.fact = "committed-on-disk";
		}),
	).rejects.toThrow("fsync failure");
	failure.mockRestore();
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		fact: "committed-on-disk",
	});
	expect(() => file.read()).toThrow("requires recovery");
	await expect(
		file.update((draft) => {
			draft.fact = "stale overwrite";
		}),
	).rejects.toThrow("requires recovery");
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		fact: "committed-on-disk",
	});
	const recovered = await DurableJsonFile.open(path, {
		fact: "must not reset",
	});
	expect(recovered.read()).toEqual({ fact: "committed-on-disk" });
	await recovered.update((draft) => {
		draft.fact = "confirmed after recovery";
	});
});

it("does not poison storage for a rejected mutation before persistence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-json-"));
	directories.push(directory);
	const file = await DurableJsonFile.open(join(directory, "state.json"), {
		count: 0,
	});
	await expect(
		file.update(() => {
			throw new Error("business conflict");
		}),
	).rejects.toThrow("business conflict");
	await file.update((draft) => {
		draft.count += 1;
	});
	expect(file.read()).toEqual({ count: 1 });
});

it("committed reads wait for an already queued authorization barrier", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-json-"));
	directories.push(directory);
	const file = await DurableJsonFile.open(join(directory, "state.json"), {
		revoked: false,
	});
	const release = Promise.withResolvers<void>();
	const writing = file.update(async (draft) => {
		await release.promise;
		draft.revoked = true;
	});
	let readResolved = false;
	const snapshot = file.readCommitted().then((value) => {
		readResolved = true;
		return value;
	});
	await Promise.resolve();
	expect(readResolved).toBe(false);
	release.resolve();
	await writing;
	expect(await snapshot).toEqual({ revoked: true });
});
