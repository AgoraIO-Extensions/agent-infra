import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const releasePath = new URL("../../packages/agent-runtime/src/opencode-release.json", import.meta.url);
const release = JSON.parse(await readFile(releasePath, "utf8"));
const [architecture, destination, ...extra] = process.argv.slice(2);
const artifact = release.artifacts[`linux-${architecture === "amd64" ? "x64" : architecture}-musl`];
if (!artifact || !destination || extra.length) throw new Error("usage: install-opencode.mjs <amd64|arm64> <destination>");
const directory = await mkdtemp(join(tmpdir(), "opencode-install-"));
try {
	const response = await fetch(artifact.tarball, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error("OpenCode release asset unavailable");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== artifact.archiveSha256 || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity) throw new Error("OpenCode archive checksum mismatch");
	const archive = join(directory, "release.tgz");
	await writeFile(archive, bytes);
	execFileSync("tar", ["-xzf", archive, "-C", directory, "package/bin/opencode"], { stdio: "ignore" });
	const binary = await readFile(join(directory, "package/bin/opencode"));
	if (createHash("sha256").update(binary).digest("hex") !== artifact.executableSha256) throw new Error("OpenCode executable checksum mismatch");
	await mkdir(resolve(destination, "bin"), { recursive: true });
	await mkdir(resolve(destination, "share"), { recursive: true });
	await copyFile(join(directory, "package/bin/opencode"), resolve(destination, "bin/opencode"));
	await chmod(resolve(destination, "bin/opencode"), 0o755);
	await copyFile(releasePath, resolve(destination, "share/release.json"));
	await copyFile(new URL("../../packages/agent-runtime/third-party/opencode-LICENSE", import.meta.url), resolve(destination, "share/LICENSE"));
} finally { await rm(directory, { recursive: true, force: true }); }
