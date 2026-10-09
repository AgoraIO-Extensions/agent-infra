import {
	type FileHandle,
	mkdtemp,
	open,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
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

it("close drains accepted updates and rejects writes queued during and after shutdown", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-close-"));
	directories.push(directory);
	const path = join(directory, "state.json");
	const file = await DurableJsonFile.open(path, { count: 0 });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const writing = file.update(async (draft) => {
		entered.resolve();
		await release.promise;
		draft.count = 1;
	});
	await entered.promise;
	let closed = false;
	const closing = file.close().then(() => {
		closed = true;
	});
	const rejectedChange = vi.fn();
	await expect(file.update(rejectedChange)).rejects.toThrow(
		"Durable state is closed",
	);
	expect(closed).toBe(false);
	release.resolve();
	await writing;
	await closing;
	await expect(file.update(rejectedChange)).rejects.toThrow(
		"Durable state is closed",
	);
	await file.close();
	expect(rejectedChange).not.toHaveBeenCalled();
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ count: 1 });
});

it("serves one frozen copy per committed version instead of a copy per read (#1637)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-snapshot-"));
	directories.push(directory);
	const file = await DurableJsonFile.open(join(directory, "state.json"), {
		events: [{ cursor: "c1" }],
	});
	const clone = vi.spyOn(globalThis, "structuredClone");
	const first = file.snapshot();
	expect(file.snapshot()).toBe(first);
	expect(file.snapshot()).toBe(first);
	expect(clone).toHaveBeenCalledTimes(1);
	expect(Object.isFrozen(first.events[0])).toBe(true);
	expect(() => {
		(first.events as { cursor: string }[]).push({ cursor: "c2" });
	}).toThrow(TypeError);
	clone.mockRestore();
	// read() still returns a private, mutable copy, and an update's own draft
	// and result are never frozen.
	const copy = file.read();
	copy.events.push({ cursor: "local" });
	expect(file.snapshot().events).toEqual([{ cursor: "c1" }]);
	const events = await file.update((draft) => {
		draft.events.push({ cursor: "c2" });
		return draft.events;
	});
	expect(Object.isFrozen(events)).toBe(false);
	const next = file.snapshot();
	expect(next).not.toBe(first);
	expect(next.events).toEqual([{ cursor: "c1" }, { cursor: "c2" }]);
	expect(first.events).toEqual([{ cursor: "c1" }]);
	expect(Object.isFrozen(events)).toBe(false);
});

it("refuses a snapshot once persistence has failed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-snapshot-"));
	directories.push(directory);
	const file = await DurableJsonFile.open(join(directory, "state.json"), {
		fact: "initial",
	});
	const handle = await open(directory, "r");
	const prototype = Object.getPrototypeOf(handle) as FileHandle;
	await handle.close();
	vi.spyOn(prototype, "sync").mockRejectedValue(
		new Error("synthetic fsync failure"),
	);
	await expect(
		file.update((draft) => {
			draft.fact = "unconfirmed";
		}),
	).rejects.toThrow("fsync failure");
	expect(() => file.snapshot()).toThrow("requires recovery");
});

it("keeps an unchanged opt-in update in write order without rewriting the file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-durable-unchanged-"));
	directories.push(directory);
	const path = join(directory, "state.json");
	const file = await DurableJsonFile.open(path, { revoked: false });
	const inode = async () => (await stat(path)).ino;
	const before = await inode();
	const release = Promise.withResolvers<void>();
	const revoking = file.update(async (draft) => {
		await release.promise;
		draft.revoked = true;
	});
	// Queued behind the revocation, the check observes it and writes nothing new.
	let observed: boolean | undefined;
	const checking = file.update(
		(draft) => {
			observed = draft.revoked;
		},
		{ skipUnchanged: true },
	);
	release.resolve();
	await revoking;
	const revoked = await inode();
	expect(revoked).not.toBe(before);
	await checking;
	expect(observed).toBe(true);
	expect(await inode()).toBe(revoked);
	// A change still persists under the same option.
	await file.update(
		(draft) => {
			draft.revoked = false;
		},
		{ skipUnchanged: true },
	);
	expect(await inode()).not.toBe(revoked);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ revoked: false });
	// Without the option every update still rewrites the file.
	const unchanged = await inode();
	await file.update(() => undefined);
	expect(await inode()).not.toBe(unchanged);
});
