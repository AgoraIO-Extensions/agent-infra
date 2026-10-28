import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	open,
	readlink,
	rename,
	rmdir,
	symlink,
	unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { privateBytes, privateJson } from "./private-input.ts";

const hash = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const pending = (identityFile: string) => `${identityFile}.promotion`;
const absent = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";
type Entry = {
	file: string;
	before: string | null;
	after: string;
	staged: string;
	backup: string;
	displaced: string;
};
type Journal = {
	schemaVersion: 1;
	generation: string;
	hostname: string;
	pid: number;
	entries: Entry[];
};
type Operations = {
	rename: typeof rename;
	link: typeof link;
	open?: typeof open;
	symlink?: typeof symlink;
};
const operations: Operations = { rename, link };

export async function loginOutputBytes(file: string): Promise<Buffer | null> {
	assert(
		typeof file === "string" && isAbsolute(file) && resolve(file) === file,
	);
	const parent = await lstat(dirname(file));
	assert(
		parent.isDirectory() &&
			!parent.isSymbolicLink() &&
			parent.uid === process.getuid?.() &&
			(parent.mode & 0o077) === 0,
	);
	let insideGit = false;
	try {
		insideGit =
			execFileSync(
				"git",
				["-C", dirname(file), "rev-parse", "--is-inside-work-tree"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			).trim() === "true";
	} catch {}
	assert(!insideGit, "LOGIN_OUTPUT_INSIDE_WORKTREE");
	try {
		return await privateBytes(file);
	} catch (error) {
		if (absent(error)) return null;
		throw error;
	}
}
async function exists(file: string) {
	try {
		await lstat(file);
		return true;
	} catch (error) {
		if (absent(error)) return false;
		throw error;
	}
}
async function durable(file: string, bytes: string | Buffer, create = open) {
	const handle = await create(file, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function remove(file: string) {
	await unlink(file).catch((error) => {
		if (!absent(error)) throw error;
	});
}

export async function assertLoginOutputsCommitted(identityFile: string) {
	assert(
		!(await exists(pending(identityFile))),
		"LOGIN_OUTPUT_PROMOTION_INCOMPLETE",
	);
}

async function rollback(journal: Journal, io: Operations) {
	let conflict = false;
	for (const entry of [...journal.entries].reverse()) {
		try {
			let current = await loginOutputBytes(entry.file);
			const backup = await loginOutputBytes(entry.backup);
			// Never restore a backup whose bytes no longer match the original snapshot.
			assert(
				backup === null || hash(backup) === entry.before,
				"LOGIN_OUTPUT_RECOVERY_CONFLICT",
			);
			const displaced = await loginOutputBytes(entry.displaced);
			if (!backup && current && hash(current) === entry.before && !displaced) {
				await remove(entry.staged);
				continue;
			}
			// A previous recovery may have been interrupted after moving an output away.
			if (displaced && hash(displaced) !== entry.after) {
				if (current === null) {
					await io.link(entry.displaced, entry.file);
					current = displaced;
				}
				conflict = true;
				continue;
			}
			if (current && hash(current) === entry.after) {
				assert(!displaced, "LOGIN_OUTPUT_RECOVERY_CONFLICT");
				await io.rename(entry.file, entry.displaced);
				const moved = await privateBytes(entry.displaced);
				if (hash(moved) !== entry.after) {
					await io.link(entry.displaced, entry.file);
					conflict = true;
					continue;
				}
				current = null;
			}
			if (backup) {
				if (current === null) {
					await io.link(entry.backup, entry.file);
					current = await loginOutputBytes(entry.file);
				}
				if (!current || !current.equals(backup)) {
					conflict = true;
					continue;
				}
			} else if (entry.before !== null) {
				if (!current || hash(current) !== entry.before) {
					conflict = true;
					continue;
				}
			} else if (current !== null) {
				conflict = true;
				continue;
			}
			// Only unlink our private copies once the destination was restored/read back.
			if (!conflict) {
				await remove(entry.displaced);
				await remove(entry.backup);
				await remove(entry.staged);
			}
		} catch {
			conflict = true;
		}
	}
	assert(!conflict, "LOGIN_OUTPUT_RECOVERY_REQUIRED");
}

async function journalDirectory(identityFile: string) {
	await loginOutputBytes(identityFile);
	const gate = pending(identityFile);
	const gateMetadata = await lstat(gate);
	assert.equal(gateMetadata.uid, process.getuid?.());
	const directory = gateMetadata.isSymbolicLink() ? await readlink(gate) : gate;
	if (directory !== gate) {
		assert(
			directory.startsWith(`${gate}.`) &&
				/^[a-f0-9-]{36}\.prepared$/u.test(directory.slice(gate.length + 1)),
			"LOGIN_OUTPUT_RECOVERY_CONFLICT",
		);
	}
	const metadata = await lstat(directory);
	assert(
		metadata.isDirectory() &&
			!metadata.isSymbolicLink() &&
			metadata.uid === process.getuid?.() &&
			(metadata.mode & 0o077) === 0,
	);
	return directory;
}

async function cleanJournal(identityFile: string, journal: Journal) {
	const directory = await journalDirectory(identityFile);
	assert(
		directory === pending(identityFile) ||
			directory === `${pending(identityFile)}.${journal.generation}.prepared`,
	);
	for (const entry of journal.entries) {
		await remove(entry.backup);
		await remove(entry.staged);
		await remove(entry.displaced);
	}
	// Atomically release the gate only after recovery/commit and backup retirement.
	const retired = `${pending(identityFile)}.${journal.generation}.retired`;
	await rename(pending(identityFile), retired);
	const contents = directory === pending(identityFile) ? retired : directory;
	await remove(join(contents, "committed"));
	await remove(join(contents, "commit.next"));
	await remove(join(contents, "journal.json"));
	await rmdir(contents);
	if (contents !== retired) await remove(retired);
}

/** Explicit recovery only, and never while the originating local process may still run. */
export async function recoverLoginOutputs(
	identityFile: string,
	declaredFiles: readonly string[],
	io = operations,
) {
	const directory = await journalDirectory(identityFile);
	const journal: Journal = await privateJson(join(directory, "journal.json"));
	assert(
		journal.schemaVersion === 1 &&
			/^[a-f0-9-]{36}$/u.test(journal.generation) &&
			journal.hostname === hostname() &&
			Number.isSafeInteger(journal.pid) &&
			journal.pid > 1,
	);
	assert(
		directory === pending(identityFile) ||
			directory === `${pending(identityFile)}.${journal.generation}.prepared`,
	);
	let dead = false;
	try {
		process.kill(journal.pid, 0);
	} catch (error) {
		dead = (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	assert(dead, "LOGIN_OUTPUT_WRITER_NOT_RETIRED");
	assert(
		Array.isArray(journal.entries) &&
			journal.entries.length === declaredFiles.length &&
			new Set(journal.entries.map((e) => e.file)).size === declaredFiles.length,
	);
	for (const entry of journal.entries) {
		assert(declaredFiles.includes(entry.file));
		assert(
			entry.staged === `${entry.file}.${journal.generation}.next` &&
				entry.backup === `${entry.file}.${journal.generation}.before` &&
				entry.displaced === `${entry.file}.${journal.generation}.rollback`,
		);
		assert(
			(entry.before === null || /^[a-f0-9]{64}$/u.test(entry.before)) &&
				/^[a-f0-9]{64}$/u.test(entry.after),
		);
	}
	if (await exists(join(directory, "committed"))) {
		assert.equal(
			(await privateBytes(join(directory, "committed"))).toString(),
			journal.generation,
		);
		for (const entry of journal.entries)
			assert.equal(
				hash(await privateBytes(entry.file)),
				entry.after,
				"LOGIN_OUTPUT_RECOVERY_CONFLICT",
			);
	} else await rollback(journal, io);
	await cleanJournal(identityFile, journal);
}

/** Marker is the commit gate; links publish without clobbering a concurrent creator. */
export async function promoteLoginOutputs(
	identityFile: string,
	before: Map<string, Buffer | null>,
	outputs: Map<string, unknown>,
	io = operations,
) {
	assert(outputs.size > 0 && outputs.size <= 25 && outputs.has(identityFile));
	assert(
		outputs.size === before.size &&
			[...outputs.keys()].every((file) => before.has(file)),
	);
	const generation = randomUUID();
	const journal: Journal = {
		schemaVersion: 1,
		generation,
		hostname: hostname(),
		pid: process.pid,
		entries: [...outputs].map(([file, value]) => ({
			file,
			before: before.get(file) === null ? null : hash(before.get(file)!),
			after: hash(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)),
			staged: `${file}.${generation}.next`,
			backup: `${file}.${generation}.before`,
			displaced: `${file}.${generation}.rollback`,
		})),
	};
	for (const entry of journal.entries)
		assert.deepEqual(
			await loginOutputBytes(entry.file),
			before.get(entry.file),
			"LOGIN_OUTPUT_CHANGED",
		);
	const prepared = `${pending(identityFile)}.${generation}.prepared`;
	await mkdir(prepared, { mode: 0o700 });
	try {
		await durable(
			join(prepared, "journal.json"),
			`${JSON.stringify(journal)}\n`,
			io.open,
		);
		// symlink is an atomic exclusive publish, even against an old empty gate.
		await (io.symlink ?? symlink)(prepared, pending(identityFile));
	} catch (error) {
		await remove(join(prepared, "journal.json"));
		await rmdir(prepared);
		throw error;
	}
	try {
		for (const entry of journal.entries)
			await durable(
				entry.staged,
				`${JSON.stringify(outputs.get(entry.file), null, 2)}\n`,
			);
		for (const entry of journal.entries) {
			assert.deepEqual(
				await loginOutputBytes(entry.file),
				before.get(entry.file),
				"LOGIN_OUTPUT_CHANGED",
			);
			if (entry.before !== null) {
				assert(!(await exists(entry.backup)));
				await io.rename(entry.file, entry.backup);
				assert.equal(
					hash(await privateBytes(entry.backup)),
					entry.before,
					"LOGIN_OUTPUT_CHANGED",
				);
			}
			await io.link(entry.staged, entry.file);
		}
		for (const entry of journal.entries)
			assert.equal(
				hash(await privateBytes(entry.file)),
				entry.after,
				"LOGIN_OUTPUT_CHANGED",
			);
	} catch (error) {
		await rollback(journal, io);
		await cleanJournal(identityFile, journal);
		throw error;
	}
	// The durable commit distinguishes cleanup interruption from an incomplete promotion.
	const commitTemporary = join(prepared, "commit.next");
	await durable(commitTemporary, generation, io.open);
	await io.link(commitTemporary, join(prepared, "committed"));
	await remove(commitTemporary);
	// Once every output is verified, backups can be retired while the gate stays shut.
	await cleanJournal(identityFile, journal);
}
