import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRuntimeStore } from "@agent-infra/agent-runtime";
import { RuntimeLegacyMigrationError } from "./legacy-migration.js";

const maximumJournalBytes = 64 * 1024 * 1024;

export async function readRuntimeLegacyJournal(path: string) {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await file.stat();
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.size < 1 ||
				stat.size > maximumJournalBytes
			)
				throw new RuntimeLegacyMigrationError();
			const bytes = await file.readFile();
			if (bytes.length > maximumJournalBytes)
				throw new RuntimeLegacyMigrationError();
			return { bytes, stat };
		} finally {
			await file.close();
		}
	} catch {
		throw new RuntimeLegacyMigrationError();
	}
}

/** Store startup recovery and complete-set validation touch only this private copy. */
export async function previewRuntimeLegacyMigration(
	bytes: Buffer,
	migration: {
		apply(
			store: Pick<FileRuntimeStore, "migrateLegacyPrincipal">,
		): Promise<void>;
	},
) {
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "runtime-legacy-"));
		const path = join(directory, "host.json");
		await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
		const store = await FileRuntimeStore.open(path);
		try {
			await migration.apply(store);
		} finally {
			await store.close();
		}
		return await readFile(path);
	} catch {
		throw new RuntimeLegacyMigrationError();
	} finally {
		try {
			if (directory) await rm(directory, { recursive: true, force: true });
		} catch {
			console.warn(
				JSON.stringify({
					service: "agent-runtime-host",
					code: "RUNTIME_LEGACY_MIGRATION_TEMP_CLEANUP_FAILED",
				}),
			);
		}
	}
}
