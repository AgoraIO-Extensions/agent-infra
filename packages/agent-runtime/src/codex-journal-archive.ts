import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

/**
 * Index entry of one finished Turn journal moved out of the hot Driver state
 * (#1705). The journal itself is written once to its own file before this
 * entry is committed; the entry pins its exact bytes and event range.
 */
export interface CodexArchivedJournalV1 {
	sha256: string;
	bytes: number;
	eventCount: number;
	firstSequence: number;
	lastSequence: number;
	completedStatus: "completed" | "failed" | "cancelled";
	externalActionsBlocked?: true;
}

const archivedJournalKeys = new Set([
	"sha256",
	"bytes",
	"eventCount",
	"firstSequence",
	"lastSequence",
	"completedStatus",
	"externalActionsBlocked",
]);

export function isCodexArchivedJournalV1(
	value: unknown,
): value is CodexArchivedJournalV1 {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !archivedJournalKeys.has(key))
	)
		return false;
	const entry = value as Record<string, unknown>;
	const positive = (field: unknown) =>
		typeof field === "number" && Number.isSafeInteger(field) && field >= 1;
	return (
		typeof entry.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(entry.sha256) &&
		positive(entry.bytes) &&
		positive(entry.eventCount) &&
		positive(entry.firstSequence) &&
		positive(entry.lastSequence) &&
		Number(entry.firstSequence) <= Number(entry.lastSequence) &&
		Number(entry.eventCount) <=
			Number(entry.lastSequence) - Number(entry.firstSequence) + 1 &&
		(entry.completedStatus === "completed" ||
			entry.completedStatus === "failed" ||
			entry.completedStatus === "cancelled") &&
		(entry.externalActionsBlocked === undefined ||
			entry.externalActionsBlocked === true)
	);
}

/** Sequence of a Driver cursor, `codex-cursor-<n>`; undefined for any other. */
export function codexCursorSequence(cursor: string) {
	const match = /^codex-cursor-([1-9][0-9]*)$/.exec(cursor);
	if (!match) return undefined;
	const sequence = Number(match[1]);
	return Number.isSafeInteger(sequence) ? sequence : undefined;
}

/** Sibling directory of the Driver state file that holds archived journals. */
export function codexJournalArchiveRoot(statePath: string) {
	return `${statePath}.journals`;
}

/** One file per native Session and Turn; native IDs never become path parts. */
function archiveFileName(nativeSessionRef: string, nativeTurnId: string) {
	return `${createHash("sha256")
		.update(JSON.stringify([nativeSessionRef, nativeTurnId]))
		.digest("hex")}.json`;
}

export function codexJournalDigest(bytes: string) {
	return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/**
 * Writes the journal bytes durably: a private temporary file is synced, renamed
 * over the final name and the directory is synced. Rewriting the same Turn is
 * safe, so an archive interrupted before its index commit is simply repeated.
 */
export async function writeCodexJournalArchive(
	root: string,
	nativeSessionRef: string,
	nativeTurnId: string,
	bytes: string,
) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const target = join(root, archiveFileName(nativeSessionRef, nativeTurnId));
	const temporary = `${target}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		await file.writeFile(bytes, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, target);
	const directory = await open(root, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/**
 * Reads an archived journal and returns its parsed value only when its bytes
 * match the committed index entry exactly; anything else is state damage.
 */
export async function readCodexJournalArchive(
	root: string,
	nativeSessionRef: string,
	nativeTurnId: string,
	entry: CodexArchivedJournalV1,
): Promise<unknown> {
	const bytes = await readFile(
		join(root, archiveFileName(nativeSessionRef, nativeTurnId)),
	);
	if (
		bytes.byteLength !== entry.bytes ||
		createHash("sha256").update(bytes).digest("hex") !== entry.sha256
	)
		throw new Error("Archived journal does not match its index");
	return JSON.parse(bytes.toString("utf8"));
}
