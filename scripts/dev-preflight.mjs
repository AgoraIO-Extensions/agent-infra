#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const gitBin = "git";

function runGit(args, options = {}) {
	return execFileSync(gitBin, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
		timeout: options.timeout ?? 30_000,
	}).trim();
}

function fail(message) {
	throw new Error(message);
}

export function refreshMain() {
	runGit(["fetch", "origin", "main:refs/remotes/origin/main"]);
	const sourceSha = runGit(["rev-parse", "refs/remotes/origin/main"]);
	if (!/^[0-9a-f]{40}$/.test(sourceSha))
		fail("origin/main is not an immutable commit SHA");
	return sourceSha;
}

export function verifyWorktree(worktree, sourceSha) {
	const resolvedWorktree = resolve(worktree);
	if (!existsSync(resolvedWorktree))
		fail(`Worktree does not exist: ${resolvedWorktree}`);
	const head = runGit(["rev-parse", "HEAD"], { cwd: resolvedWorktree });
	if (head !== sourceSha)
		fail(`Worktree HEAD ${head} does not match source SHA ${sourceSha}`);
	return { worktree: resolvedWorktree, head, sourceSha };
}

export function createWorktree(worktree, branch) {
	if (!worktree || !branch) fail("Usage: worktree <path> <branch>");
	const sourceSha = refreshMain();
	const resolvedWorktree = resolve(worktree);
	runGit(["worktree", "add", "-b", branch, resolvedWorktree, sourceSha]);
	const verified = verifyWorktree(resolvedWorktree, sourceSha);
	return { baseRef: "origin/main", branch, ...verified };
}

function changedFiles(base) {
	const names = [
		runGit(["diff", "--name-only", `${base}...HEAD`]),
		runGit(["diff", "--name-only"]),
		runGit(["diff", "--name-only", "--cached"]),
		runGit(["ls-files", "--others", "--exclude-standard"]),
	];
	return [
		...new Set(names.flatMap((value) => value.split("\n").filter(Boolean))),
	];
}

export function validationPlan(files, sourceSha) {
	const names = [...files];
	const docsOnly =
		names.length > 0 &&
		names.every((file) =>
			/^(README\.md|AGENTS\.md|\.github\/.*\.md|docs\/.*\.md)$/.test(file),
		);
	const markdownChanged = names.some((file) =>
		/^(README\.md|AGENTS\.md|\.github\/.*\.md|docs\/.*\.md)$/.test(file),
	);
	const workflowChanged = names.some(
		(file) =>
			file.startsWith(".github/workflows/") ||
			file.startsWith(".github/scripts/"),
	);
	const codeChanged = names.some((file) =>
		/^(apps|packages|tests)\//.test(file),
	);
	const scriptChanged = names.some((file) => file.startsWith("scripts/"));
	const dependencyChanged = names.some((file) =>
		/(^|\/)(package\.json|pnpm-lock\.yaml|turbo\.json)$/.test(file),
	);
	const deployChanged = names.some((file) =>
		/^(deploy|docker-compose\.ya?ml|Dockerfile)/.test(file),
	);
	const required = new Set(["git diff --check"]);
	const skipped = [];
	if (markdownChanged) {
		required.add("markdownlint");
		required.add("markdown-link-check");
	} else {
		for (const command of ["markdownlint", "markdown-link-check"]) {
			skipped.push({
				command,
				reason: "no checked Markdown files changed",
			});
		}
	}
	if (!docsOnly) {
		if (codeChanged || dependencyChanged) {
			required.add("pnpm check");
			required.add("pnpm check-types");
			required.add("focused tests for changed modules");
			required.add("pnpm build");
			required.add("pnpm smoke");
		} else
			skipped.push({
				command: "pnpm check-types",
				reason: "no application, package, or test files changed",
			});
		if (codeChanged || scriptChanged) required.add("pnpm test:meta");
		else
			skipped.push({
				command: "pnpm test:meta",
				reason: "no test or repository script changed",
			});
		if (workflowChanged) required.add("workflow policy and actionlint");
		else
			skipped.push({
				command: "workflow policy and actionlint",
				reason: "no workflow or GitHub script changed",
			});
		if (deployChanged || codeChanged || dependencyChanged)
			required.add("pnpm docker:build");
		else
			skipped.push({
				command: "pnpm docker:build",
				reason: "no deploy, application, package, test, or dependency changes",
			});
	}
	return { sourceSha, files: names, required: [...required], skipped };
}

function main() {
	const [action, ...args] = process.argv.slice(2);
	if (action === "worktree") {
		console.log(JSON.stringify(createWorktree(args[0], args[1]), null, 2));
		return;
	}
	if (action === "verify") {
		if (!args[0] || !args[1]) fail("Usage: verify <path> <source-sha>");
		console.log(JSON.stringify(verifyWorktree(args[0], args[1]), null, 2));
		return;
	}
	if (action === "plan") {
		const sourceSha = runGit(["rev-parse", "HEAD"]);
		console.log(
			JSON.stringify(
				validationPlan(
					args.length ? args : changedFiles("origin/main"),
					sourceSha,
				),
				null,
				2,
			),
		);
		return;
	}
	fail("Usage: dev-preflight.mjs <worktree|verify|plan> ...");
}

if (process.argv[1]?.endsWith("/scripts/dev-preflight.mjs")) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
