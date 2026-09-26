import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(
	new URL(
		"../.agents/skills/coordination-harness/scripts/coordination.ts",
		import.meta.url,
	),
);
const replay = fileURLToPath(
	new URL("./coordination-harness-replay.ts", import.meta.url),
);
const body = `## Problem
Missing startup receipt.
## Scope
Bounded startup only.
## Acceptance criteria
- [ ] **AC-1:** Read current Issue and Git facts.
- [ ] **AC-2:** Write a bounded receipt.
## Validation
Run actual startup CLI.
## Blocked by
None
`;

async function setup(t: { after: (cleanup: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "coordination-start-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-b", "poc/startup");
	git("config", "core.hooksPath", join(root, "no-hooks"));
	git("config", "commit.gpgsign", "false");
	git("remote", "add", "origin", "https://github.com/example/repo.git");
	git("config", "user.name", "Startup Test");
	git("config", "user.email", "startup@example.invalid");
	await writeFile(join(root, ".gitignore"), "/.local-coordination/\n");
	await writeFile(join(root, "feature.ts"), "export const phase = 'base';\n");
	git("add", ".");
	git("commit", "-m", "test: base");
	const base = git("rev-parse", "HEAD");
	git("branch", "base");
	await writeFile(
		join(root, "feature.ts"),
		"export const phase = 'changed';\n",
	);
	git("add", "feature.ts");
	git("commit", "-m", "test: slice");
	const head = git("rev-parse", "HEAD");
	const local = join(root, ".local-coordination");
	await mkdir(local);
	const bin = join(local, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "gh"),
		`#!/bin/sh\nexec "$STARTUP_TEST_NODE" "$STARTUP_TEST_REPLAY" "$GH_REPLAY_FIXTURE" "$GH_REPLAY_CALLS" "$@"\n`,
	);
	await chmod(join(bin, "gh"), 0o755);
	const fixture = {
		repository: {
			nameWithOwner: "example/repo",
			url: "https://github.com/example/repo",
		},
		issue: {
			number: 691,
			title: "Startup",
			state: "OPEN",
			url: "https://github.com/example/repo/issues/691",
			body,
			updatedAt: "2026-09-26T00:00:00Z",
			milestone: null as {
				number: number;
				title: string;
				state: string;
				url: string;
			} | null,
			closedByPullRequestsReferences: {
				nodes: [{ number: 698 }],
				pageInfo: { hasNextPage: false },
			},
		},
		dependencies: [] as { number: number; state: string; html_url: string }[],
		pr: {
			number: 698,
			url: "https://github.com/example/repo/pull/698",
			state: "OPEN",
			headRefOid: head,
			baseRefName: "main",
			statusCheckRollup: [
				{
					name: "CI",
					status: "COMPLETED",
					conclusion: "SUCCESS",
					detailsUrl: "https://github.com/example/repo/actions/runs/1",
				},
			],
		},
		fail: "",
		malformed: false,
	};
	const declaration = {
		repository: "example/repo",
		issue: 691,
		baseRef: "base",
		goalContext: "existing-goal",
		slice: { name: "startup", acceptanceCriteria: ["AC-1", "AC-2"] },
		roles: {
			owner: "coordinator",
			writer: "writer",
			verifier: "verifier" as string | null,
		},
		resources: { files: ["feature.ts"], external: [] },
		validation: ["node --test tests/coordination-harness.test.ts"],
	};
	const run = async () => {
		await writeFile(join(local, "fixture.json"), JSON.stringify(fixture));
		await writeFile(
			join(local, "declaration.json"),
			JSON.stringify(declaration),
		);
		return spawnSync(
			process.execPath,
			[cli, "start", join(local, "declaration.json")],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					STARTUP_TEST_NODE: process.execPath,
					STARTUP_TEST_REPLAY: replay,
					GH_REPLAY_FIXTURE: join(local, "fixture.json"),
					GH_REPLAY_CALLS: join(local, "calls.jsonl"),
				},
			},
		);
	};
	return { root, local, git, base, head, fixture, declaration, run };
}

test("actual CLI reads Git and replayed gh, writes ignored metadata, and replaces stale caches", async (t) => {
	const ctx = await setup(t);
	await writeFile(
		join(ctx.root, "feature.ts"),
		"export const phase = 'dirty';\n",
	);
	await writeFile(
		join(ctx.root, "extra.ts"),
		"private local diff MUST_NOT_LEAK\n",
	);
	ctx.declaration.resources.files.push("extra.ts");
	const result = await ctx.run();
	assert.equal(result.status, 0, result.stderr);
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.stage, "Ready to implement");
	assert.deepEqual(receipt.facts.repository, {
		name: "example/repo",
		url: "https://github.com/example/repo",
	});
	assert.equal(receipt.facts.worktree.baseSha, ctx.base);
	assert.equal(receipt.facts.worktree.headSha, ctx.head);
	assert.equal(receipt.facts.worktree.branch, "poc/startup");
	assert.equal(receipt.facts.worktree.dirty, true);
	assert.deepEqual(receipt.facts.worktree.changedFiles, [
		"extra.ts",
		"feature.ts",
	]);
	assert.match(receipt.facts.worktree.diffSha256, /^[a-f0-9]{64}$/);
	assert.equal(receipt.facts.pullRequests[0].headSha, ctx.head);
	assert.equal(receipt.facts.pullRequests[0].checks[0].conclusion, "SUCCESS");
	assert.deepEqual(receipt.facts.milestone, { observed: "none" });
	assert.deepEqual(receipt.slice, ctx.declaration.slice);
	assert.deepEqual(receipt.resources, ctx.declaration.resources);
	assert.deepEqual(receipt.validation, ctx.declaration.validation);
	for (const file of ["session.json", "SESSION_BOARD.md", "CONTEXT.md"]) {
		const cached = await readFile(join(ctx.local, "issue-691", file), "utf8");
		assert.match(cached, /Ready to implement/);
		assert.doesNotMatch(
			cached,
			/MUST_NOT_LEAK|Missing startup receipt|export const/,
		);
		assert.equal(
			ctx.git("check-ignore", `.local-coordination/issue-691/${file}`),
			`.local-coordination/issue-691/${file}`,
		);
	}
	const calls = (await readFile(join(ctx.local, "calls.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		calls.map((args) => args.slice(0, 2)),
		[
			["repo", "view"],
			["api", "graphql"],
			["api", "--paginate"],
			["pr", "list"],
			["pr", "view"],
		],
	);
	await writeFile(
		join(ctx.local, "issue-691", "session.json"),
		'{"stage":"Accepted","headSha":"stale"}',
	);
	ctx.fixture.pr.headRefOid = "c".repeat(40);
	const rebuilt = await ctx.run();
	assert.equal(rebuilt.status, 0);
	assert.equal(
		JSON.parse(rebuilt.stdout).facts.pullRequests[0].headSha,
		"c".repeat(40),
	);
	assert.doesNotMatch(
		await readFile(join(ctx.local, "issue-691", "session.json"), "utf8"),
		/Accepted|stale/,
	);
});

test("missing stable AC and incomplete contract block the session entrance", async (t) => {
	const ctx = await setup(t);
	ctx.fixture.issue.body = body.replace("**AC-1:** ", "");
	const result = await ctx.run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).stage, "Blocked");
	assert.match(result.stdout, /unique stable AC-N/);
	ctx.fixture.issue.body = body.replace("## Validation", "## Other");
	assert.match((await ctx.run()).stdout, /missing or duplicate Validation/);
	ctx.fixture.issue.body = body.replace("None", "#690");
	assert.match((await ctx.run()).stdout, /declared dependency #690 missing/);
});

test("native dependency stays blocking even when prose says None", async (t) => {
	const ctx = await setup(t);
	ctx.fixture.issue.milestone = {
		number: 1,
		title: "Startup trial",
		state: "OPEN",
		url: "https://github.com/example/repo/milestone/1",
	};
	ctx.fixture.dependencies.push({
		number: 690,
		state: "open",
		html_url: "https://github.com/example/repo/issues/690",
	});
	const result = await ctx.run();
	assert.equal(result.status, 1);
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.stage, "Blocked");
	assert.equal(receipt.blockers[0].code, "unresolved_dependency");
	assert.equal(receipt.facts.dependencies[0].number, 690);
	assert.deepEqual(receipt.facts.milestone, ctx.fixture.issue.milestone);
});

test("failed gh read produces Blocked and suppresses sensitive tool output", async (t) => {
	const ctx = await setup(t);
	ctx.fixture.fail = "api --paginate";
	const result = await ctx.run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).stage, "Blocked");
	assert.equal(JSON.parse(result.stdout).facts, null);
	assert.doesNotMatch(result.stdout + result.stderr, /MUST_NOT_LEAK/);
	assert.match(result.stdout, /read failed/);
	ctx.fixture.fail = "";
	ctx.fixture.malformed = true;
	const malformed = await ctx.run();
	assert.equal(malformed.status, 1);
	assert.doesNotMatch(malformed.stdout + malformed.stderr, /MUST_NOT_LEAK/);
});

test("unassigned roles, missing slice AC and files beyond the declared boundary cannot be Ready", async (t) => {
	const ctx = await setup(t);
	ctx.declaration.roles.verifier = null;
	ctx.declaration.slice.acceptanceCriteria.push("AC-9");
	await writeFile(join(ctx.root, "other.ts"), "unowned\n");
	const result = await ctx.run();
	assert.equal(result.status, 1);
	const receipt = JSON.parse(result.stdout);
	assert.equal(receipt.roles.verifier, "unassigned");
	assert.deepEqual(
		receipt.blockers.map((blocker: { code: string }) => blocker.code),
		["ownership_incomplete", "slice_contract_missing", "file_outside_boundary"],
	);
});

test("an unignored cache or missing base stops startup without fabricating Ready", async (t) => {
	const ctx = await setup(t);
	ctx.declaration.baseRef = "missing-base";
	let result = await ctx.run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).stage, "Blocked");
	await writeFile(join(ctx.root, ".gitignore"), "");
	result = await ctx.run();
	assert.equal(result.status, 1);
	assert.doesNotMatch(result.stdout, /Ready to implement/);
});

test("repository mismatch and failed identity reads block the actual CLI", async (t) => {
	const ctx = await setup(t);
	ctx.declaration.repository = "example/other";
	let result = await ctx.run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).stage, "Blocked");
	assert.match(result.stdout, /does not match current worktree repository/);
	ctx.declaration.repository = "example/repo";
	ctx.fixture.fail = "repo view";
	result = await ctx.run();
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).stage, "Blocked");
	assert.match(result.stdout, /gh repo read failed/);
});
