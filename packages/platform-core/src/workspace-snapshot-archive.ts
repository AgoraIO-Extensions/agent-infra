import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
	WorkspaceSnapshotErrorV1,
	workspaceSnapshotLimitsV1,
} from "./workspace-snapshot.js";

export interface WorkspaceSnapshotArchiveDescriptorV1 {
	readonly digest: string;
	readonly sizeBytes: number;
	readonly unpackedSizeBytes: number;
	readonly fileCount: number;
	readonly mediaType: "application/x-tar+gzip";
}

/** Deployments/tests may tighten these bounds, never increase the product caps. */
export interface WorkspaceSnapshotArchiveLimitsV1 {
	readonly maxArchiveBytes: number;
	readonly maxUnpackedBytes: number;
	readonly maxEntries: number;
	readonly maxPathBytes: number;
}

const defaults: WorkspaceSnapshotArchiveLimitsV1 = {
	maxArchiveBytes: workspaceSnapshotLimitsV1.maxArchiveBytes,
	maxUnpackedBytes: workspaceSnapshotLimitsV1.maxUnpackedBytes,
	maxEntries: workspaceSnapshotLimitsV1.maxFiles,
	maxPathBytes: workspaceSnapshotLimitsV1.maxPathBytes,
};
const maxExtensionBytes = 64 * 1024;
const maxTotalExtensionBytes = 8 * 1024 * 1024;
const credentialPattern =
	/(?:-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
function invalid(): never {
	throw new WorkspaceSnapshotErrorV1("invalid_name");
}
function oversized(): never {
	throw new WorkspaceSnapshotErrorV1("snapshot_limit_exceeded");
}

function limits(input: Partial<WorkspaceSnapshotArchiveLimitsV1>) {
	const result = { ...defaults, ...input };
	for (const key of Object.keys(result) as (keyof typeof result)[])
		if (
			!Object.hasOwn(defaults, key) ||
			!Number.isSafeInteger(result[key]) ||
			result[key] < 1 ||
			result[key] > defaults[key]
		)
			invalid();
	return result;
}

function stringField(bytes: Buffer): string {
	const end = bytes.indexOf(0);
	if (end !== -1 && bytes.subarray(end).some((byte) => byte !== 0)) invalid();
	return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Buffer): number {
	const value = bytes.toString("ascii");
	if (!/^[ \0]*[0-7]*[ \0]*$/.test(value)) invalid();
	const parsed = Number.parseInt(value.replaceAll("\0", "").trim() || "0", 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) invalid();
	return parsed;
}

function verifyHeader(header: Buffer) {
	const checksum = octal(header.subarray(148, 156));
	let actual = 0;
	for (let index = 0; index < 512; index += 1)
		actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
	if (checksum !== actual) invalid();
	// Reject unknown/sparse variants instead of interpreting them as ordinary files.
	const magic = header.subarray(257, 263).toString("ascii");
	if (magic !== "ustar\0" && magic !== "ustar " && magic !== "\0".repeat(6))
		invalid();
}

function archivePath(input: string, directory: boolean, maxBytes: number) {
	let value = input;
	if (!value || value.includes("\0") || value.includes("\\")) invalid();
	if (Buffer.byteLength(value) > maxBytes) oversized();
	while (value.startsWith("./")) value = value.slice(2);
	if (directory && value.endsWith("/")) value = value.slice(0, -1);
	if (value.split("/").some((part) => !part || part === "." || part === ".."))
		invalid();
	return value;
}

const paxKeys = new Set([
	"path",
	"linkpath",
	"size",
	"uid",
	"gid",
	"mtime",
	"atime",
	"ctime",
	"uname",
	"gname",
	"comment",
	"charset",
	"hdrcharset",
]);
function parsePax(bytes: Buffer): Map<string, string> {
	const fields = new Map<string, string>();
	let offset = 0;
	while (offset < bytes.length) {
		const separator = bytes.indexOf(32, offset);
		if (separator < offset || separator - offset > 10) invalid();
		const lengthText = bytes.subarray(offset, separator).toString("ascii");
		if (!/^[1-9][0-9]*$/.test(lengthText)) invalid();
		const end = offset + Number(lengthText);
		if (end > bytes.length || end <= separator + 3 || bytes[end - 1] !== 10)
			invalid();
		const field = utf8.decode(bytes.subarray(separator + 1, end - 1));
		const equals = field.indexOf("=");
		const key = field.slice(0, equals);
		const value = field.slice(equals + 1);
		if (
			equals < 1 ||
			!paxKeys.has(key) ||
			fields.has(key) ||
			value.includes("\0")
		)
			invalid();
		if (["size", "uid", "gid"].includes(key) && !/^[0-9]+$/.test(value))
			invalid();
		if (
			["mtime", "atime", "ctime"].includes(key) &&
			!/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)
		)
			invalid();
		if (["charset", "hdrcharset"].includes(key) && value !== "UTF-8") invalid();
		fields.set(key, value);
		offset = end;
	}
	if (!fields.size) invalid();
	return fields;
}

type Entry = {
	type: "file" | "directory" | "symlink" | "hardlink";
	target?: string;
};

function verifyTree(entries: Map<string, Entry>, root: string) {
	const directories = new Set([root]);
	for (const [name, entry] of entries) {
		if (entry.type === "directory") directories.add(name);
		let parent = posix.dirname(name);
		while (parent !== ".") {
			const ancestor = entries.get(parent);
			if (ancestor && ancestor.type !== "directory") invalid();
			directories.add(parent);
			parent = posix.dirname(parent);
		}
	}
	// Resolve links component by component: '..' after a symlink follows the resolved directory.
	function resolve(
		parts: string[],
		active: Set<string>,
	): { path: string; type: string } {
		const resolved: string[] = [];
		let finalType = "directory";
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			if (!part || part === ".") continue;
			if (finalType !== "directory") invalid();
			if (part === "..") {
				if (resolved.length <= 1) invalid();
				resolved.pop();
				continue;
			}
			resolved.push(part);
			if (resolved[0] !== root) invalid();
			const path = resolved.join("/");
			const entry = entries.get(path);
			if (entry?.type === "symlink" || entry?.type === "hardlink") {
				// Linux follows at most 40 symbolic links for one lookup; bound hostile graphs too.
				if (active.has(path) || active.size >= 40 || !entry.target) invalid();
				const next = new Set(active).add(path);
				const target =
					entry.type === "hardlink"
						? entry.target.split("/")
						: [...resolved.slice(0, -1), ...entry.target.split("/")];
				const result = resolve(target, next);
				if (entry.type === "hardlink" && result.type !== "file") invalid();
				resolved.splice(0, resolved.length, ...result.path.split("/"));
				finalType = result.type;
			} else if (entry?.type === "file") finalType = "file";
			else if (directories.has(path)) finalType = "directory";
			else invalid();
		}
		return { path: resolved.join("/"), type: finalType };
	}
	for (const [name, entry] of entries)
		if (entry.type === "symlink" || entry.type === "hardlink")
			resolve(name.split("/"), new Set());
}

class TarValidator {
	readonly #limits;
	readonly #header = Buffer.alloc(512);
	readonly #entries = new Map<string, Entry>();
	#headerLength = 0;
	#remaining = 0;
	#padding = 0;
	#extension: { type: string; chunks: Buffer[] } | null = null;
	#local = new Map<string, string>();
	#global = new Map<string, string>();
	#scanTail = "";
	#regular = false;
	#root: string | null = null;
	#zeroBlocks = 0;
	#headers = 0;
	#extensionBytes = 0;
	#totalBytes = 0;
	unpackedSizeBytes = 0;
	fileCount = 0;

	constructor(boundaries: WorkspaceSnapshotArchiveLimitsV1) {
		this.#limits = boundaries;
	}

	write(chunk: Buffer) {
		this.#totalBytes += chunk.length;
		if (
			this.#totalBytes >
			this.#limits.maxUnpackedBytes +
				this.#limits.maxEntries * 1024 +
				maxTotalExtensionBytes +
				1024
		)
			oversized();
		let offset = 0;
		while (offset < chunk.length) {
			if (this.#remaining) {
				const length = Math.min(this.#remaining, chunk.length - offset);
				const bytes = chunk.subarray(offset, offset + length);
				if (this.#extension) this.#extension.chunks.push(Buffer.from(bytes));
				if (this.#regular) {
					this.unpackedSizeBytes += bytes.length;
					if (this.unpackedSizeBytes > this.#limits.maxUnpackedBytes)
						oversized();
					const text = this.#scanTail + bytes.toString("latin1");
					if (credentialPattern.test(text)) invalid();
					this.#scanTail = text.slice(-256);
				}
				offset += length;
				this.#remaining -= length;
				if (!this.#remaining && this.#extension) this.#finishExtension();
				continue;
			}
			if (this.#padding) {
				const length = Math.min(this.#padding, chunk.length - offset);
				if (chunk.subarray(offset, offset + length).some((byte) => byte !== 0))
					invalid();
				offset += length;
				this.#padding -= length;
				continue;
			}
			const length = Math.min(512 - this.#headerLength, chunk.length - offset);
			chunk.copy(this.#header, this.#headerLength, offset, offset + length);
			this.#headerLength += length;
			offset += length;
			if (this.#headerLength === 512) {
				this.#headerLength = 0;
				this.#readHeader();
			}
		}
	}

	#finishExtension() {
		const extension = this.#extension;
		if (!extension) invalid();
		const bytes = Buffer.concat(extension.chunks);
		if (extension.type === "x" || extension.type === "g") {
			const fields = parsePax(bytes);
			if (extension.type === "g") {
				if (["path", "linkpath", "size"].some((key) => fields.has(key)))
					invalid();
				this.#global = new Map([...this.#global, ...fields]);
			} else {
				for (const [key, value] of fields) {
					if (this.#local.has(key)) invalid();
					this.#local.set(key, value);
				}
			}
		} else {
			const key = extension.type === "L" ? "path" : "linkpath";
			if (this.#local.has(key)) invalid();
			this.#local.set(key, stringField(bytes));
		}
		this.#extension = null;
	}

	#readHeader() {
		const header = this.#header;
		if (header.every((byte) => byte === 0)) {
			this.#zeroBlocks += 1;
			return;
		}
		if (this.#zeroBlocks) invalid();
		verifyHeader(header);
		if (++this.#headers > this.#limits.maxEntries) oversized();
		const type =
			header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
		const size = octal(header.subarray(124, 136));
		if (["x", "g", "L", "K"].includes(type)) {
			if (!size || size > maxExtensionBytes) oversized();
			this.#extensionBytes += size;
			if (this.#extensionBytes > maxTotalExtensionBytes) oversized();
			this.#extension = { type, chunks: [] };
			this.#regular = false;
			this.#remaining = size;
			this.#padding = (512 - (size % 512)) % 512;
			return;
		}
		if (!["0", "1", "2", "5"].includes(type)) invalid();
		const attributes = new Map([...this.#global, ...this.#local]);
		this.#local.clear();
		const prefix =
			header.subarray(257, 263).toString("ascii") === "ustar\0"
				? stringField(header.subarray(345, 500))
				: "";
		const baseName = stringField(header.subarray(0, 100));
		const path = archivePath(
			attributes.get("path") ?? (prefix ? `${prefix}/${baseName}` : baseName),
			type === "5",
			this.#limits.maxPathBytes,
		);
		const root = path.split("/")[0];
		if (!root || (this.#root && root !== this.#root)) invalid();
		this.#root = root;
		if (path === root && type !== "5") invalid();
		if (this.#entries.has(path)) invalid();
		const effectiveSize = attributes.has("size")
			? Number(attributes.get("size"))
			: size;
		if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 0) invalid();
		if (type !== "0" && effectiveSize !== 0) invalid();
		if (effectiveSize > this.#limits.maxUnpackedBytes - this.unpackedSizeBytes)
			oversized();
		const target =
			attributes.get("linkpath") ?? stringField(header.subarray(157, 257));
		let entry: Entry;
		if (type === "1" || type === "2") {
			if (
				!target ||
				target.startsWith("/") ||
				target.includes("\0") ||
				target.includes("\\")
			)
				invalid();
			if (Buffer.byteLength(target) > this.#limits.maxPathBytes) oversized();
			entry = { type: type === "1" ? "hardlink" : "symlink", target };
		} else {
			if (target) invalid();
			entry = { type: type === "5" ? "directory" : "file" };
		}
		this.#entries.set(path, entry);
		if (type !== "5") this.fileCount += 1;
		this.#regular = type === "0";
		this.#remaining = effectiveSize;
		this.#padding = (512 - (effectiveSize % 512)) % 512;
		this.#scanTail = "";
	}

	finish() {
		if (
			this.#remaining ||
			this.#padding ||
			this.#headerLength ||
			this.#zeroBlocks < 2 ||
			this.#local.size ||
			!this.#root ||
			!this.fileCount
		)
			invalid();
		verifyTree(this.#entries, this.#root);
	}
}

export async function validateWorkspaceSnapshotArchiveV1(
	body: ReadableStream<Uint8Array>,
	expectedDigest: string,
	policy: Partial<WorkspaceSnapshotArchiveLimitsV1> = {},
): Promise<WorkspaceSnapshotArchiveDescriptorV1> {
	if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest))
		throw new WorkspaceSnapshotErrorV1("invalid_digest");
	const bounds = limits(policy);
	const hash = createHash("sha256");
	let compressedSize = 0;
	const parser = new TarValidator(bounds);
	try {
		await pipeline(
			Readable.fromWeb(body),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					compressedSize += chunk.length;
					if (compressedSize > bounds.maxArchiveBytes)
						return callback(
							new WorkspaceSnapshotErrorV1("snapshot_limit_exceeded"),
						);
					hash.update(chunk);
					callback(null, chunk);
				},
			}),
			createGunzip(),
			async (chunks) => {
				for await (const chunk of chunks) parser.write(Buffer.from(chunk));
			},
		);
		parser.finish();
	} catch (error) {
		if (error instanceof WorkspaceSnapshotErrorV1) throw error;
		invalid();
	}
	const digest = `sha256:${hash.digest("hex")}`;
	if (digest !== expectedDigest)
		throw new WorkspaceSnapshotErrorV1("invalid_digest");
	return {
		digest,
		sizeBytes: compressedSize,
		unpackedSizeBytes: parser.unpackedSizeBytes,
		fileCount: parser.fileCount,
		mediaType: "application/x-tar+gzip",
	};
}
