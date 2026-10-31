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

function chromiumFailure(category, message) {
	const error = new Error(`${message} [category=${category}]`);
	error.code = `CHROMIUM_${category.toUpperCase()}`;
	return error;
}

function classifyDownloadFailure(error) {
	const stderr = Buffer.isBuffer(error?.stderr)
		? error.stderr.toString("utf8")
		: String(error?.stderr ?? "");
	if (
		error?.signal === "SIGTERM" ||
		error?.code === "ETIMEDOUT" ||
		/\b(?:timed out|timeout|operation timed out)\b/i.test(stderr)
	)
		return "timeout";
	if (
		/\b(?:HTTP\/\d(?:\.\d)?\s+\d{3}|(?:returned|server returned)\s+error|http error)\b/i.test(stderr) ||
		/\bcurl:\s*\(22\)\b/i.test(stderr)
	)
		return "http";
	if (
		/\b(?:buildkit|buildx|docker (?:daemon|engine)|only one connection|unable to lease|runner|no space left on device)\b/i.test(stderr)
	)
		return "runner";
	return "transport";
}

try {
	const archive = join(staging, "release.zip");
	const deadline = Date.now() + 300_000;
	let downloaded = false;
	let failureCategory = "transport";
	for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt++) {
		const remaining = deadline - Date.now();
		try {
			execFileSync("/usr/bin/curl", [
				"--fail", "--location", "--continue-at", "-", "--connect-timeout", "15",
				"--max-time", String(Math.max(1, Math.min(30, Math.floor(remaining / 1000)))),
				"--output", archive, artifact.url,
			], { stdio: ["ignore", "ignore", "pipe"], timeout: remaining });
			downloaded = true;
			break;
		} catch (error) {
			failureCategory = classifyDownloadFailure(error);
			if (failureCategory === "http") break;
			// Only a read-only build artifact resumes; its checksum still gates use.
		}
	}
	if (!downloaded) throw chromiumFailure(failureCategory, "Chromium release asset unavailable");
	const bytes = await readFile(archive);
	if (createHash("sha256").update(bytes).digest("hex") !== artifact.archiveSha256) throw chromiumFailure("archive_checksum", "Chromium archive checksum mismatch");
	execFileSync("unzip", ["-q", archive, "-d", staging], { stdio: "ignore" });
	const executable = join(staging, artifact.executable);
	if (createHash("sha256").update(await readFile(executable)).digest("hex") !== artifact.executableSha256) throw chromiumFailure("executable_checksum", "Chromium executable checksum mismatch");
	await mkdir(resolve(destination), { recursive: true });
	execFileSync("cp", ["-R", join(staging, artifact.directory), resolve(destination)], { stdio: "ignore" });
	await copyFile(releasePath, resolve(destination, "release.json"));
	execFileSync("chown", ["-R", "0:0", resolve(destination)]);
	execFileSync("chmod", ["-R", "a-w", resolve(destination)]);
} finally {
	await rm(staging, { recursive: true, force: true });
}
