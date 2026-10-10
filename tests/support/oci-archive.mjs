// Minimal OCI layout tar writer for release diagnostics tests.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { gzipSync, zstdCompressSync } from "node:zlib";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const octal = (value, width) =>
	`${value.toString(8).padStart(width - 1, "0")}\0`;
const pad = (bytes) =>
	Buffer.concat([bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);

function header(
	name,
	size,
	{ type = "0", mode = 0o644, linkname = "", mtime = 1700000000 },
) {
	const block = Buffer.alloc(512);
	block.write(name.slice(0, 100), 0, 100, "utf8");
	block.write(octal(mode, 8), 100);
	block.write(octal(0, 8), 108);
	block.write(octal(0, 8), 116);
	block.write(octal(size, 12), 124);
	block.write(octal(mtime, 12), 136);
	block.fill(0x20, 148, 156);
	block.write(type, 156);
	block.write(linkname, 157, 100, "utf8");
	block.write("ustar\0", 257);
	block.write("00", 263);
	const checksum = block.reduce((sum, byte) => sum + byte, 0);
	block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
}

function paxRecord(key, value) {
	const body = ` ${key}=${value}\n`;
	let length = Buffer.byteLength(body);
	length += String(length + String(length).length).length;
	return `${length}${body}`;
}

// `pax` adds raw PAX records, e.g. a malformed `size` for negative tests.
export function tarArchive(entries) {
	const blocks = [];
	for (const { path, content = "", pax = {}, ...options } of entries) {
		const bytes = Buffer.from(content);
		const records = {
			...(Buffer.byteLength(path) > 100 ? { path } : {}),
			...pax,
		};
		if (Object.keys(records).length > 0) {
			const record = Buffer.from(
				Object.entries(records)
					.map(([key, value]) => paxRecord(key, value))
					.join(""),
			);
			blocks.push(header("PaxHeaders/entry", record.length, { type: "x" }));
			blocks.push(pad(record));
		}
		blocks.push(header(path, bytes.length, options), pad(bytes));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

// Writes `type=oci` style output: oci-layout, index.json and blobs/sha256/*.
export async function writeOciArchive(path, { layers, labels = {} }) {
	const blobs = new Map();
	const add = (bytes) => {
		const digest = `sha256:${sha256(bytes)}`;
		blobs.set(digest, bytes);
		return { digest, size: bytes.length };
	};
	const diffIds = [];
	const layerDescriptors = layers.map(({ entries, compression = "gzip" }) => {
		const raw = tarArchive(entries);
		diffIds.push(`sha256:${sha256(raw)}`);
		const bytes =
			compression === "zstd"
				? zstdCompressSync(raw)
				: compression === "none"
					? raw
					: gzipSync(raw);
		return {
			mediaType: `application/vnd.oci.image.layer.v1.tar${compression === "none" ? "" : `+${compression}`}`,
			...add(bytes),
		};
	});
	const config = add(
		Buffer.from(
			JSON.stringify({
				architecture: "amd64",
				os: "linux",
				config: { Labels: labels },
				rootfs: { type: "layers", diff_ids: diffIds },
			}),
		),
	);
	const manifest = add(
		Buffer.from(
			JSON.stringify({
				schemaVersion: 2,
				mediaType: "application/vnd.oci.image.manifest.v1+json",
				config: {
					mediaType: "application/vnd.oci.image.config.v1+json",
					...config,
				},
				layers: layerDescriptors,
			}),
		),
	);
	const index = {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [
			{ mediaType: "application/vnd.oci.image.manifest.v1+json", ...manifest },
		],
	};
	await writeFile(
		path,
		tarArchive([
			{ path: "blobs/", type: "5", mode: 0o755 },
			{ path: "blobs/sha256/", type: "5", mode: 0o755 },
			...[...blobs].map(([digest, content]) => ({
				path: `blobs/sha256/${digest.slice(7)}`,
				content,
			})),
			{ path: "index.json", content: JSON.stringify(index) },
			{ path: "oci-layout", content: '{"imageLayoutVersion":"1.0.0"}' },
		]),
	);
	return manifest.digest;
}
