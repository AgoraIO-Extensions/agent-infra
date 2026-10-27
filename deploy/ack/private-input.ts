import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export async function privateBytes(file: string) {
	assert(isAbsolute(file));
	const handle = await open(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		assert(
			stat.isFile() &&
				stat.uid === process.getuid?.() &&
				(stat.mode & 0o077) === 0 &&
				stat.size <= 1024 * 1024,
		);
		const bytes = Buffer.alloc(1024 * 1024 + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		assert(bytesRead <= 1024 * 1024 && bytesRead === stat.size);
		return bytes.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

export async function privateJson(file: string) {
	return JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(file)),
	);
}
