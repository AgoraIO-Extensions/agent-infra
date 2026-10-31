import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	chown,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Only chmod directories owned by this test; never follow fixture symlinks.
async function cleanFixture(path) {
	const info = await lstat(path);
	if (info.isDirectory()) {
		await chmod(path, 0o755);
		for (const name of await readdir(path))
			await cleanFixture(join(path, name));
	}
	await rm(path, { recursive: true, force: true });
}

// #2978：安装脚本连同模型目录模块与摘要清单一起放进临时仓库根目录（ADR-0029 起不含追加条目）。
const upstreamCommit = "a".repeat(40);
const upstreamCatalogUrl = `https://raw.githubusercontent.com/openai/codex/${upstreamCommit}/codex-rs/models-manager/models.json`;
const upstreamCatalog = JSON.stringify({
	models: [{ slug: "upstream-model", priority: 1 }],
});
// 独立写出期望字节，不复用被测模块：只有内置条目，原样保留。
const expectedCatalog = `${JSON.stringify({
	models: [{ slug: "upstream-model", priority: 1 }],
})}\n`;
const digest = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function stageInstaller(
	root,
	{
		upstreamPin = digest(upstreamCatalog),
		catalogPin = digest(expectedCatalog),
	} = {},
) {
	await mkdir(join(root, "deploy/runtime"), { recursive: true });
	await mkdir(join(root, "packages/agent-runtime/src"), { recursive: true });
	for (const name of ["install-codex.mjs", "codex-models.mjs"])
		await copyFile(
			new URL(`../deploy/runtime/${name}`, import.meta.url),
			join(root, "deploy/runtime", name),
		);
	await writeFile(
		join(root, "packages/agent-runtime/src/codex-models.json"),
		JSON.stringify({ upstreamSha256: upstreamPin, sha256: catalogPin }),
	);
	return join(root, "deploy/runtime/install-codex.mjs");
}

// 只对固定提交的目录 URL 返回内置目录，其他 URL 视为不存在。
const catalogFetch = `url === ${JSON.stringify(upstreamCatalogUrl)} ? new Response(${JSON.stringify(upstreamCatalog)}) : url.endsWith("/models.json") ? new Response("", { status: 404 }) :`;

for (const scenario of ["new", "replace", "rollback", "cleanup-failure"])
	test(
		scenario === "rollback"
			? "upstream installer restores the previous install when atomic swap fails"
			: scenario === "replace"
				? "upstream installer replaces read-only installs without touching old symlink targets"
				: scenario === "cleanup-failure"
					? "upstream installer preserves a committed install when backup cleanup fails"
					: "upstream installer produces the verifier's immutable file modes",
		async () => {
			const failCommit = scenario === "rollback";
			const failCleanup = scenario === "cleanup-failure";
			const root = await mkdtemp(join(tmpdir(), "codex-installer-test-"));
			const destination = join(root, "installed");
			try {
				const installer = await stageInstaller(root);
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
					provenance: { upstreamTag: "test", upstreamCommit },
					artifacts: {
						amd64: {
							name,
							archiveSha256: hash(await readFile(archive)),
							executableSha256: hash(binary),
						},
					},
					codeModeHostArtifacts: {
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
				if (failCommit || failCleanup) {
					await mkdir(destination);
					await writeFile(
						join(destination, "sentinel"),
						"keep-existing-install",
					);
					await chmod(destination, 0o555);
				}
				const preload = join(root, "download-fixture.mjs");
				await writeFile(
					preload,
					`import fs, { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const originalRename = fs.rename;
const originalReaddir = fs.readdir;
fs.readdir = async (path, ...options) => {
  if (${failCleanup} && path.includes(".codex-install-previous-")) {
    throw Object.assign(new Error("injected backup cleanup failure"), { code: "EIO" });
  }
  return originalReaddir(path, ...options);
};
fs.rename = async (source, target) => {
  if (${failCommit} && source.includes(".codex-install-") && !source.includes(".codex-install-previous-") && target.endsWith("/installed")) {
    throw new Error("injected installer commit failure");
  }
  return originalRename(source, target);
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => ${catalogFetch} new Response(url.endsWith(".tar.gz") ? await readFile(new URL("./archive.tar.gz", import.meta.url)) : "synthetic license");`,
				);
				const install = () =>
					execFileSync(
						process.execPath,
						["--import", preload, installer, "amd64", destination],
						{ stdio: "pipe" },
					);
				if (failCommit) {
					assert.throws(install, /injected installer commit failure/);
					assert.equal(
						await readFile(join(destination, "sentinel"), "utf8"),
						"keep-existing-install",
					);
					assert.equal((await stat(destination)).mode & 0o7777, 0o555);
					assert.deepEqual(
						(await readdir(root)).filter((name) =>
							name.startsWith(".codex-install-"),
						),
						[],
					);
					return;
				}
				install();
				if (failCleanup) {
					const backups = (await readdir(root)).filter((name) =>
						name.startsWith(".codex-install-previous-"),
					);
					assert.equal(backups.length, 1);
					assert.equal(
						await readFile(join(root, backups[0], "sentinel"), "utf8"),
						"keep-existing-install",
					);
				}
				if (scenario === "replace") {
					const oldInode = (await stat(destination)).ino;
					const external = join(root, "external");
					await mkdir(external);
					await writeFile(join(external, "sentinel"), "untouched");
					await chmod(external, 0o500);
					await chmod(join(destination, "bin"), 0o755);
					await symlink(external, join(destination, "bin", "external-link"));
					await chmod(join(destination, "bin"), 0o555);
					install();
					assert.notEqual((await stat(destination)).ino, oldInode);
					assert.equal((await stat(external)).mode & 0o7777, 0o500);
					assert.equal(
						await readFile(join(external, "sentinel"), "utf8"),
						"untouched",
					);
					assert.deepEqual(
						(await readdir(root)).filter((name) =>
							name.startsWith(".codex-install-"),
						),
						[],
					);
				}
				const expectedUid =
					typeof process.getuid === "function" ? process.getuid() : undefined;
				for (const [path, mode] of [
					["", 0o555],
					["bin", 0o555],
					["share", 0o555],
					["bin/codex", 0o555],
					["bin/codex-code-mode-host", 0o555],
					["share/release.json", 0o444],
					["share/LICENSE", 0o444],
					["share/models.json", 0o444],
				]) {
					const info = await stat(join(destination, path));
					assert.equal(info.mode & 0o7777, mode, path);
					if (expectedUid !== undefined)
						assert.equal(info.uid, expectedUid, path);
				}
				assert.deepEqual(
					await readFile(join(destination, "bin/codex")),
					binary,
				);
				assert.deepEqual(
					await readFile(join(destination, "bin/codex-code-mode-host")),
					binary,
				);
				assert.equal(
					await readFile(join(destination, "share/models.json"), "utf8"),
					expectedCatalog,
				);
			} finally {
				await cleanFixture(root);
			}
		},
	);

test("upstream installer retries an interrupted pinned archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-installer-retry-"));
	const destination = join(root, "installed");
	try {
		const installer = await stageInstaller(root);
		const binary = Buffer.from("synthetic retry bytes");
		const name = "codex-test";
		await writeFile(join(root, name), binary);
		const archive = join(root, "archive.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", root, name]);
		const archiveBytes = await readFile(archive);
		const archiveHash = digest(archiveBytes);
		const trace = join(root, "download-trace");
		await writeFile(
			join(root, "packages/agent-runtime/src/codex-release.json"),
			JSON.stringify({
				provenance: { upstreamTag: "test", upstreamCommit },
				artifacts: {
					amd64: {
						name,
						archiveSha256: archiveHash,
						executableSha256: digest(binary),
					},
				},
				codeModeHostArtifacts: {
					amd64: {
						name,
						archiveSha256: archiveHash,
						executableSha256: digest(binary),
					},
				},
				legal: { LICENSE: digest("synthetic license") },
			}),
		);
		const preload = join(root, "download-fixture.mjs");
		await writeFile(
			preload,
			`import { readFile, writeFile } from "node:fs/promises";
let calls = 0;
globalThis.fetch = async (url) => {
  if (url === ${JSON.stringify(upstreamCatalogUrl)}) return new Response(${JSON.stringify(upstreamCatalog)});
  if (url.endsWith(".tar.gz")) {
    calls++; await writeFile(${JSON.stringify(trace)}, String(calls));
    if (calls === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1,2,3])); controller.error(Object.assign(new Error("terminated"), { cause: { code: "UND_ERR_SOCKET" } })); } }), { status: 200 });
    return new Response(await readFile(${JSON.stringify(archive)}));
  }
  return new Response("synthetic license");
};`,
		);
		execFileSync(
			process.execPath,
			["--import", preload, installer, "amd64", destination],
			{ stdio: "pipe" },
		);
		assert.equal(Number(await readFile(trace, "utf8")), 3);
		assert.deepEqual(await readFile(join(destination, "bin/codex")), binary);
		assert.deepEqual(
			await readFile(join(destination, "bin/codex-code-mode-host")),
			binary,
		);
	} finally {
		await cleanFixture(root);
	}
});

test("upstream installer retries a connect timeout before Codex headers", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "codex-installer-connect-timeout-"),
	);
	const destination = join(root, "installed");
	try {
		const installer = await stageInstaller(root);
		const binary = Buffer.from("synthetic connect timeout bytes");
		const name = "codex-test";
		await writeFile(join(root, name), binary);
		const archive = join(root, "archive.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", root, name]);
		const archiveBytes = await readFile(archive);
		const archiveHash = digest(archiveBytes);
		await writeFile(
			join(root, "packages/agent-runtime/src/codex-release.json"),
			JSON.stringify({
				provenance: { upstreamTag: "test", upstreamCommit },
				artifacts: {
					amd64: {
						name,
						archiveSha256: archiveHash,
						executableSha256: digest(binary),
					},
				},
				codeModeHostArtifacts: {
					amd64: {
						name,
						archiveSha256: archiveHash,
						executableSha256: digest(binary),
					},
				},
				legal: { LICENSE: digest("synthetic license") },
			}),
		);
		const trace = join(root, "download-trace");
		const preload = join(root, "download-fixture.mjs");
		await writeFile(
			preload,
			`import { readFile, writeFile } from "node:fs/promises";
let calls = 0;
globalThis.fetch = async (url) => {
  if (url === ${JSON.stringify(upstreamCatalogUrl)}) return new Response(${JSON.stringify(upstreamCatalog)});
  if (url.endsWith(".tar.gz")) {
    calls++; await writeFile(${JSON.stringify(trace)}, String(calls));
    if (calls === 1) throw new TypeError("transport", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    return new Response(await readFile(${JSON.stringify(archive)}));
  }
  return new Response("synthetic license");
};`,
		);
		execFileSync(
			process.execPath,
			["--import", preload, installer, "amd64", destination],
			{ stdio: "pipe" },
		);
		assert.equal(Number(await readFile(trace, "utf8")), 3);
		assert.deepEqual(await readFile(join(destination, "bin/codex")), binary);
	} finally {
		await cleanFixture(root);
	}
});

test("upstream installer validates the archive member before replacing an existing install", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-installer-invalid-member-"));
	const destination = join(root, "installed");
	try {
		const installer = await stageInstaller(root);
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
	const root = await mkdtemp(
		join(tmpdir(), "codex-installer-staging-failure-"),
	);
	const destination = join(root, "installed");
	try {
		const installer = await stageInstaller(root);
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
				codeModeHostArtifacts: { amd64: { name: "codex-host-test" } },
				legal: {},
			}),
		);
		const preload = join(root, "download-fixture.mjs");
		await writeFile(
			preload,
			'globalThis.fetch = async () => new Response("synthetic archive");',
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

// #2978：目录摘要或内置目录任一不符时，安装失败且保留原安装。
for (const [scenario, options, expected] of [
	[
		"code-mode host pin mismatch",
		{ hostPin: digest("another host") },
		/Codex executable checksum mismatch/,
	],
	[
		"code-mode host archive mismatch",
		{ hostArchivePin: digest("another archive") },
		/Codex release asset checksum mismatch/,
	],
	[
		"catalog pin mismatch",
		{ catalogPin: digest("another catalog") },
		/Codex model catalog checksum mismatch/,
	],
	[
		"upstream catalog pin mismatch",
		{ upstreamPin: digest("another upstream catalog") },
		/Codex release asset checksum mismatch/,
	],
])
	test(`upstream installer keeps the previous install on ${scenario}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "codex-installer-catalog-"));
		const destination = join(root, "installed");
		try {
			const installer = await stageInstaller(root, options);
			const binary = Buffer.from("synthetic upstream bytes");
			await writeFile(join(root, "codex-test"), binary);
			const archive = join(root, "archive.tar.gz");
			execFileSync("tar", ["-czf", archive, "-C", root, "codex-test"]);
			await writeFile(
				join(root, "packages/agent-runtime/src/codex-release.json"),
				JSON.stringify({
					provenance: { upstreamTag: "test", upstreamCommit },
					artifacts: {
						amd64: {
							name: "codex-test",
							archiveSha256: digest(await readFile(archive)),
							executableSha256: digest(binary),
						},
					},
					codeModeHostArtifacts: {
						amd64: {
							name: "codex-test",
							archiveSha256:
								options.hostArchivePin ?? digest(await readFile(archive)),
							executableSha256: options.hostPin ?? digest(binary),
						},
					},
					legal: { LICENSE: digest("synthetic license") },
				}),
			);
			await mkdir(destination, { recursive: true });
			const sentinel = join(destination, "sentinel");
			await writeFile(sentinel, "keep-existing-install");
			const preload = join(root, "download-fixture.mjs");
			await writeFile(
				preload,
				`import { readFile } from "node:fs/promises";
globalThis.fetch = async (url) => ${catalogFetch} new Response(url.endsWith(".tar.gz") ? await readFile(new URL("./archive.tar.gz", import.meta.url)) : "synthetic license");`,
			);
			assert.throws(
				() =>
					execFileSync(
						process.execPath,
						["--import", preload, installer, "amd64", destination],
						{ stdio: "pipe" },
					),
				expected,
			);
			assert.equal(await readFile(sentinel, "utf8"), "keep-existing-install");
			assert.deepEqual(
				(await readdir(root)).filter((name) =>
					name.startsWith(".codex-install-"),
				),
				[],
			);
		} finally {
			await cleanFixture(root);
		}
	});
