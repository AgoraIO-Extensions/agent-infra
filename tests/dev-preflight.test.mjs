import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validationPlan, verifyWorktree } from "../scripts/dev-preflight.mjs";

const sourceSha = "a".repeat(40);

test("validation plan keeps documentation changes narrow", () => {
	const plan = validationPlan(
		["docs/agents/development-harness.md", "AGENTS.md"],
		sourceSha,
	);
	assert.deepEqual(plan.required, [
		"git diff --check",
		"markdownlint",
		"markdown-link-check",
	]);
	assert.equal(plan.sourceSha, sourceSha);
});

test("validation plan selects code, workflow, and deploy checks", () => {
	const plan = validationPlan(
		[
			"packages/example/src/index.ts",
			".github/workflows/ci.yml",
			"deploy/Dockerfile",
		],
		sourceSha,
	);
	assert.ok(plan.required.includes("pnpm check"));
	assert.ok(plan.required.includes("pnpm check-types"));
	assert.ok(plan.required.includes("focused tests for changed modules"));
	assert.ok(plan.required.includes("workflow policy and actionlint"));
	assert.ok(plan.required.includes("pnpm docker:build"));
});

test("worktree verification rejects a stale HEAD", async () => {
	const directory = await mkdtemp(join(tmpdir(), "agent-infra-dev-preflight-"));
	try {
		execFileSync("git", ["init", "--initial-branch=main"], {
			cwd: directory,
			stdio: "ignore",
		});
		execFileSync("git", ["config", "user.email", "test@example.invalid"], {
			cwd: directory,
		});
		execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
		await writeFile(join(directory, "README"), "test\n");
		execFileSync("git", ["add", "README"], { cwd: directory });
		const tree = execFileSync("git", ["write-tree"], {
			cwd: directory,
			encoding: "utf8",
		}).trim();
		const commit = execFileSync("git", ["commit-tree", tree, "-m", "test"], {
			cwd: directory,
			encoding: "utf8",
		}).trim();
		execFileSync("git", ["update-ref", "refs/heads/main", commit], {
			cwd: directory,
		});
		const sha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: directory,
			encoding: "utf8",
		}).trim();
		assert.deepEqual(verifyWorktree(directory, sha), {
			worktree: directory,
			head: sha,
			sourceSha: sha,
		});
		assert.throws(
			() => verifyWorktree(directory, "b".repeat(40)),
			/does not match source SHA/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
