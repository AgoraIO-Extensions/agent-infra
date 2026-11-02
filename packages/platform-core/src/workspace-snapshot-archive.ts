import { createHash } from "node:crypto";
import { Readable } from "node:stream";
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

const credentialPattern =
	/(-----BEGIN [^-]*PRIVATE KEY-----|(?:gh[pousr]_|xox[baprs]-|sk-[A-Za-z0-9])[A-Za-z0-9._-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16})/i;
const max = workspaceSnapshotLimitsV1;

function octal(value: Buffer): number {
	const text = value.toString("ascii").replace(/\0/g, "").trim();
	if (!/^[0-7]+$/.test(text))
		throw new WorkspaceSnapshotErrorV1("invalid_name");
	return Number.parseInt(text, 8);
}

function pathName(header: Buffer): string {
	const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
	const prefix = header
		.subarray(345, 500)
		.toString("utf8")
		.replace(/\0.*$/s, "");
	const path = prefix ? `${prefix}/${name}` : name;
	const parts = path.split("/");
	if (
		!path ||
		path.startsWith("/") ||
		parts.some(
			(part, index) =>
				part === ".." ||
				part === "." ||
				(part === "" && index !== parts.length - 1),
		)
	)
		throw new WorkspaceSnapshotErrorV1("invalid_name");
	if (Buffer.byteLength(path) > max.maxPathBytes)
		throw new WorkspaceSnapshotErrorV1("invalid_name");
	return path;
}

export async function validateWorkspaceSnapshotArchiveV1(
	body: ReadableStream<Uint8Array>,
	expectedDigest: string,
): Promise<WorkspaceSnapshotArchiveDescriptorV1> {
	if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest))
		throw new WorkspaceSnapshotErrorV1("invalid_digest");
	const hash = createHash("sha256");
	let compressedSize = 0;
	const source = Readable.fromWeb(body as never);
	const digesting = (async function* () {
		for await (const chunk of source) {
			const value = Buffer.from(chunk as Uint8Array);
			compressedSize += value.byteLength;
			if (compressedSize > max.maxArchiveBytes)
				throw new WorkspaceSnapshotErrorV1("snapshot_limit_exceeded");
			hash.update(value);
			yield value;
		}
	})();
	const decompressed = Readable.from(digesting).pipe(createGunzip());
	let buffer = Buffer.alloc(0);
	let unpacked = 0;
	let files = 0;
	let root: string | null = null;
	let finished = false;
	let pendingData = 0;
	let pendingPadding = 0;
	let currentType = "";
	let currentTail = "";
	const paths = new Set<string>();
	for await (const chunk of decompressed) {
		buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
		while (true) {
			if (pendingData > 0) {
				if (buffer.byteLength === 0) break;
				const take = Math.min(pendingData, buffer.byteLength);
				const part = buffer.subarray(0, take);
				buffer = buffer.subarray(take);
				pendingData -= take;
				if (currentType === "0" || currentType === "") {
					const sample = currentTail + part.toString("utf8");
					if (credentialPattern.test(sample))
						throw new WorkspaceSnapshotErrorV1("invalid_name");
					currentTail = sample.slice(-128);
				}
				continue;
			}
			if (pendingPadding > 0) {
				if (buffer.byteLength === 0) break;
				const take = Math.min(pendingPadding, buffer.byteLength);
				buffer = buffer.subarray(take);
				pendingPadding -= take;
				continue;
			}
			if (buffer.byteLength < 512) break;
			const header = buffer.subarray(0, 512);
			buffer = buffer.subarray(512);
			if (header.every((byte) => byte === 0)) {
				finished = true;
				break;
			}
			const path = pathName(header);
			const size = octal(header.subarray(124, 136));
			const type = String.fromCharCode(header[156] ?? 0);
			if (type !== "0" && type !== "" && type !== "5")
				throw new WorkspaceSnapshotErrorV1("invalid_name");
			if (!root) {
				if (type !== "5" || !path.endsWith("/"))
					throw new WorkspaceSnapshotErrorV1("invalid_name");
				root = path.slice(0, -1);
			}
			if (path !== `${root}/` && !path.startsWith(`${root}/`))
				throw new WorkspaceSnapshotErrorV1("invalid_name");
			if (paths.has(path)) throw new WorkspaceSnapshotErrorV1("invalid_name");
			paths.add(path);
			if (type !== "5") files += 1;
			if (files > max.maxFiles)
				throw new WorkspaceSnapshotErrorV1("snapshot_limit_exceeded");
			unpacked += size;
			if (unpacked > max.maxUnpackedBytes)
				throw new WorkspaceSnapshotErrorV1("snapshot_limit_exceeded");
			currentType = type;
			currentTail = "";
			pendingData = size;
			pendingPadding = (512 - (size % 512)) % 512;
		}
		if (finished) break;
	}
	if (!finished || !root || pendingData !== 0 || pendingPadding !== 0)
		throw new WorkspaceSnapshotErrorV1("invalid_name");
	const digest = `sha256:${hash.digest("hex")}`;
	if (digest !== expectedDigest)
		throw new WorkspaceSnapshotErrorV1("invalid_digest");
	return {
		digest,
		sizeBytes: compressedSize,
		unpackedSizeBytes: unpacked,
		fileCount: files,
		mediaType: "application/x-tar+gzip",
	};
}
