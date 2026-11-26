import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// GitHub's archive/API hosts are reachable from ACK when its Git smart-HTTP endpoint stalls.
// Recreate the original signed commit object and require the archive's complete Git tree to match.
const repository = "AgoraIO-Extensions/agent-infra";
const sha40 = /^[a-f0-9]{40}$/u;
const run = (command: string, args: string[], cwd: string, input?: string) => execFileSync(command, args, {
	cwd, input, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
const check = (ok: unknown, code: string) => { if (!ok) throw new Error(code); };

export function checkoutSource(sha: string, directory: string): void {
	check(sha40.test(sha) && directory.startsWith("/"), "SOURCE_INPUT_INVALID");
	check(!existsSync(directory) || readdirSync(directory).length === 0, "SOURCE_DESTINATION_NOT_EMPTY");
	mkdirSync(directory, { recursive: true });
	const metadata = JSON.parse(run("gh", ["api", `repos/${repository}/git/commits/${sha}`], directory));
	check(metadata.sha === sha && sha40.test(metadata.tree?.sha ?? ""), "SOURCE_COMMIT_MISMATCH");
	const { payload, signature } = metadata.verification ?? {};
	if (!metadata.verification?.verified || typeof payload !== "string" || typeof signature !== "string") {
		// Unsigned commits keep the existing Git transport and its exact HEAD check.
		run("git", ["init", "--quiet"], directory);
		for (let attempt = 1; attempt <= 4; attempt++) {
			try {
				run("git", ["fetch", "--quiet", "--depth", "1", `https://github.com/${repository}`, sha], directory);
				break;
			} catch (error) {
				if (attempt === 4) throw error;
			}
		}
		run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], directory);
		check(run("git", ["rev-parse", "HEAD"], directory).trim() === sha, "SOURCE_COMMIT_MISMATCH");
		return;
	}
	const split = payload.indexOf("\n\n");
	check(split > 0 && payload.startsWith(`tree ${metadata.tree.sha}\n`), "SOURCE_COMMIT_INVALID");
	// Preserve the signature's trailing newline: its continuation line is part of the commit hash.
	const commit = `${payload.slice(0, split)}\ngpgsig ${signature.replaceAll("\n", "\n ")}\n\n${payload.slice(split + 2)}`;
	const digest = createHash("sha1").update(`commit ${Buffer.byteLength(commit)}\0`).update(commit).digest("hex");
	check(digest === sha, "SOURCE_COMMIT_MISMATCH");
	const temporary = mkdtempSync(join(tmpdir(), "deploy-source-"));
	try {
		const archive = join(temporary, "source.tar.gz");
		run("curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--silent", "--show-error", "--connect-timeout", "10", "--max-time", "20", "--retry", "2", "--retry-all-errors", "--output", archive, `https://codeload.github.com/${repository}/tar.gz/${sha}`], directory);
		run("tar", ["-xzf", archive, "--strip-components=1", "-C", directory], directory);
		run("git", ["init", "--quiet"], directory);
		run("git", ["-c", "core.autocrlf=false", "-c", "core.filemode=true", "add", "--force", "--all"], directory);
		check(run("git", ["write-tree"], directory).trim() === metadata.tree.sha, "SOURCE_ARCHIVE_TREE_MISMATCH");
		check(run("git", ["hash-object", "-t", "commit", "-w", "--stdin"], directory, commit).trim() === sha, "SOURCE_COMMIT_MISMATCH");
		run("git", ["update-ref", "HEAD", sha], directory);
		check(run("git", ["status", "--porcelain"], directory).trim() === "", "SOURCE_WORKTREE_DIRTY");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		checkoutSource(process.argv[2] ?? "", process.argv[3] ?? "");
		console.log("Source checkout verified");
	} catch (error) {
		const code = error instanceof Error && /^SOURCE_[A-Z_]+$/u.test(error.message) ? error.message : "SOURCE_CHECKOUT_FAILED";
		console.error(code);
		process.exitCode = 1;
	}
}
