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
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const installRoot = resolve(destination);
await rm(installRoot, { recursive: true, force: true });
await mkdir(installRoot, { recursive: true });
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
			installRoot,
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
		execFileSync("tar", ["-xzf", archive, "-C", directory, artifact.name], {
			stdio: "ignore",
		});
		const binary = await readFile(join(directory, artifact.name));
		if (
			`sha256:${createHash("sha256").update(binary).digest("hex")}` !==
			artifact.executableSha256
		) {
			throw new Error("Codex executable checksum mismatch");
		}
		const bin = resolve(destination, "bin");
		const share = resolve(destination, "share");
		await mkdir(bin, { recursive: true });
		await mkdir(share, { recursive: true });
		await normalizeRootOwnership(destination);
		await normalizeRootOwnership(bin);
		await normalizeRootOwnership(share);
		await copyFile(join(directory, artifact.name), join(bin, "codex"));
		await normalizeRootOwnership(join(bin, "codex"));
		await chmod(join(bin, "codex"), 0o555);
		await copyFile(releasePath, join(share, "release.json"));
		await normalizeRootOwnership(join(share, "release.json"));
		await chmod(join(share, "release.json"), 0o444);
		for (const [name, sha256] of Object.entries(release.legal)) {
			await download(
				`https://raw.githubusercontent.com/openai/codex/${release.provenance.upstreamCommit}/${name}`,
				sha256,
				join(share, name),
			);
			await normalizeRootOwnership(join(share, name));
			await chmod(join(share, name), 0o444);
		}
		await chmod(share, 0o555);
		await chmod(bin, 0o555);
		await chmod(destination, 0o555);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
