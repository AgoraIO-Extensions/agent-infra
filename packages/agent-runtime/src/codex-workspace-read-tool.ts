import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const codexWorkspaceReadToolVersion = 1;
export const codexWorkspaceReadToolDefinition = {
	type: "namespace",
	name: "workspace",
	description: "Read-only text files in the current Conversation workspace",
	tools: [
		{
			type: "function",
			name: "read_text_file",
			description:
				"Read a named ordinary UTF-8 text file in this Conversation's workspace. Use only a relative path; no links or parent traversal. Returns at most 4096 bytes and reports truncation.",
			inputSchema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative file path inside the current workspace",
					},
				},
				required: ["path"],
				additionalProperties: false,
			},
		},
	],
} as const;

function unavailable(): never {
	throw new Error("WORKSPACE_FILE_UNAVAILABLE");
}

function sameFile(left: BigIntStats, right: BigIntStats) {
	return (
		left.ino === right.ino &&
		left.dev === right.dev &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export function isCodexWorkspaceReadPath(path: unknown): path is string {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		path.isWellFormed() &&
		Buffer.byteLength(path) <= 1024 &&
		!path.includes("\\") &&
		!path.includes(":") &&
		[...path].every((character) => {
			const code = character.codePointAt(0);
			return code !== undefined && code >= 32 && code !== 127;
		}) &&
		!isAbsolute(path) &&
		!path.split("/").some((part) => !part || part === "." || part === "..")
	);
}

/** The caller supplies a verified Conversation root and owns current authorization. */
export async function readCodexWorkspaceTextFile(
	root: string,
	path: string,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (
		!isCodexWorkspaceReadPath(path) ||
		!isAbsolute(root) ||
		resolve(root) !== root
	)
		unavailable();
	try {
		if ((await realpath(root)) !== root) unavailable();
		const paths = [root];
		for (const part of path.split("/"))
			paths.push(join(paths.at(-1) ?? root, part));
		const inspect = async () => {
			const records: BigIntStats[] = [];
			for (const [index, candidate] of paths.entries()) {
				signal.throwIfAborted();
				const info = await lstat(candidate, { bigint: true });
				if (
					info.isSymbolicLink() ||
					(index === paths.length - 1
						? !info.isFile() || info.nlink !== 1n
						: !info.isDirectory())
				)
					unavailable();
				records.push(info);
			}
			return records;
		};
		const before = await inspect();
		if (
			before[0]?.uid !== BigInt(process.getuid?.() ?? -1) ||
			(before[0].mode & 0o077n) !== 0n
		)
			unavailable();
		const expected = before.at(-1);
		const candidate = paths.at(-1);
		if (!expected || !candidate) unavailable();
		// NONBLOCK prevents a racing replacement with a FIFO/device from hanging open.
		const handle = await open(
			candidate,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const opened = await handle.stat({ bigint: true });
			if (!opened.isFile() || !sameFile(expected, opened)) unavailable();
			const verifyPaths = async () => {
				const current = await inspect();
				if (
					current.some((info, index) => !sameFile(before[index] ?? info, info))
				)
					unavailable();
				if (
					(await realpath(root)) !== root ||
					(await realpath(candidate)) !== candidate
				)
					unavailable();
				// Check the actual open descriptor, not a second lookup of its name.
				if (
					process.platform === "linux" &&
					(await realpath(`/proc/self/fd/${handle.fd}`)) !== candidate
				)
					unavailable();
			};
			await verifyPaths();
			const wanted = Number(opened.size < 4096n ? opened.size : 4096n);
			const bytes = Buffer.alloc(wanted);
			let count = 0;
			while (count < wanted) {
				signal.throwIfAborted();
				const read = await handle.read(bytes, count, wanted - count, count);
				if (!read.bytesRead) break;
				count += read.bytesRead;
			}
			signal.throwIfAborted();
			if (
				count !== wanted ||
				!sameFile(opened, await handle.stat({ bigint: true }))
			)
				unavailable();
			await verifyPaths();
			const truncated = opened.size > BigInt(count);
			// A UTF-8 code point cut by the byte limit is omitted from the returned prefix.
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
				stream: truncated,
			});
			if (text.includes("\0")) unavailable();
			return { path, text, bytesRead: count, truncated };
		} finally {
			await handle.close();
		}
	} catch {
		signal.throwIfAborted();
		unavailable();
	}
}
