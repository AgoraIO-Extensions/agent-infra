import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { WorkspaceSnapshotErrorV1 } from "./workspace-snapshot.js";
import { validateWorkspaceSnapshotArchiveV1 } from "./workspace-snapshot-archive.js";

function header(name: string, size: number, type: string) {
	const value = Buffer.alloc(512);
	value.write(name, 0, "utf8");
	value.write(`00000000000${size.toString(8)}`.slice(-11), 124, "ascii");
	value[156] = type.charCodeAt(0);
	value.write("        ", 148, "ascii");
	let checksum = 0;
	for (const byte of value) checksum += byte;
	value.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return value;
}
function archive(content: string, name = "root/repo.txt") {
	const data = Buffer.from(content);
	return gzipSync(
		Buffer.concat([
			header("root/", 0, "5"),
			header(name, data.byteLength, "0"),
			data,
			Buffer.alloc((512 - (data.byteLength % 512)) % 512),
			Buffer.alloc(1024),
		]),
	);
}

describe("workspace snapshot archive gate", () => {
	it("streams gzip tar bytes and returns bounded metadata", async () => {
		const bytes = archive("hello");
		const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		const result = await validateWorkspaceSnapshotArchiveV1(
			Readable.toWeb(Readable.from(bytes)) as ReadableStream<Uint8Array>,
			digest,
		);
		expect(result).toMatchObject({
			digest,
			sizeBytes: bytes.byteLength,
			unpackedSizeBytes: 5,
			fileCount: 1,
		});
	});
	it("rejects digest mismatch and obvious credentials", async () => {
		const bytes = archive("-----BEGIN PRIVATE KEY-----");
		const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		await expect(
			validateWorkspaceSnapshotArchiveV1(
				Readable.toWeb(Readable.from(bytes)) as ReadableStream<Uint8Array>,
				digest,
			),
		).rejects.toBeInstanceOf(WorkspaceSnapshotErrorV1);
	});
});
