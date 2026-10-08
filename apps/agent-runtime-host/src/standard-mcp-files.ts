import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { RuntimeHostError } from "@agent-infra/agent-runtime";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

export function standardMcpInputUnavailable(): never {
	throw new RuntimeHostError(
		"CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
		"Standard Connection installation is unavailable",
		503,
		false,
	);
}

export async function openProtectedStandardMcpDirectory(
	path: string,
	guard?: () => void,
) {
	const assertCurrent = () => {
		assertStandardMcpProcessProtection();
		guard?.();
	};
	assertCurrent();
	if (!isAbsolute(path) || resolve(path) !== path || path === "/")
		standardMcpInputUnavailable();
	const directory = await open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		assertCurrent();
		const stat = await directory.stat();
		assertCurrent();
		const canonical = await realpath(path);
		assertCurrent();
		if (
			process.getuid?.() === undefined ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o700 ||
			canonical !== path
		)
			standardMcpInputUnavailable();
		return directory;
	} catch (error) {
		await directory.close();
		throw error;
	}
}

export function protectedStandardMcpPath(
	directory: FileHandle,
	path: string,
	name: string,
) {
	if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..")
		standardMcpInputUnavailable();
	// The portable path is only for controlled tests. Both production callers
	// check real Linux protection before reading material or publishing it.
	return join(
		process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : path,
		name,
	);
}

export async function assertProtectedStandardMcpDirectoryCurrent(
	path: string,
	directory: FileHandle,
	guard?: () => void,
) {
	const assertCurrent = () => {
		assertStandardMcpProcessProtection();
		guard?.();
	};
	assertCurrent();
	const current = await openProtectedStandardMcpDirectory(path, guard);
	try {
		const before = await directory.stat();
		assertCurrent();
		const after = await current.stat();
		assertCurrent();
		if (
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.uid !== after.uid ||
			before.mode !== after.mode
		)
			standardMcpInputUnavailable();
	} finally {
		await current.close();
	}
	assertCurrent();
}

export async function readProtectedStandardMcpBytes(
	directoryPath: string,
	name: string,
	maximum: number,
	guard?: () => void,
) {
	const assertCurrent = () => {
		assertStandardMcpProcessProtection();
		guard?.();
	};
	assertCurrent();
	let text: string;
	const directory = await openProtectedStandardMcpDirectory(
		directoryPath,
		guard,
	);
	try {
		assertCurrent();
		const file = await open(
			protectedStandardMcpPath(directory, directoryPath, name),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			assertCurrent();
			const before = await file.stat();
			assertCurrent();
			if (
				!before.isFile() ||
				before.uid !== process.getuid?.() ||
				before.nlink !== 1 ||
				![0o400, 0o600].includes(before.mode & 0o777) ||
				before.size < 1 ||
				before.size > maximum
			)
				standardMcpInputUnavailable();
			const bytes = Buffer.alloc(before.size + 1);
			try {
				let length = 0;
				while (length < bytes.length) {
					assertCurrent();
					const { bytesRead } = await file.read(
						bytes,
						length,
						bytes.length - length,
						length,
					);
					assertCurrent();
					if (!bytesRead) break;
					length += bytesRead;
				}
				const after = await file.stat();
				assertCurrent();
				if (
					length !== before.size ||
					before.dev !== after.dev ||
					before.ino !== after.ino ||
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					before.ctimeMs !== after.ctimeMs ||
					after.uid !== before.uid ||
					after.nlink !== 1 ||
					after.mode !== before.mode
				)
					standardMcpInputUnavailable();
				await assertProtectedStandardMcpDirectoryCurrent(
					directoryPath,
					directory,
					guard,
				);
				text = new TextDecoder("utf-8", { fatal: true }).decode(
					bytes.subarray(0, length),
				);
			} finally {
				bytes.fill(0);
			}
		} finally {
			await file.close();
		}
	} finally {
		await directory.close();
	}
	assertCurrent();
	return text;
}
