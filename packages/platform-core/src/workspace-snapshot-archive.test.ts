import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { WorkspaceSnapshotErrorV1 } from "./workspace-snapshot.js";
import {
	validateWorkspaceSnapshotArchiveV1,
	type WorkspaceSnapshotArchiveLimitsV1,
} from "./workspace-snapshot-archive.js";

type TarEntry = {
	name: string;
	type?: string;
	content?: Buffer | string;
	target?: string;
	declaredSize?: number;
};
const terminal = Buffer.alloc(1024);
function checksum(value: Buffer) {
	value.write("        ", 148, "ascii");
	let sum = 0;
	for (const byte of value) sum += byte;
	value.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return value;
}
function header(entry: TarEntry) {
	const value = Buffer.alloc(512);
	value.write(entry.name, 0, 100, "utf8");
	value.write(
		(entry.declaredSize ?? Buffer.byteLength(entry.content ?? ""))
			.toString(8)
			.padStart(11, "0"),
		124,
		"ascii",
	);
	value[156] = (entry.type ?? "0").charCodeAt(0);
	value.write(entry.target ?? "", 157, 100, "utf8");
	value.write("ustar\0", 257, "ascii");
	value.write("00", 263, "ascii");
	return checksum(value);
}
function encoded(entry: TarEntry) {
	const bytes = Buffer.from(entry.content ?? "");
	return Buffer.concat([
		header(entry),
		bytes,
		Buffer.alloc((512 - (bytes.length % 512)) % 512),
	]);
}
const root: TarEntry = { name: "root/", type: "5" };
const file: TarEntry = { name: "root/repo.txt", content: "hello" };
function tar(entries: TarEntry[] = [root, file], end: Buffer = terminal) {
	return Buffer.concat([...entries.map(encoded), end]);
}
function digest(bytes: Buffer) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function stream(bytes: Buffer, chunkSize = bytes.length) {
	return Readable.toWeb(
		Readable.from(
			(function* () {
				for (let offset = 0; offset < bytes.length; offset += chunkSize)
					yield bytes.subarray(offset, offset + chunkSize);
			})(),
		),
	) as ReadableStream<Uint8Array>;
}
function validate(
	bytes: Buffer,
	policy: Partial<WorkspaceSnapshotArchiveLimitsV1> = {},
	chunkSize?: number,
) {
	return validateWorkspaceSnapshotArchiveV1(
		stream(bytes, chunkSize),
		digest(bytes),
		policy,
	);
}
function pax(fields: Record<string, string>) {
	return Buffer.from(
		Object.entries(fields)
			.map(([key, value]) => {
				const content = ` ${key}=${value}\n`;
				let length = Buffer.byteLength(content) + 1;
				while (String(length).length + Buffer.byteLength(content) !== length)
					length = String(length).length + Buffer.byteLength(content);
				return `${length}${content}`;
			})
			.join(""),
	);
}

// Tar bytes are built and compressed for each test; no mocked parser or digest facts.
describe("workspace snapshot archive gate", () => {
	it("consumes every compressed byte, including gzip trailer, over tiny chunks", async () => {
		const bytes = gzipSync(
			tar([root, { name: "root/bin/run", content: "abc".repeat(20_000) }]),
		);
		expect(await validate(bytes, {}, 3)).toEqual({
			digest: digest(bytes),
			sizeBytes: bytes.length,
			unpackedSizeBytes: 60_000,
			fileCount: 1,
			mediaType: "application/x-tar+gzip",
		});
	});

	it("accepts real system tar output with directories, UTF-8, long paths and internal links", async () => {
		const directory = await mkdtemp(join(tmpdir(), "snapshot-tar-test-"));
		try {
			const long = "a".repeat(120);
			await mkdir(join(directory, "root", long), { recursive: true });
			await writeFile(join(directory, "root", long, "中文.txt"), "contents");
			await symlink(`${long}/中文.txt`, join(directory, "root", "link"));
			execFileSync(
				"tar",
				[
					"--format=pax",
					"--no-xattrs",
					"--no-acls",
					"-czf",
					join(directory, "bundle.gz"),
					"-C",
					directory,
					"root",
				],
				{
					env: { ...process.env, COPYFILE_DISABLE: "1" },
				},
			);
			const bytes = await readFile(join(directory, "bundle.gz"));
			expect(await validate(bytes, {}, 7)).toMatchObject({
				unpackedSizeBytes: 8,
				fileCount: 2,
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("accepts NUL regular type and a root inferred from child paths", async () => {
		const bytes = gzipSync(tar([{ ...file, type: "\0" }]));
		expect(await validate(bytes)).toMatchObject({
			unpackedSizeBytes: 5,
			fileCount: 1,
		});
	});

	it.each([
		["truncated gzip trailer", () => gzipSync(tar()).subarray(0, -7)],
		[
			"gzip CRC corruption",
			() => {
				const bytes = gzipSync(tar());
				bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 1;
				return bytes;
			},
		],
		[
			"garbage after gzip",
			() => Buffer.concat([gzipSync(tar()), Buffer.from("garbage")]),
		],
		[
			"a second tar in concatenated gzip",
			() =>
				Buffer.concat([
					gzipSync(tar()),
					gzipSync(tar([root, { ...file, name: "root/hidden" }])),
				]),
		],
		[
			"only one tar zero block",
			() => gzipSync(tar([root, file], Buffer.alloc(512))),
		],
		[
			"nonzero data after tar EOF",
			() =>
				gzipSync(
					Buffer.concat([
						tar(),
						encoded({ name: "root/hidden", content: "x" }),
					]),
				),
		],
		[
			"partial final tar block",
			() => gzipSync(Buffer.concat([tar(), Buffer.alloc(1)])),
		],
		[
			"entry between terminator blocks",
			() =>
				gzipSync(
					Buffer.concat([
						tar([root, file], Buffer.alloc(512)),
						encoded(file),
						terminal,
					]),
				),
		],
		[
			"truncated tar data",
			() =>
				gzipSync(
					Buffer.concat([
						encoded(root),
						header({ ...file, declaredSize: 512 }),
						Buffer.from("short"),
					]),
				),
		],
		[
			"nonzero file padding",
			() => {
				const bytes = tar();
				bytes[1024 + 5] = 1;
				return gzipSync(bytes);
			},
		],
		[
			"checksum corruption",
			() => {
				const bytes = tar();
				bytes[512] = (bytes[512] ?? 0) ^ 1;
				return gzipSync(bytes);
			},
		],
		["empty directory archive", () => gzipSync(tar([root]))],
	] as const)(
		"rejects %s without exposing input or gzip error text",
		async (_name, input) => {
			await expect(validate(input())).rejects.toMatchObject({
				name: "WorkspaceSnapshotErrorV1",
				code: "invalid_name",
				message: "invalid_name",
			});
		},
	);

	it("compares the digest against all compressed bytes", async () => {
		const bytes = gzipSync(tar());
		await expect(
			validateWorkspaceSnapshotArchiveV1(
				stream(bytes, 2),
				`sha256:${"0".repeat(64)}`,
			),
		).rejects.toMatchObject({ code: "invalid_digest" });
	});

	it.each([
		["absolute path", [{ ...file, name: "/root/file" }]],
		["parent traversal", [{ ...file, name: "root/../escape" }]],
		["second root", [file, { ...file, name: "other/file" }]],
		["duplicate normalized path", [file, { ...file, name: "./root/repo.txt" }]],
		[
			"file/child collision",
			[
				{ ...file, name: "root/dir" },
				{ ...file, name: "root/dir/file" },
			],
		],
		[
			"directory/file collision",
			[
				{ name: "root/dir/", type: "5" },
				{ ...file, name: "root/dir" },
			],
		],
		["block device", [{ name: "root/device", type: "4" }]],
		["fifo", [{ name: "root/fifo", type: "6" }]],
		["sparse entry", [{ name: "root/sparse", type: "S" }]],
		["unknown type", [{ name: "root/unknown", type: "Z" }]],
		["directory data", [{ name: "root/dir/", type: "5", content: "bad" }]],
	] as const)("rejects %s", async (_name, entries) => {
		await expect(
			validate(gzipSync(tar([root, ...entries]))),
		).rejects.toBeInstanceOf(WorkspaceSnapshotErrorV1);
	});

	it("rejects invalid UTF-8 filenames rather than replacing bytes", async () => {
		const bytes = tar();
		bytes[512 + 5] = 255;
		checksum(bytes.subarray(512, 1024));
		await expect(validate(gzipSync(bytes))).rejects.toMatchObject({
			code: "invalid_name",
		});
	});

	it("supports local PAX UTF-8 paths and GNU long names", async () => {
		const longPath = `root/${"a".repeat(100)}/${"b".repeat(100)}/中文.txt`;
		const bytes = gzipSync(
			tar([
				root,
				{
					name: "PaxHeader",
					type: "x",
					content: pax({ path: longPath, size: "5", mtime: "123.456" }),
				},
				{ ...file, name: "placeholder" },
				{ name: "././@LongLink", type: "L", content: `${longPath}.gnu\0` },
				{ ...file, name: "placeholder" },
			]),
		);
		expect(await validate(bytes, {}, 1)).toMatchObject({
			fileCount: 2,
			unpackedSizeBytes: 10,
		});
	});

	it.each([
		["PAX traversal", { path: "root/../../outside" }],
		["PAX NUL path", { path: "root/hidden\0outside" }],
		["PAX sparse disguise", { "GNU.sparse.size": "200000" }],
		["PAX capabilities", { "SCHILY.xattr.security.capability": "bad" }],
		["PAX negative size", { size: "-1" }],
	] as const)("rejects %s", async (_name, fields) => {
		await expect(
			validate(
				gzipSync(
					tar([
						root,
						{ name: "PaxHeader", type: "x", content: pax(fields) },
						file,
					]),
				),
			),
		).rejects.toMatchObject({ code: "invalid_name" });
	});

	it("rejects malformed, oversized and orphaned extension metadata", async () => {
		await expect(
			validate(
				gzipSync(
					tar([
						root,
						{ name: "PaxHeader", type: "x", content: "999 path=root/file\n" },
						file,
					]),
				),
			),
		).rejects.toMatchObject({ code: "invalid_name" });
		await expect(
			validate(
				gzipSync(
					tar([
						root,
						{
							name: "PaxHeader",
							type: "x",
							content: pax({ path: "root/file" }),
						},
					]),
				),
			),
		).rejects.toMatchObject({ code: "invalid_name" });
		await expect(
			validate(
				gzipSync(
					tar([
						root,
						{ name: "PaxHeader", type: "x", content: Buffer.alloc(65_537) },
						file,
					]),
				),
			),
		).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
	});

	it("accepts safe relative symlinks, forward hardlinks and directory aliases", async () => {
		const bytes = gzipSync(
			tar([
				root,
				{ name: "root/copy", type: "1", target: "root/lib/file" },
				{ name: "root/bin/run", type: "2", target: "../lib/file" },
				{ name: "root/lib/file", content: "code" },
				{ name: "root/alias", type: "2", target: "lib" },
				{ name: "root/alias-file", type: "2", target: "alias/file" },
			]),
		);
		expect(await validate(bytes)).toMatchObject({
			fileCount: 5,
			unpackedSizeBytes: 4,
		});
	});

	it.each([
		[
			"escaping relative link",
			[{ name: "root/link", type: "2", target: "../outside" }],
		],
		[
			"absolute link",
			[{ name: "root/link", type: "2", target: "/root/repo.txt" }],
		],
		["dangling link", [{ name: "root/link", type: "2", target: "missing" }]],
		[
			"link cycle",
			[
				{ name: "root/a", type: "2", target: "b" },
				{ name: "root/b", type: "2", target: "a" },
			],
		],
		[
			"hardlink cycle",
			[
				{ name: "root/a", type: "1", target: "root/b" },
				{ name: "root/b", type: "1", target: "root/a" },
			],
		],
		["hardlink to directory", [{ name: "root/a", type: "1", target: "root" }]],
		[
			"symlink used as extraction parent",
			[
				{ name: "root/link", type: "2", target: "repo.txt" },
				{ name: "root/link/nested", content: "payload" },
			],
		],
		[
			"parent replaced by symlink",
			[
				{ name: "root/link/nested", content: "payload" },
				{ name: "root/link", type: "2", target: "repo.txt" },
			],
		],
	] as const)("rejects %s", async (_name, entries) => {
		await expect(
			validate(gzipSync(tar([root, file, ...entries]))),
		).rejects.toMatchObject({ code: "invalid_name" });
	});

	it("enforces archive, expanded-content, entry, and path budgets", async () => {
		const bytes = gzipSync(tar());
		await expect(
			validate(bytes, { maxArchiveBytes: bytes.length - 1 }),
		).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
		await expect(
			validate(bytes, { maxUnpackedBytes: 4 }),
		).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
		await expect(validate(bytes, { maxEntries: 1 })).rejects.toMatchObject({
			code: "snapshot_limit_exceeded",
		});
		await expect(validate(bytes, { maxPathBytes: 5 })).rejects.toMatchObject({
			code: "snapshot_limit_exceeded",
		});
		await expect(
			validate(bytes, { maxArchiveBytes: Number.MAX_SAFE_INTEGER }),
		).rejects.toMatchObject({ code: "invalid_name" });
	});

	it("counts directories and bounds trailing decompressed padding", async () => {
		await expect(
			validate(gzipSync(tar([root, { name: "root/dir", type: "5" }, file])), {
				maxEntries: 2,
			}),
		).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
		await expect(
			validate(gzipSync(tar([root, file], Buffer.alloc(9 * 1024 * 1024))), {
				maxUnpackedBytes: 10,
				maxEntries: 2,
			}),
		).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
	});

	it.each([
		"-----BEGIN PRIVATE KEY-----",
		`ghp_${"A".repeat(30)}`,
		`github_pat_${"B".repeat(30)}`,
		`glpat-${"C".repeat(25)}`,
		`AKIA${"D".repeat(16)}`,
	])(
		"rejects a synthetic credential split across decompressor output chunks",
		async (marker) => {
			// 1024 bytes of headers + prefix puts the pattern across the 16 KiB gunzip chunk boundary.
			const content = "a".repeat(16_384 - 1024 - 8) + marker;
			await expect(
				validate(gzipSync(tar([root, { ...file, content }])), {}, 5),
			).rejects.toMatchObject({ message: "invalid_name" });
		},
	);

	it("redacts source errors and cancels the input after rejection", async () => {
		let cancelled = false;
		let sent = false;
		const bytes = gzipSync(tar());
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!sent) {
					sent = true;
					controller.enqueue(bytes);
				}
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			validateWorkspaceSnapshotArchiveV1(body, digest(bytes), {
				maxArchiveBytes: 1,
			}),
		).rejects.toMatchObject({ code: "snapshot_limit_exceeded" });
		expect(cancelled).toBe(true);
		const failed = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("secret-source-error"));
			},
		});
		await expect(
			validateWorkspaceSnapshotArchiveV1(failed, digest(bytes)),
		).rejects.toMatchObject({ message: "invalid_name" });
	});
});
