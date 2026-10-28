import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type FrontierInput,
	generateRoadmapGoal,
	type IssueObservation,
} from "../.agents/skills/gen-goal-with-roadmap/frontier.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const issueUrl = (number: number) =>
	`https://github.com/AgoraIO-Extensions/agent-infra/issues/${number}`;

function issue(
	number: number,
	changes: Partial<IssueObservation> = {},
): IssueObservation {
	return {
		number,
		title: `Implementation ${number}`,
		kind: "implementation",
		state: "open",
		revision: `issue-revision-${number}`,
		mapNumber: 10,
		priority: "P1",
		milestone: "M1",
		acceptanceCriteria: ["AC-1", "AC-2"],
		blockers: [90],
		blockersComplete: true,
		ownership: {
			complete: true,
			assignees: [],
			prs: [],
			branches: [],
			worktrees: [],
		},
		scope: { paths: [`packages/feature-${number}`], validation: "pnpm test" },
		project: {
			url: "https://github.com/orgs/AgoraIO-Extensions/projects/1",
			status: "Ready",
			fields: { priority: "P1" },
		},
		evidence: {
			issue: issueUrl(number),
			dependencies: issueUrl(number),
			ownership: issueUrl(number),
		},
		...changes,
	};
}

function fixture(references?: number[]): FrontierInput {
	return {
		references,
		repository: {
			url: "https://github.com/AgoraIO-Extensions/agent-infra",
			baseRef: "main",
			baseSha,
			headSha,
			evidence: "https://github.com/AgoraIO-Extensions/agent-infra/tree/main",
		},
		issues: [
			issue(10, {
				kind: "map",
				mapNumber: null,
				priority: null,
				blockers: [],
				acceptanceCriteria: [],
				scope: { paths: ["packages"], validation: "pnpm test" },
			}),
			issue(90, { state: "closed", mapNumber: null }),
			issue(24, { priority: "P2" }),
			issue(23, { priority: "P0" }),
			issue(22, { priority: "P1" }),
			issue(21, { priority: "P0" }),
		],
	};
}

function mustGoal(input: FrontierInput) {
	const result = generateRoadmapGoal(input);
	if (result.kind !== "goal") throw new Error(JSON.stringify(result));
	return result;
}

function findIssue(input: FrontierInput, number: number): IssueObservation {
	const found = input.issues.find((item) => item.number === number);
	if (!found) throw new Error(`Missing fixture Issue #${number}`);
	return found;
}

describe("Roadmap frontier", () => {
	it("filters the complete free frontier and ranks at most three by priority and Issue number", () => {
		const input = fixture();
		input.issues.push(
			issue(20, {
				priority: "P0",
				ownership: {
					complete: true,
					assignees: ["private-user"],
					prs: [],
					branches: [],
					worktrees: [],
				},
			}),
		);
		input.issues.push(issue(19, { priority: "P0", blockersComplete: false }));
		const result = generateRoadmapGoal(input);
		expect(result.kind).toBe("candidates");
		if (result.kind !== "candidates") return;
		expect(result.candidates.map((item) => item.issue)).toEqual([21, 23, 22]);
		expect(result.candidates.map((item) => item.invocation)).toEqual([
			"$gen-goal-with-roadmap #10 #21",
			"$gen-goal-with-roadmap #10 #23",
			"$gen-goal-with-roadmap #10 #22",
		]);
		for (const candidate of result.candidates)
			expect(candidate.evidence).toContain(issueUrl(90));
		expect(
			result.excluded.find((item) => item.issue === 20)?.reasons,
		).toContain("active assignee, PR, branch or worktree conflict");
		expect(JSON.stringify(result)).not.toContain("private-user");
	});

	it("rejects all explicit references when any dependency, ownership, Map or AC fact fails", () => {
		const input = fixture([10, 21, 22]);
		findIssue(input, 90).state = "open";
		let result = generateRoadmapGoal(input);
		expect(result.kind).toBe("rejected");
		expect(JSON.stringify(result)).toContain("native blocker #90");
		findIssue(input, 90).state = "closed";
		findIssue(input, 22).ownership.branches = ["private/branch"];
		result = generateRoadmapGoal(input);
		expect(result.kind).toBe("rejected");
		expect(JSON.stringify(result)).not.toContain("private/branch");
		findIssue(input, 22).ownership.branches = [];
		findIssue(input, 22).ownership.prs = [
			{
				number: 701,
				state: "open",
				headSha,
				baseSha,
				url: "https://github.com/AgoraIO-Extensions/agent-infra/pull/701",
			},
		];
		expect(JSON.stringify(generateRoadmapGoal(input))).toContain(
			"active assignee, PR, branch or worktree conflict",
		);
		findIssue(input, 22).ownership.prs = [];
		findIssue(input, 22).acceptanceCriteria = [];
		result = generateRoadmapGoal(input);
		expect(JSON.stringify(result)).toContain(
			"stable acceptance criteria missing",
		);
		findIssue(input, 22).acceptanceCriteria = ["AC-1"];
		findIssue(input, 10).blockers = [91];
		expect(JSON.stringify(generateRoadmapGoal(input))).toContain(
			"Map state or evidence incomplete",
		);
		findIssue(input, 10).blockers = [];
		findIssue(input, 22).mapNumber = 11;
		expect(JSON.stringify(generateRoadmapGoal(input))).toContain(
			"references do not resolve to one Map",
		);
	});

	it("rejects closed and unsupported explicit references instead of silently dropping them", () => {
		const input = fixture([10, 21, 90]);
		expect(generateRoadmapGoal(input).kind).toBe("rejected");
		Object.assign(findIssue(input, 90), { kind: "dependency" });
		const result = generateRoadmapGoal(input);
		expect(result.kind).toBe("rejected");
		expect(JSON.stringify(result)).toContain("unsupported reference kind: #90");
	});

	it("Map-only invocation freezes only eligible children and rejects overlapping lane scope", () => {
		const input = fixture([10]);
		findIssue(input, 22).ownership.worktrees = ["/private/worktree"];
		const goal = mustGoal(input);
		expect(goal.snapshot.issues).toEqual([21, 23, 24]);
		expect(goal.instruction).not.toContain("/private/worktree");
		findIssue(input, 23).scope.paths = ["packages/feature-21/subdir"];
		expect(JSON.stringify(generateRoadmapGoal(input))).toContain(
			"overlapping lane scope",
		);
	});

	it("offers only candidates whose complete invocation passes the Map boundary check", () => {
		const input = fixture();
		findIssue(input, 21).scope.paths = ["apps/outside-map"];
		const candidates = generateRoadmapGoal(input);
		expect(candidates.kind).toBe("candidates");
		if (candidates.kind !== "candidates") return;
		expect(candidates.candidates.map((item) => item.issue)).toEqual([
			23, 22, 24,
		]);
		expect(
			candidates.excluded.find((item) => item.issue === 21)?.reasons,
		).toContain("outside Map file scope");
		input.references = [10, 21];
		expect(generateRoadmapGoal(input).kind).toBe("rejected");
		for (const candidate of candidates.candidates) {
			input.references = [candidate.map, candidate.issue];
			expect(generateRoadmapGoal(input).kind).toBe("goal");
		}
	});

	it("rejects Maps without file boundaries in discovery and explicit modes", () => {
		const input = fixture();
		findIssue(input, 10).scope.paths = [];
		const candidates = generateRoadmapGoal(input);
		expect(candidates.kind).toBe("candidates");
		if (candidates.kind !== "candidates") return;
		expect(candidates.candidates).toEqual([]);
		input.references = [10, 21];
		const result = generateRoadmapGoal(input);
		expect(result.kind).toBe("rejected");
		expect(JSON.stringify(result)).toContain(
			"Map state or evidence incomplete",
		);
	});

	it("snapshot hash is stable under observation ordering and changes with relevant facts", () => {
		const input = fixture([10, 21]);
		const first = mustGoal(input);
		expect(first.snapshot.observed.dependencies).toEqual([
			{ number: 90, state: "closed", revision: "issue-revision-90" },
		]);
		expect(first.snapshot.observed.issues[0]?.ownership).toEqual({
			assigneeCount: 0,
			branchCount: 0,
			worktreeCount: 0,
			prs: [],
		});
		input.issues.reverse();
		expect(mustGoal(input).snapshot.sha256).toBe(first.snapshot.sha256);
		const dependency = findIssue(input, 90);
		dependency.revision = "new-closed-blocker-revision";
		const second = mustGoal(input);
		expect(second.snapshot.sha256).not.toBe(first.snapshot.sha256);
		const selected = findIssue(input, 21);
		selected.ownership.prs.push({
			number: 700,
			state: "closed",
			headSha: "c".repeat(40),
			baseSha,
			url: "https://github.com/AgoraIO-Extensions/agent-infra/pull/700",
		});
		const third = mustGoal(input);
		expect(third.snapshot.sha256).not.toBe(second.snapshot.sha256);
		selected.project.fields.priority = "P0";
		expect(mustGoal(input).snapshot.sha256).not.toBe(third.snapshot.sha256);
		input.repository.headSha = "d".repeat(40);
		expect(mustGoal(input).snapshot.headSha).toBe("d".repeat(40));
	});

	it("generated Goal carries the execution contract and omits private identities", () => {
		const input = fixture([10, 21]);
		findIssue(input, 21).project.fields.owner = "private-user@example.com";
		const result = mustGoal(input);
		expect(result.snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
		for (const term of [
			"ownership ledger",
			"Handoff",
			"finite",
			"Ready to implement",
			"Implemented",
			"Integrated",
			"Accepted",
			"exact-head",
			"independent Verifier",
			"Terminal proof",
			"Delivered",
			"Human-retired",
		])
			expect(result.instruction).toContain(term);
		expect(JSON.stringify(result)).not.toContain("private-user@example.com");
		expect(result.snapshot.evidence).toContain(issueUrl(90));
	});

	it("rejects validation entries that could expose identities or machine paths", () => {
		const input = fixture([10, 21]);
		findIssue(input, 21).scope.validation = "pnpm test --user luxuhui";
		const personal = generateRoadmapGoal(input);
		expect(personal.kind).toBe("rejected");
		expect(JSON.stringify(personal)).not.toContain("luxuhui");
		findIssue(input, 21).scope.validation = "pnpm test /tmp/private";
		const machine = generateRoadmapGoal(input);
		expect(machine.kind).toBe("rejected");
		expect(JSON.stringify(machine)).not.toContain("/tmp/private");
	});

	it("CLI consumes JSON stdin and emits one JSON result without files", () => {
		const path = fileURLToPath(
			new URL(
				"../.agents/skills/gen-goal-with-roadmap/frontier.ts",
				import.meta.url,
			),
		);
		const success = spawnSync(process.execPath, [path], {
			input: JSON.stringify(fixture([10, 21])),
			encoding: "utf8",
		});
		expect(success.status).toBe(0);
		expect(success.stderr).toBe("");
		expect(JSON.parse(success.stdout).kind).toBe("goal");
		const invalid = spawnSync(process.execPath, [path], {
			input: "{",
			encoding: "utf8",
		});
		expect(invalid.status).toBe(2);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain("Invalid normalized frontier JSON input");
	});
});
