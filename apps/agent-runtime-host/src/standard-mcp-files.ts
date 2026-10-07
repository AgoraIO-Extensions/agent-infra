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

export async function openProtectedStandardMcpDirectory(path: string) {
	assertStandardMcpProcessProtection();
	if (!isAbsolute(path) || resolve(path) !== path || path === "/")
		standardMcpInputUnavailable();
	const directory = await open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		assertStandardMcpProcessProtection();
		const stat = await directory.stat();
		assertStandardMcpProcessProtection();
		const canonical = await realpath(path);
		assertStandardMcpProcessProtection();
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
) {
	const current = await openProtectedStandardMcpDirectory(path);
	try {
		const before = await directory.stat();
		const after = await current.stat();
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
	assertStandardMcpProcessProtection();
}

export async function readProtectedStandardMcpBytes(
	directoryPath: string,
	name: string,
	maximum: number,
) {
	assertStandardMcpProcessProtection();
	let text: string;
	const directory = await openProtectedStandardMcpDirectory(directoryPath);
	try {
		assertStandardMcpProcessProtection();
		const file = await open(
			protectedStandardMcpPath(directory, directoryPath, name),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			assertStandardMcpProcessProtection();
			const before = await file.stat();
			assertStandardMcpProcessProtection();
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
					assertStandardMcpProcessProtection();
					const { bytesRead } = await file.read(
						bytes,
						length,
						bytes.length - length,
						length,
					);
					assertStandardMcpProcessProtection();
					if (!bytesRead) break;
					length += bytesRead;
				}
				const after = await file.stat();
				assertStandardMcpProcessProtection();
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
	assertStandardMcpProcessProtection();
	return text;
}
