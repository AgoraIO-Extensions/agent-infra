import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releasePath = new URL("../../packages/agent-runtime/src/browser-release.json", import.meta.url);
const release = JSON.parse(await readFile(releasePath, "utf8"));
const [architecture, destination, ...extra] = process.argv.slice(2);
const artifact = release.artifacts[architecture];
if (!artifact || !destination || extra.length) throw new Error("usage: install-chromium.mjs <amd64|arm64> <destination>");
const staging = await mkdtemp(join(tmpdir(), "chromium-install-"));
try {
	const response = await fetch(artifact.url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error("Chromium release asset unavailable");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== artifact.archiveSha256) throw new Error("Chromium archive checksum mismatch");
	const archive = join(staging, "release.zip");
	await writeFile(archive, bytes);
	execFileSync("unzip", ["-q", archive, "-d", staging], { stdio: "ignore" });
	const executable = join(staging, artifact.executable);
	if (createHash("sha256").update(await readFile(executable)).digest("hex") !== artifact.executableSha256) throw new Error("Chromium executable checksum mismatch");
	await mkdir(resolve(destination), { recursive: true });
	execFileSync("cp", ["-R", join(staging, artifact.directory), resolve(destination)], { stdio: "ignore" });
	await copyFile(releasePath, resolve(destination, "release.json"));
	execFileSync("chown", ["-R", "0:0", resolve(destination)]);
	execFileSync("chmod", ["-R", "a-w", resolve(destination)]);
} finally {
	await rm(staging, { recursive: true, force: true });
}
