import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	advanceCoordinationStage,
	assignResourceOwnership,
	CoordinationError,
	handoffCoordinationSession,
	recordVerifierResult,
	startCoordinationSession,
} from "../.agents/skills/coordination-harness/scripts/coordination.mjs";

const issue = (overrides = {}) => ({
	number: 691,
	title: "feat(workflow): start bounded coordination session",
	state: "OPEN",
	milestone: { number: 1, title: "coordination POC" },
	acceptanceCriteria: [
		{ id: "AC-1", text: "Record current contract and exact head" },
		{ id: "AC-2", text: "Block incomplete ownership" },
	],
	blockedBy: [],
	...overrides,
});

const worktree = (overrides = {}) => ({
	path: "/tmp/issue-690-poc",
	branch: "poc/690-coordination",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	dirty: false,
	changedFiles: [],
	...overrides,
});

const roles = {
	owner: "coordinator",
	writer: "implementation-a",
	verifier: "verifier",
};

async function outputDirectory(t) {
	const directory = await mkdtemp(join(tmpdir(), "coordination-harness-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("starts a bounded session and writes reconstructable local context", async (t) => {
	const directory = await outputDirectory(t);
	const result = await startCoordinationSession({
		issue: issue(),
		worktree: worktree(),
		roles,
		outputDirectory: directory,
	});

	assert.equal(result.stage, "Ready to implement");
	assert.equal(result.issue.number, 691);
	assert.equal(result.currentHead, "b".repeat(40));
	assert.deepEqual(result.ownership, roles);
	assert.match(
		await readFile(join(directory, "SESSION_BOARD.md"), "utf8"),
		/Ready to implement/,
	);
	assert.match(
		await readFile(join(directory, "CONTEXT.md"), "utf8"),
		/base SHA/,
	);
});

test("blocks an unresolved dependency before implementation", async (t) => {
	const directory = await outputDirectory(t);
	const result = await startCoordinationSession({
		issue: issue({ blockedBy: [{ number: 690, state: "OPEN" }] }),
		worktree: worktree(),
		roles,
		outputDirectory: directory,
	});

	assert.equal(result.stage, "Blocked");
	assert.equal(result.blockers[0].code, "unresolved_dependency");
});

test("rejects duplicate acceptance IDs and incomplete ownership", async (t) => {
	const directory = await outputDirectory(t);
	await assert.rejects(
		startCoordinationSession({
			issue: issue({
				acceptanceCriteria: [
					{ id: "AC-1", text: "first" },
					{ id: "AC-1", text: "duplicate" },
				],
			}),
			worktree: worktree(),
			roles,
			outputDirectory: directory,
		}),
		(error) =>
			error instanceof CoordinationError && error.code === "invalid_contract",
	);

	const blocked = await startCoordinationSession({
		issue: issue(),
		worktree: worktree(),
		roles: { ...roles, writer: null },
		outputDirectory: directory,
	});
	assert.equal(blocked.stage, "Blocked");
	assert.equal(blocked.blockers[0].code, "ownership_incomplete");
});

test("refuses an invalid worktree head instead of guessing current state", async (t) => {
	const directory = await outputDirectory(t);
	await assert.rejects(
		startCoordinationSession({
			issue: issue(),
			worktree: worktree({ headSha: "unknown" }),
			roles,
			outputDirectory: directory,
		}),
		(error) =>
			error instanceof CoordinationError && error.code === "invalid_worktree",
	);
});

test("rejects duplicate writers and preserves ownership through explicit handoff", async (t) => {
	const directory = await outputDirectory(t);
	const started = await startCoordinationSession({
		issue: issue(),
		worktree: worktree(),
		roles,
		outputDirectory: directory,
	});
	const claimed = assignResourceOwnership(started, {
		resource: "apps/platform-api",
		writer: "implementation-a",
	});
	assert.throws(
		() =>
			assignResourceOwnership(claimed, {
				resource: "apps/platform-api",
				writer: "implementation-b",
			}),
		(error) => error.code === "duplicate_ownership",
	);
	assert.equal(
		handoffCoordinationSession(claimed, {
			incomingWriter: "implementation-b",
			currentHead: claimed.currentHead,
			reason: "implementation-a idle",
			nextAction: "run focused checks",
		}).handoff.to,
		"implementation-b",
	);
});

test("advances stages only with current-head evidence and an independent verifier", async (t) => {
	const directory = await outputDirectory(t);
	let session = await startCoordinationSession({
		issue: issue(),
		worktree: worktree(),
		roles,
		outputDirectory: directory,
	});
	session = advanceCoordinationStage(session, {
		target: "Implemented",
		currentHead: session.currentHead,
		evidence: { kind: "focused_checks", result: "passed" },
	});
	session = recordVerifierResult(session, {
		currentHead: session.currentHead,
		status: "passed",
		evidence: { kind: "vertical_journey", result: "passed" },
	});
	session = advanceCoordinationStage(session, {
		target: "Integrated",
		currentHead: session.currentHead,
		evidence: { kind: "vertical_journey", result: "passed" },
	});
	assert.throws(
		() =>
			advanceCoordinationStage(session, {
				target: "Accepted",
				currentHead: "c".repeat(40),
				evidence: { environment: "local", command: "check", result: "passed" },
			}),
		(error) => error.code === "stale_head",
	);
	session = advanceCoordinationStage(session, {
		target: "Accepted",
		currentHead: session.currentHead,
		evidence: { environment: "local", command: "journey", result: "passed" },
	});
	assert.equal(session.stage, "Accepted");
});
