import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
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
const isLegacyRelease =
	release.schemaVersion === undefined && release.distribution === undefined;
if (!isDerivedRelease && !isLegacyRelease) {
	throw new Error("Unsupported Codex release manifest");
}
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
			resolve(destination),
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
		await copyFile(join(directory, artifact.name), join(bin, "codex"));
		await chmod(join(bin, "codex"), 0o755);
		await copyFile(releasePath, join(share, "release.json"));
		for (const [name, sha256] of Object.entries(release.legal)) {
			await download(
				`https://raw.githubusercontent.com/openai/codex/${release.provenance.upstreamCommit}/${name}`,
				sha256,
				join(share, name),
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
