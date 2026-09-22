import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	chown,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("upstream installer produces the verifier's immutable file modes", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-installer-test-"));
	const destination = join(root, "installed");
	try {
		await mkdir(join(root, "deploy/runtime"), { recursive: true });
		await mkdir(join(root, "packages/agent-runtime/src"), { recursive: true });
		const installer = join(root, "deploy/runtime/install-codex.mjs");
		await copyFile(
			new URL("../deploy/runtime/install-codex.mjs", import.meta.url),
			installer,
		);
		const binary = Buffer.from("synthetic upstream bytes");
		const name = "codex-test";
		await writeFile(join(root, name), binary);
		// Upstream archives can carry a non-root owner. Exercise the image-build
		// normalization when this test itself is running as root.
		if (typeof process.getuid === "function" && process.getuid() === 0)
			await chown(join(root, name), 1001, 1001);
		const archive = join(root, "archive.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", root, name]);
		const hash = (bytes) =>
			`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
		const manifest = {
			provenance: { upstreamTag: "test", upstreamCommit: "test" },
			artifacts: {
				amd64: {
					name,
					archiveSha256: hash(await readFile(archive)),
					executableSha256: hash(binary),
				},
			},
			legal: { LICENSE: hash("synthetic license") },
		};
		await writeFile(
			join(root, "packages/agent-runtime/src/codex-release.json"),
			JSON.stringify(manifest),
		);
		const preload = join(root, "download-fixture.mjs");
		await writeFile(
			preload,
			`import { readFile } from "node:fs/promises";
globalThis.fetch = async (url) => new Response(url.endsWith(".tar.gz") ? await readFile(new URL("./archive.tar.gz", import.meta.url)) : "synthetic license");`,
		);
		execFileSync(process.execPath, [
			"--import",
			preload,
			installer,
			"amd64",
			destination,
		]);
		const expectedUid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		for (const [path, mode] of [
			["", 0o555],
			["bin", 0o555],
			["share", 0o555],
			["bin/codex", 0o555],
			["share/release.json", 0o444],
			["share/LICENSE", 0o444],
		]) {
			const info = await stat(join(destination, path));
			assert.equal(info.mode & 0o7777, mode, path);
			if (expectedUid !== undefined) assert.equal(info.uid, expectedUid, path);
		}
		assert.deepEqual(await readFile(join(destination, "bin/codex")), binary);
	} finally {
		for (const path of [
			destination,
			join(destination, "bin"),
			join(destination, "share"),
		])
			await chmod(path, 0o755).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("upstream installer validates the archive member before replacing an existing install", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-installer-invalid-member-"));
	const destination = join(root, "installed");
	try {
		await mkdir(join(root, "deploy/runtime"), { recursive: true });
		await mkdir(join(root, "packages/agent-runtime/src"), { recursive: true });
		const installer = join(root, "deploy/runtime/install-codex.mjs");
		await copyFile(
			new URL("../deploy/runtime/install-codex.mjs", import.meta.url),
			installer,
		);
		await mkdir(destination, { recursive: true });
		const sentinel = join(destination, "sentinel");
		await writeFile(sentinel, "keep-existing-install");
		await writeFile(
			join(root, "packages/agent-runtime/src/codex-release.json"),
			JSON.stringify({
				provenance: { upstreamTag: "test", upstreamCommit: "test" },
				artifacts: {
					amd64: {
						name: "../outside",
						archiveSha256: "sha256:invalid",
						executableSha256: "sha256:invalid",
					},
				},
				legal: {},
			}),
		);
		assert.throws(
			() =>
				execFileSync(process.execPath, [installer, "amd64", destination], {
					stdio: "pipe",
				}),
			/Invalid Codex executable archive member/,
		);
		assert.equal(await readFile(sentinel, "utf8"), "keep-existing-install");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("upstream installer keeps the previous install when staging validation fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-installer-staging-failure-"));
	const destination = join(root, "installed");
	try {
		await mkdir(join(root, "deploy/runtime"), { recursive: true });
		await mkdir(join(root, "packages/agent-runtime/src"), { recursive: true });
		const installer = join(root, "deploy/runtime/install-codex.mjs");
		await copyFile(
			new URL("../deploy/runtime/install-codex.mjs", import.meta.url),
			installer,
		);
		await mkdir(destination, { recursive: true });
		const sentinel = join(destination, "sentinel");
		await writeFile(sentinel, "keep-existing-install");
		await writeFile(
			join(root, "packages/agent-runtime/src/codex-release.json"),
			JSON.stringify({
				provenance: { upstreamTag: "test", upstreamCommit: "test" },
				artifacts: {
					amd64: {
						name: "codex-test",
						archiveSha256: `sha256:${"0".repeat(64)}`,
						executableSha256: `sha256:${"1".repeat(64)}`,
					},
				},
				legal: {},
			}),
		);
		const preload = join(root, "download-fixture.mjs");
		await writeFile(
			preload,
			"globalThis.fetch = async () => new Response(\"synthetic archive\");",
		);
		assert.throws(
			() =>
				execFileSync(
					process.execPath,
					["--import", preload, installer, "amd64", destination],
					{ stdio: "pipe" },
				),
			/Codex release asset checksum mismatch/,
		);
		assert.equal(await readFile(sentinel, "utf8"), "keep-existing-install");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
