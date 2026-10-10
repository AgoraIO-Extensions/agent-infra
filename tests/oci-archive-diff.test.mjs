import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeOciArchiveDifference } from "../deploy/release/oci-archive-diff.mjs";
import { writeOciArchive } from "./support/oci-archive.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const longPath = `usr/share/${"nested-directory/".repeat(8)}generated.cache`;

function dpkgStatus(packages) {
	return packages
		.map(
			([name, version]) =>
				`Package: ${name}\nStatus: install ok installed\nArchitecture: amd64\nVersion: ${version}\nDescription: synthetic\n`,
		)
		.join("\n");
}

async function withDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-oci-diff-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("reports the differing layer paths and dpkg deltas without file contents", async () => {
	await withDirectory(async (directory) => {
		const base = [{ path: "etc/os-release", content: "ID=debian\n" }];
		const tail = [
			{ path: "app/start.sh", content: "#!/bin/sh\n", mode: 0o755 },
		];
		const first = [
			{ path: "etc/stamp", content: "same", mtime: 1600000000 },
			{ path: "tmp/removed", content: "old" },
			{ path: "usr/lib/libexample.so", content: "elf" },
			{ path: longPath, content: "long-cache-one" },
			{
				path: "var/cache/tool/state.bin",
				content: "synthetic-private-content-A",
			},
			{
				path: "var/lib/dpkg/status",
				content: dpkgStatus([
					["libbar", "2.0-1"],
					["libfoo", "1.0-1"],
					["libgone", "0.9-1"],
				]),
			},
		];
		const second = [
			{ path: "etc/stamp", content: "same", mtime: 1600000001 },
			{ path: "usr/lib/libexample.so", content: "elf", mode: 0o755 },
			{ path: longPath, content: "long-cache-two" },
			{ path: "var/cache/tool/extra", content: "extra" },
			{
				path: "var/cache/tool/state.bin",
				content: "synthetic-private-content-B",
			},
			{
				path: "var/lib/dpkg/status",
				content: dpkgStatus([
					["libbar", "2.0-1"],
					["libfoo", "1.1-1"],
					["libnew", "0.1-1"],
				]),
			},
		];
		const firstArchive = join(directory, "first.oci.tar");
		const secondArchive = join(directory, "second.oci.tar");
		const firstManifest = await writeOciArchive(firstArchive, {
			layers: [
				{ entries: base },
				{ entries: first },
				{ entries: tail, compression: "zstd" },
			],
		});
		const secondManifest = await writeOciArchive(secondArchive, {
			layers: [
				{ entries: base },
				{ entries: second },
				{ entries: tail, compression: "zstd" },
			],
		});

		const lines = await describeOciArchiveDifference(
			firstArchive,
			secondArchive,
		);
		const report = lines.join("\n");
		assert.match(
			lines[0],
			/^archive filesystem free \d+\.\d GiB of \d+\.\d GiB$/,
		);
		assert.equal(lines[1], `manifest ${firstManifest} vs ${secondManifest}`);
		assert.match(
			report,
			/^config sha256:[a-f0-9]{64} vs sha256:[a-f0-9]{64}; differing fields: rootfs\.diff_ids\[1\]$/m,
		);
		assert.match(report, /^layers 3 vs 3; differing indexes: 1$/m);
		assert.match(
			report,
			/^layer 1: sha256:[a-f0-9]{64} \(\d+ bytes\) vs sha256:[a-f0-9]{64} \(\d+ bytes\); diff_id differs$/m,
		);
		assert.match(report, /^ {2}entries 6 vs 6; 7 differing paths$/m);
		assert.ok(lines.includes("  ~ etc/stamp (mtime 1600000000 -> 1600000001)"));
		assert.ok(
			lines.includes(
				`  - tmp/removed (file, size 3, sha256 ${sha256("old")}, mode 644, owner 0:0, mtime 1700000000)`,
			),
		);
		assert.ok(
			lines.includes(
				`  + var/cache/tool/extra (file, size 5, sha256 ${sha256("extra")}, mode 644, owner 0:0, mtime 1700000000)`,
			),
		);
		assert.ok(lines.includes("  ~ usr/lib/libexample.so (mode 644 -> 755)"));
		assert.ok(
			lines.includes(
				`  ~ var/cache/tool/state.bin (sha256 ${sha256("synthetic-private-content-A")} -> ${sha256("synthetic-private-content-B")})`,
			),
		);
		assert.ok(
			lines.includes(
				`  ~ ${longPath} (sha256 ${sha256("long-cache-one")} -> ${sha256("long-cache-two")})`,
			),
		);
		assert.ok(
			lines.some((line) => line.startsWith("  ~ var/lib/dpkg/status (size ")),
		);
		const dpkg = lines.slice(
			lines.indexOf("  var/lib/dpkg/status: 3 package deltas"),
		);
		assert.deepEqual(dpkg, [
			"  var/lib/dpkg/status: 3 package deltas",
			"  dpkg ~ libfoo:amd64 1.0-1 -> 1.1-1",
			"  dpkg - libgone:amd64 0.9-1",
			"  dpkg + libnew:amd64 0.1-1",
		]);
		assert.ok(
			!/layer [02]:/.test(report),
			"identical layers stay out of the report",
		);
		for (const content of [
			"synthetic-private-content",
			"long-cache-one",
			"ID=debian",
			"Description: synthetic",
		]) {
			assert.ok(!report.includes(content), `${content} must not be printed`);
		}
	});
});

test("bounds path, package and layer detail output", async () => {
	await withDirectory(async (directory) => {
		const layer = (variant) =>
			Array.from({ length: 60 }, (_, index) => ({
				path: `opt/generated/${String(index).padStart(2, "0")}`,
				content: `${variant}-${index}`,
			}));
		const status = (variant) =>
			dpkgStatus(
				Array.from({ length: 5 }, (_, index) => [
					`pkg${index}`,
					`${variant}.${index}`,
				]),
			);
		const archive = (variant) => ({
			layers: [
				{
					entries: [
						...layer(variant),
						{ path: "var/lib/dpkg/status", content: status(variant) },
					],
				},
				...Array.from({ length: 4 }, (_, index) => ({
					entries: [{ path: `layer-${index}`, content: `${variant}-${index}` }],
				})),
			],
		});
		await writeOciArchive(join(directory, "a.tar"), archive("1"));
		await writeOciArchive(join(directory, "b.tar"), archive("2"));

		const lines = await describeOciArchiveDifference(
			join(directory, "a.tar"),
			join(directory, "b.tar"),
			{
				limits: { packages: 2 },
			},
		);
		assert.ok(
			lines.includes("layers 5 vs 5; differing indexes: 0, 1, 2, 3, 4"),
		);
		const first = lines.slice(
			lines.indexOf("layer 0 paths:") + 1,
			lines.indexOf("layer 1 paths:"),
		);
		assert.equal(first[0], "  entries 61 vs 61; 61 differing paths");
		assert.equal(first.filter((line) => line.startsWith("  ~ ")).length, 50);
		assert.ok(first.includes("  … 11 more differing paths"));
		assert.deepEqual(first.slice(-4), [
			"  var/lib/dpkg/status: 5 package deltas",
			"  dpkg ~ pkg0:amd64 1.0 -> 2.0",
			"  dpkg ~ pkg1:amd64 1.1 -> 2.1",
			"  dpkg … 3 more package deltas",
		]);
		assert.ok(lines.includes("layer 2 paths:"));
		assert.ok(!lines.includes("layer 3 paths:"));
		assert.equal(lines.at(-1), "path details limited to layers 0, 1, 2");
	});
});

test("separates compression-only layer differences from content drift", async () => {
	await withDirectory(async (directory) => {
		const entries = [{ path: "usr/lib/base.so", content: "same bytes" }];
		await writeOciArchive(join(directory, "a.tar"), { layers: [{ entries }] });
		await writeOciArchive(join(directory, "b.tar"), {
			layers: [{ entries, compression: "zstd" }],
		});

		const lines = await describeOciArchiveDifference(
			join(directory, "a.tar"),
			join(directory, "b.tar"),
		);
		assert.ok(!lines.some((line) => line.startsWith("config ")));
		assert.match(
			lines.join("\n"),
			/^layer 0: .+; diff_id identical \(compression only\)$/m,
		);
		assert.deepEqual(lines.slice(-2), [
			"layer 0 paths:",
			"  entries 1 vs 1; 0 differing paths",
		]);
	});
});

test("diagnostic failures are reported without throwing", async () => {
	await withDirectory(async (directory) => {
		const archive = join(directory, "image.tar");
		await writeOciArchive(archive, {
			layers: [{ entries: [{ path: "a", content: "a" }] }],
		});
		const missing = await describeOciArchiveDifference(
			archive,
			join(directory, "missing.tar"),
		);
		assert.equal(missing.length, 2);
		assert.match(missing[0], /^archive filesystem free /);
		assert.equal(missing[1], "diagnostic incomplete: ENOENT");

		const bytes = await readFile(archive);
		const index = bytes.indexOf(
			Buffer.from(
				'{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index',
			),
		);
		const corrupted = Buffer.from(bytes);
		corrupted.write("{", index + 1);
		await writeFile(join(directory, "corrupted.tar"), corrupted);
		assert.equal(
			(
				await describeOciArchiveDifference(
					archive,
					join(directory, "corrupted.tar"),
				)
			).at(-1),
			"diagnostic incomplete: archive JSON member is invalid",
		);
	});
});
