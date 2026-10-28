import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type Priority = "P0" | "P1" | "P2";

export interface IssueObservation {
	number: number;
	title: string;
	kind: "map" | "implementation";
	state: "open" | "closed";
	revision: string;
	mapNumber: number | null;
	priority: Priority | null;
	milestone: string | null;
	acceptanceCriteria: string[];
	blockers: number[];
	blockersComplete: boolean;
	ownership: {
		complete: boolean;
		assignees: string[];
		prs: {
			number: number;
			state: "open" | "closed" | "merged";
			headSha: string;
			baseSha: string;
			url: string;
		}[];
		branches: string[];
		worktrees: string[];
	};
	scope: { paths: string[]; validation: string };
	project: {
		url: string;
		status: string;
		fields: Record<string, string | null>;
	};
	evidence: { issue: string; dependencies: string; ownership: string };
}

export interface FrontierInput {
	references?: number[];
	repository: {
		url: string;
		baseRef: string;
		baseSha: string;
		headSha: string;
		evidence: string;
	};
	issues: IssueObservation[];
}

export interface SnapshotObservation {
	map: ReturnType<typeof visibleIssueFacts>;
	issues: ReturnType<typeof visibleIssueFacts>[];
	dependencies: { number: number; state: "open" | "closed"; revision: string }[];
}

export type FrontierResult =
	| {
		kind: "candidates";
		candidates: {
			issue: number;
			map: number;
			priority: Priority;
			invocation: string;
			evidence: string[];
		}[];
		excluded: { issue: number; reasons: string[] }[];
	}
	| { kind: "rejected"; reasons: string[]; evidence: string[] }
	| {
		kind: "goal";
		snapshot: {
			sha256: string;
			map: number;
			issues: number[];
			baseSha: string;
			headSha: string;
			evidence: string[];
			observed: SnapshotObservation;
		};
		instruction: string;
	};

const priorityOrder: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };
const sha = (value: string) => /^[a-f0-9]{40}$/i.test(value);
const issueNumber = (value: unknown): value is number =>
	Number.isSafeInteger(value) && Number(value) > 0;
const publicUrl = (value: unknown): value is string => {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "github.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
};
const sameRepoUrl = (value: unknown, repositoryUrl: string): value is string =>
	publicUrl(value) && (value === repositoryUrl || value.startsWith(`${repositoryUrl}/`));
const sameOrgProjectUrl = (value: unknown, repositoryUrl: string): value is string => {
	if (!publicUrl(value)) return false;
	const owner = new URL(repositoryUrl).pathname.split("/")[1];
	return value.startsWith(`https://github.com/orgs/${owner}/projects/`);
};
const safeName = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length < 160 &&
	!/[\r\n`$@=\\]/.test(value) &&
	!value.includes("/Users/") &&
	!value.includes("/home/");
const repoPath = (value: unknown): value is string =>
	safeName(value) &&
	!value.startsWith("/") &&
	!value.split("/").includes("..") &&
	!value.includes(":");
const milestone = (value: unknown): value is string | null =>
	value === null || safeName(value);
const validationEntry = (value: unknown): value is string =>
	typeof value === "string" &&
	/^pnpm (?:check|check-types|test|build|smoke|docker:build)$/.test(value);
const projectEvidence = (value: IssueObservation["project"] | undefined): boolean =>
	Boolean(value && publicUrl(value.url) && safeName(value.status) &&
		value.fields && !Array.isArray(value.fields) &&
		Object.values(value.fields).every((field) => field === null || typeof field === "string"));
const ownershipEvidence = (value: IssueObservation["ownership"] | undefined): boolean =>
	Boolean(value?.complete && Array.isArray(value.assignees) &&
		value.assignees.every((name) => typeof name === "string") &&
		Array.isArray(value.branches) && value.branches.every((name) => typeof name === "string") &&
		Array.isArray(value.worktrees) && value.worktrees.every((name) => typeof name === "string") &&
		Array.isArray(value.prs) && value.prs.every((pr) =>
			issueNumber(pr.number) && ["open", "closed", "merged"].includes(pr.state) &&
			sha(pr.headSha) && sha(pr.baseSha) && publicUrl(pr.url)));

function distinct<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sortedIssueFacts(issue: IssueObservation) {
	return {
		...issue,
		acceptanceCriteria: [...issue.acceptanceCriteria].sort(),
		blockers: [...issue.blockers].sort((a, b) => a - b),
		ownership: {
			...issue.ownership,
			assignees: [...issue.ownership.assignees].sort(),
			prs: [...issue.ownership.prs].sort((a, b) => a.number - b.number),
			branches: [...issue.ownership.branches].sort(),
			worktrees: [...issue.ownership.worktrees].sort(),
		},
		scope: { ...issue.scope, paths: [...issue.scope.paths].sort() },
	};
}

function visibleIssueFacts(issue: IssueObservation) {
	return {
		number: issue.number,
		state: issue.state,
		revision: issue.revision,
		priority: issue.priority,
		milestone: issue.milestone,
		acceptanceCriteria: [...issue.acceptanceCriteria].sort(),
		blockers: [...issue.blockers].sort((a, b) => a - b),
		ownership: {
			assigneeCount: issue.ownership.assignees.length,
			branchCount: issue.ownership.branches.length,
			worktreeCount: issue.ownership.worktrees.length,
			prs: [...issue.ownership.prs].sort((a, b) => a.number - b.number),
		},
		project: {
			url: issue.project.url,
			status: issue.project.status,
			fieldCount: Object.keys(issue.project.fields).length,
		},
		scope: { paths: [...issue.scope.paths].sort(), validation: issue.scope.validation },
	};
}

function completeMap(
	issue: IssueObservation | undefined,
	repositoryUrl: string,
	byNumber: Map<number, IssueObservation>,
): boolean {
	return Boolean(
		issue?.kind === "map" && issue.state === "open" && issue.revision &&
		milestone(issue.milestone) && issue.mapNumber === null &&
		sameRepoUrl(issue.evidence?.issue, repositoryUrl) &&
		sameRepoUrl(issue.evidence?.dependencies, repositoryUrl) &&
		sameRepoUrl(issue.evidence?.ownership, repositoryUrl) &&
		projectEvidence(issue.project) && sameOrgProjectUrl(issue.project.url, repositoryUrl) &&
		ownershipEvidence(issue.ownership) &&
		issue.ownership.prs.every((pr) => sameRepoUrl(pr.url, repositoryUrl)) &&
		Array.isArray(issue.acceptanceCriteria) && issue.blockersComplete &&
		Array.isArray(issue.blockers) && distinct(issue.blockers).length === issue.blockers.length &&
		issue.blockers.every((number) => {
			const blocker = byNumber.get(number);
			return issueNumber(number) && blocker?.state === "closed" && blocker.revision &&
				sameRepoUrl(blocker.evidence?.issue, repositoryUrl);
		}) &&
		issue.scope && Array.isArray(issue.scope.paths) && issue.scope.paths.length > 0 &&
		issue.scope.paths.every(repoPath) && validationEntry(issue.scope.validation),
	);
}

function eligibility(
	issue: IssueObservation,
	byNumber: Map<number, IssueObservation>,
	repositoryUrl: string,
): string[] {
	const reasons: string[] = [];
	if (issue.kind !== "implementation" || issue.state !== "open")
		reasons.push("not an open implementation Issue");
	if (!issueNumber(issue.mapNumber) || byNumber.get(issue.mapNumber)?.kind !== "map")
		reasons.push("Map relation missing or ambiguous");
	else if (!completeMap(byNumber.get(issue.mapNumber), repositoryUrl, byNumber))
		reasons.push("Map state or evidence incomplete");
	if (!issue.revision || !publicUrl(issue.evidence?.issue))
		reasons.push("Issue revision or evidence missing");
	if (!sameRepoUrl(issue.evidence?.issue, repositoryUrl) ||
		!sameRepoUrl(issue.evidence?.dependencies, repositoryUrl) ||
		!sameRepoUrl(issue.evidence?.ownership, repositoryUrl) ||
		!sameOrgProjectUrl(issue.project?.url, repositoryUrl) ||
		issue.ownership?.prs?.some((pr) => !sameRepoUrl(pr.url, repositoryUrl)))
		reasons.push("evidence pointer outside repository or Project");
	if (!milestone(issue.milestone)) reasons.push("milestone state missing");
	if (!issue.blockersComplete || !Array.isArray(issue.blockers) || !publicUrl(issue.evidence?.dependencies))
		reasons.push("native blocker state incomplete");
	else if (distinct(issue.blockers).length !== issue.blockers.length)
		reasons.push("native blocker state ambiguous");
	else for (const number of issue.blockers) {
		const dependency = byNumber.get(number);
		if (!issueNumber(number) || dependency?.state !== "closed" || !dependency.revision ||
			!sameRepoUrl(dependency.evidence?.issue, repositoryUrl)) {
			reasons.push(`native blocker #${number} is open or unobserved`);
		}
	}
	const owner = issue.ownership;
	if (!ownershipEvidence(owner) || !publicUrl(issue.evidence?.ownership))
		reasons.push("ownership evidence incomplete");
	else if (
		owner.assignees.length > 0 ||
		owner.prs.some((pr) => pr.state === "open") ||
		owner.branches.length > 0 ||
		owner.worktrees.length > 0
	) reasons.push("active assignee, PR, branch or worktree conflict");
	if (!projectEvidence(issue.project))
		reasons.push("Project evidence incomplete");
	if (!Array.isArray(issue.acceptanceCriteria) || issue.acceptanceCriteria.length === 0 ||
		issue.acceptanceCriteria.some((id) => !/^AC-[1-9]\d*$/.test(id)) ||
		distinct(issue.acceptanceCriteria).length !== issue.acceptanceCriteria.length)
		reasons.push("stable acceptance criteria missing");
	if (!issue.scope || !Array.isArray(issue.scope.paths) || issue.scope.paths.length === 0 ||
		issue.scope.paths.some((path) => !repoPath(path)) ||
		!validationEntry(issue.scope.validation))
		reasons.push("implementation scope or validation entry missing");
	if (issue.priority !== "P0" && issue.priority !== "P1" && issue.priority !== "P2")
		reasons.push("explicit priority missing");
	const map = byNumber.get(issue.mapNumber ?? -1);
	if (map && map.milestone !== issue.milestone)
		reasons.push("Map milestone scope mismatch");
	if (map?.scope?.paths?.length && issue.scope?.paths?.some((path) =>
		!map.scope.paths.some((root) => path === root || path.startsWith(`${root}/`))))
		reasons.push("outside Map file scope");
	return reasons;
}

function evidenceFor(issues: IssueObservation[], repository: FrontierInput["repository"]): string[] {
	return distinct([
		repository.evidence,
		...issues.flatMap((issue) => [
			issue.evidence.issue,
			issue.evidence.dependencies,
			issue.evidence.ownership,
			issue.project.url,
			...issue.ownership.prs.map((pr) => pr.url),
		]),
	]).sort();
}

export function generateRoadmapGoal(input: FrontierInput): FrontierResult {
	if (!input || !input.repository || !Array.isArray(input.issues) ||
		!publicUrl(input.repository.url) ||
		new URL(input.repository.url).pathname.split("/").filter(Boolean).length !== 2 ||
		!sameRepoUrl(input.repository.evidence, input.repository.url) ||
		!safeName(input.repository.baseRef) || !sha(input.repository.baseSha) ||
		!sha(input.repository.headSha)) {
		return { kind: "rejected", reasons: ["repository or Issue observations incomplete"], evidence: [] };
	}
	const numbers = input.issues.map((issue) => issue?.number);
	if (numbers.some((number) => !issueNumber(number)) || distinct(numbers).length !== numbers.length)
		return { kind: "rejected", reasons: ["Issue observations have invalid or duplicate numbers"], evidence: [input.repository.evidence] };
	const byNumber = new Map(input.issues.map((issue) => [issue.number, issue]));
	const refs = input.references ?? [];
	if (!Array.isArray(refs) || refs.some((number) => !issueNumber(number)) || distinct(refs).length !== refs.length)
		return { kind: "rejected", reasons: ["references are invalid or duplicated"], evidence: [input.repository.evidence] };
	if (refs.length === 0) {
		const excluded: { issue: number; reasons: string[] }[] = [];
		const eligible: IssueObservation[] = [];
		for (const issue of input.issues.filter((item) => item.kind === "implementation")) {
			const reasons = eligibility(issue, byNumber, input.repository.url);
			if (reasons.length) excluded.push({ issue: issue.number, reasons });
			else eligible.push(issue);
		}
		eligible.sort((a, b) => priorityOrder[a.priority as Priority] - priorityOrder[b.priority as Priority] || a.number - b.number);
		return {
			kind: "candidates",
			candidates: eligible.slice(0, 3).map((issue) => ({
				issue: issue.number,
				map: issue.mapNumber as number,
				priority: issue.priority as Priority,
				invocation: `$gen-goal-with-roadmap #${issue.mapNumber} #${issue.number}`,
				evidence: distinct([
					...evidenceFor([issue, byNumber.get(issue.mapNumber as number) as IssueObservation], input.repository),
					...[...issue.blockers, ...(byNumber.get(issue.mapNumber as number) as IssueObservation).blockers]
						.map((number) => (byNumber.get(number) as IssueObservation).evidence.issue),
				]).sort(),
			})),
			excluded: excluded.sort((a, b) => a.issue - b.issue),
		};
	}
	const unknown = refs.filter((number) => !byNumber.has(number));
	const unsupported = refs.filter((number) => {
		const issue = byNumber.get(number);
		return issue && issue.kind !== "map" && issue.kind !== "implementation";
	});
	const maps = refs.filter((number) => byNumber.get(number)?.kind === "map");
	const explicit = refs.filter((number) => byNumber.get(number)?.kind === "implementation");
	const inferredMaps = distinct(explicit.map((number) => byNumber.get(number)?.mapNumber));
	const mapNumber = maps[0] ?? inferredMaps[0];
	const reasons: string[] = [];
	if (unknown.length) reasons.push(`unobserved references: ${unknown.map((number) => `#${number}`).join(", ")}`);
	if (unsupported.length) reasons.push(`unsupported reference kind: ${unsupported.map((number) => `#${number}`).join(", ")}`);
	if (maps.length > 1 || (explicit.length > 0 && inferredMaps.length !== 1) || !issueNumber(mapNumber) ||
		(maps.length === 1 && inferredMaps[0] !== undefined && inferredMaps[0] !== mapNumber))
		reasons.push("references do not resolve to one Map");
	const map = byNumber.get(mapNumber ?? -1);
	if (!completeMap(map, input.repository.url, byNumber))
		reasons.push("Map state or evidence incomplete");
	const selected = explicit.length
		? explicit.map((number) => byNumber.get(number) as IssueObservation)
		: input.issues.filter((issue) => issue.kind === "implementation" && issue.mapNumber === mapNumber && eligibility(issue, byNumber, input.repository.url).length === 0);
	if (selected.length === 0) reasons.push("no implementation frontier selected");
	for (const issue of selected) {
		for (const reason of eligibility(issue, byNumber, input.repository.url)) reasons.push(`#${issue.number}: ${reason}`);
		if (issue.mapNumber !== mapNumber) reasons.push(`#${issue.number}: belongs to another Map`);
	}
	for (let left = 0; left < selected.length; left++) {
		for (let right = left + 1; right < selected.length; right++) {
			const first = selected[left];
			const second = selected[right];
			if (!first || !second) continue;
			for (const path of first.scope?.paths ?? []) {
				if (second.scope?.paths?.some((other) =>
					path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) {
					reasons.push(`#${first.number} and #${second.number}: overlapping lane scope`);
					break;
				}
			}
		}
	}
	if (reasons.length) {
		const observed = [map, ...selected].filter((issue): issue is IssueObservation => Boolean(issue));
		return { kind: "rejected", reasons: distinct(reasons), evidence: observed.flatMap((issue) =>
			[issue.evidence?.issue, issue.evidence?.dependencies, issue.evidence?.ownership, issue.project?.url].filter(publicUrl)).sort() };
	}
	selected.sort((a, b) => priorityOrder[a.priority as Priority] - priorityOrder[b.priority as Priority] || a.number - b.number);
	const dependencies = distinct([...(map as IssueObservation).blockers, ...selected.flatMap((issue) => issue.blockers)])
		.map((number) => byNumber.get(number) as IssueObservation)
		.sort((a, b) => a.number - b.number);
	const related = [map as IssueObservation, ...selected];
	const facts = {
		repository: input.repository,
		map: sortedIssueFacts(map as IssueObservation),
		issues: selected.map(sortedIssueFacts),
		dependencies: dependencies.map((issue) => ({
			number: issue.number, state: issue.state, revision: issue.revision,
			evidence: issue.evidence.issue,
		})),
	};
	const digest = createHash("sha256").update(stableJson(facts)).digest("hex");
	const evidence = distinct([...evidenceFor(related, input.repository), ...dependencies.map((issue) => issue.evidence.issue)]).sort();
	const observed: SnapshotObservation = {
		map: visibleIssueFacts(map as IssueObservation),
		issues: selected.map(visibleIssueFacts),
		dependencies: dependencies.map((issue) => ({
			number: issue.number, state: issue.state, revision: issue.revision,
		})),
	};
	const lanes = selected.map((issue) =>
		`- #${issue.number}: AC ${[...issue.acceptanceCriteria].sort().join(", ")}; owner: implementation owner for #${issue.number} (claim before edit); branch: codex/issue-${issue.number}; worktree: issue-${issue.number}; base/head: ${input.repository.baseSha}/${input.repository.headSha}; resources: ${[...issue.scope.paths].sort().join(", ")}; validation: ${issue.scope.validation}; expected PR: new PR linked to #${issue.number}.`).join("\n");
	const instruction = [
		`Coordinator Goal for Map #${mapNumber}; snapshot SHA-256 ${digest}; frozen Issues ${selected.map((issue) => `#${issue.number}`).join(", ")}.`,
		`Before editing, re-read each Issue, native dependency, PR, branch and worktree; changed snapshot facts require new explicit generation. Queue order is ${selected.map((issue) => `#${issue.number}`).join(" → ")}. Do not add newly unlocked work.`,
		"Lanes (one primary Issue, owner, worktree, branch, PR and verification path each):",
		lanes,
		"Coordinator owns shared entrypoints, lockfiles, deployment configuration, integration branch and final readback. Record an ownership ledger; idle, timeout or process failure never releases ownership. Handoff names outgoing and incoming owner, exact head, completed ACs, remaining work, blockers, next action and evidence pointers.",
		"Retry only a finite number of times per stable failure fingerprint; exhaustion records a blocker and recovery condition. Stop on scope drift, contract conflict, missing authority, protected paths or unavailable credentials.",
		"Stages: Ready to implement → Implemented → Integrated → Accepted. Every transition needs current exact-head evidence. Integrated requires a combined version to start and an agreed vertical journey to execute. Accepted requires artifact identity, environment, command, result, limitations and required human gates.",
		"An independent Verifier runs the real entrypoint or user journey, reports pass/failure/limitation/missing evidence, and does not edit or self-approve. Human review and approval are verified waits while independent lanes continue.",
		"Terminal proof: re-read every Issue, native dependency, PR, checks, merge SHA, post-merge checks, branch/worktree cleanup and Project fields; account for every frozen lane as Delivered or Human-retired.",
		`Evidence: ${evidence.join(" ")}`,
	].join("\n");
	return {
		kind: "goal",
		snapshot: { sha256: digest, map: mapNumber as number, issues: selected.map((issue) => issue.number), baseSha: input.repository.baseSha, headSha: input.repository.headSha, evidence, observed },
		instruction,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const input = JSON.parse(readFileSync(0, "utf8")) as FrontierInput;
		process.stdout.write(`${JSON.stringify(generateRoadmapGoal(input))}\n`);
	} catch {
		process.stderr.write("Invalid normalized frontier JSON input\n");
		process.exitCode = 2;
	}
}
