import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	chown,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	lstat,
	rm,
	rename,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const releasePath = new URL(
	"../../packages/agent-runtime/src/codex-release.json",
	import.meta.url,
);
const release = JSON.parse(await readFile(releasePath, "utf8"));

// The upstream archive can carry a non-root owner on its executable entry.
// `fs.copyFile` preserves that metadata on Linux, so normalize the installed
// payload owner when the image build is running as root. The runtime verifier
// requires the immutable installation hierarchy to remain root-owned; a
// non-root local fixture/test install remains usable and is rejected by that
// verifier if it is ever used as a production image.
async function normalizeRootOwnership(path) {
	if (typeof process.getuid === "function" && process.getuid() === 0)
		await chown(path, 0, 0);
}

async function download(url, expected, path) {
	const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error("Codex release asset unavailable");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (
		`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expected
	) {
		throw new Error("Codex release asset checksum mismatch");
	}
	await writeFile(path, bytes);
}

const [architecture, destination, archiveInput, ...extra] =
	process.argv.slice(2);
const artifact = release.artifacts[architecture];
if (!artifact || !destination || extra.length) {
	throw new Error(
		"usage: install-codex.mjs <amd64|arm64> <destination> [complete-archive.tar.gz]",
	);
}
const isDerivedRelease =
	release.schemaVersion === 2 && release.distribution?.kind === "derived";
const isUpstreamRelease =
	(release.schemaVersion === 2 && release.distribution?.kind === "upstream") ||
	(release.schemaVersion === undefined && release.distribution === undefined);
if (!isDerivedRelease && !isUpstreamRelease) {
	throw new Error("Unsupported Codex release manifest");
}
if (
	isUpstreamRelease &&
	(typeof artifact.name !== "string" ||
		! /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.name))
) {
	throw new Error("Invalid Codex executable archive member");
}
const installRoot = resolve(destination);
const installParent = dirname(installRoot);
await mkdir(installParent, { recursive: true });
const stagingRoot = await mkdtemp(join(installParent, ".codex-install-"));
let committed = false;
try {
	if (isDerivedRelease) {
		if (
			!archiveInput ||
			release.schemaVersion !== 2 ||
			release.distribution?.kind !== "derived"
		) {
			throw new Error("A pinned derived release requires its complete archive");
		}
		execFileSync(
			"python3",
			[
				"-B",
				fileURLToPath(
					new URL("./vendor/codex/install-bundle.py", import.meta.url),
				),
				architecture,
				stagingRoot,
				resolve(archiveInput),
			],
			{ stdio: "inherit" },
		);
	} else {
		if (archiveInput)
			throw new Error("An archive input requires a pinned derived release");
		const directory = await mkdtemp(join(tmpdir(), "codex-install-"));
		try {
			const archive = join(directory, "release.tar.gz");
			await download(
				`https://github.com/openai/codex/releases/download/${release.provenance.upstreamTag}/${artifact.name}.tar.gz`,
				artifact.archiveSha256,
				archive,
			);
			execFileSync(
				"tar",
				[
					"-xzf",
					archive,
					"-C",
					directory,
					artifact.name,
				],
				{ stdio: "ignore" },
			);
			const binaryPath = join(directory, artifact.name);
			const binaryInfo = await lstat(binaryPath);
			if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink())
				throw new Error("Codex executable archive member is not a regular file");
			const binary = await readFile(binaryPath);
			if (
				`sha256:${createHash("sha256").update(binary).digest("hex")}` !==
				artifact.executableSha256
			) {
				throw new Error("Codex executable checksum mismatch");
			}
			const bin = resolve(stagingRoot, "bin");
			const share = resolve(stagingRoot, "share");
			await mkdir(bin, { recursive: true });
			await mkdir(share, { recursive: true });
			await normalizeRootOwnership(stagingRoot);
			await normalizeRootOwnership(bin);
			await normalizeRootOwnership(share);
			await copyFile(binaryPath, join(bin, "codex"));
			await normalizeRootOwnership(join(bin, "codex"));
			await chmod(join(bin, "codex"), 0o555);
			await copyFile(releasePath, join(share, "release.json"));
			await normalizeRootOwnership(join(share, "release.json"));
			await chmod(join(share, "release.json"), 0o444);
			for (const [name, sha256] of Object.entries(release.legal)) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
					throw new Error("Invalid Codex legal file name");
				const legalPath = join(share, name);
				await download(
					`https://raw.githubusercontent.com/openai/codex/${release.provenance.upstreamCommit}/${name}`,
					sha256,
					legalPath,
				);
				await normalizeRootOwnership(legalPath);
				await chmod(legalPath, 0o444);
			}
			await chmod(share, 0o555);
			await chmod(bin, 0o555);
			await chmod(stagingRoot, 0o555);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	let previousRoot;
	try {
		await lstat(installRoot);
		previousRoot = await mkdtemp(join(installParent, ".codex-install-previous-"));
		await rm(previousRoot, { recursive: true, force: true });
		await rename(installRoot, previousRoot);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	try {
		await rename(stagingRoot, installRoot);
		committed = true;
	} catch (error) {
		if (previousRoot) {
			try {
				await rename(previousRoot, installRoot);
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					"Failed to restore the previous Codex installation",
				);
			}
		}
		throw error;
	}
	if (previousRoot) await rm(previousRoot, { recursive: true, force: true });
} finally {
	if (!committed) await rm(stagingRoot, { recursive: true, force: true });
}
