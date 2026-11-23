import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Creates the empty Codex Driver mapping for a trusted fresh Session. The caller
 * must already have proved that no mapping and no native storage exist; this
 * never repairs a lost mapping. O_EXCL makes a concurrent or repeated call fail
 * with EEXIST instead of replacing an existing mapping.
 */
export async function createEmptyCodexDriverStateV1(
	runtimeDirectory: string,
	statePath: string,
): Promise<void> {
	const file = await open(
		statePath,
		constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await file.writeFile(
			JSON.stringify({ schemaVersion: 2, sessions: {}, operations: {} }) + "\n",
		);
		await file.sync();
	} finally {
		await file.close();
	}
	const parent = await open(runtimeDirectory, constants.O_RDONLY);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
