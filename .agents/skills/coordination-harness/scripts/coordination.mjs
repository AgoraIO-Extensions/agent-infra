import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SHA = /^[0-9a-f]{40}$/;

export class CoordinationError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "CoordinationError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new CoordinationError(code, message);
}

function validateContract(issue) {
	if (!issue || !Number.isInteger(issue.number) || !issue.title || issue.state !== "OPEN") {
		fail("invalid_contract", "an open Issue with a number and title is required");
	}
	if (!Array.isArray(issue.acceptanceCriteria) || issue.acceptanceCriteria.length === 0) {
		fail("invalid_contract", "at least one acceptance criterion is required");
	}
	const ids = issue.acceptanceCriteria.map((criterion) => criterion?.id);
	if (
		ids.some((id) => !/^AC-[1-9][0-9]*$/.test(id)) ||
		new Set(ids).size !== ids.length
	) {
		fail("invalid_contract", "acceptance criteria must use unique AC-N identifiers");
	}
}

function validateWorktree(worktree) {
	if (
		!worktree ||
		typeof worktree.path !== "string" ||
		!worktree.path ||
		typeof worktree.branch !== "string" ||
		!worktree.branch ||
		!SHA.test(worktree.baseSha) ||
		!SHA.test(worktree.headSha)
	) {
		fail("invalid_worktree", "path, branch, base SHA and current head SHA are required");
	}
	if (!Array.isArray(worktree.changedFiles)) {
		fail("invalid_worktree", "changedFiles must be an array");
	}
}

function blockersFor(issue, roles) {
	const blockers = [];
	for (const dependency of issue.blockedBy ?? []) {
		if (dependency?.state !== "CLOSED") {
			blockers.push({
				code: "unresolved_dependency",
				message: `Issue #${dependency?.number ?? "unknown"} is not closed`,
			});
		}
	}
	for (const role of ["owner", "writer", "verifier"]) {
		if (typeof roles?.[role] !== "string" || roles[role].length === 0) {
			blockers.push({
				code: "ownership_incomplete",
				message: `${role} ownership is not assigned`,
			});
		}
	}
	return blockers;
}

function boardMarkdown(result) {
	const blockers = result.blockers.length
		? result.blockers.map((blocker) => `- **${blocker.code}**: ${blocker.message}`).join("\n")
		: "- None";
	return `# Session Board\n\n- Issue: #${result.issue.number} — ${result.issue.title}\n- Milestone: ${result.milestone}\n- Stage: **${result.stage}**\n- Owner: ${result.ownership.owner ?? "unassigned"}\n- Writer: ${result.ownership.writer ?? "unassigned"}\n- Verifier: ${result.ownership.verifier ?? "unassigned"}\n- Worktree: ${result.worktree.path}\n- Branch: ${result.worktree.branch}\n- Base SHA: ${result.worktree.baseSha}\n- Current head SHA: ${result.currentHead}\n- Changed files: ${result.worktree.changedFiles.length}\n\n## Blockers\n\n${blockers}\n\n## Next action\n\n${result.nextAction}\n`;
}

function contextMarkdown(result) {
	return `# Coordination Context\n\n- Issue: #${result.issue.number}\n- Stage: ${result.stage}\n- base SHA: ${result.worktree.baseSha}\n- current head SHA: ${result.currentHead}\n- Writer: ${result.ownership.writer ?? "unassigned"}\n- Verifier: ${result.ownership.verifier ?? "unassigned"}\n\nThis file is a disposable handoff cache. GitHub Issue, PR, CI and Project state remain authoritative.\n`;
}

const STAGES = ["Ready to implement", "Implemented", "Integrated", "Accepted"];

function requireCurrentHead(result, currentHead) {
	if (!SHA.test(currentHead) || currentHead !== result.currentHead) {
		fail("stale_head", "evidence must be bound to the current exact head");
	}
}

export function assignResourceOwnership(result, { resource, writer }) {
	if (!resource || typeof resource !== "string" || !writer || typeof writer !== "string") {
		fail("invalid_ownership", "resource and writer are required");
	}
	const resources = result.resources ?? {};
	if (resources[resource] && resources[resource] !== writer) {
		fail("duplicate_ownership", `${resource} is already owned by ${resources[resource]}`);
	}
	return { ...result, resources: { ...resources, [resource]: writer } };
}

export function handoffCoordinationSession(result, {
	incomingWriter,
	currentHead,
	reason,
	nextAction,
}) {
	if (!incomingWriter || !reason || !nextAction) {
		fail("invalid_handoff", "incoming writer, reason and next action are required");
	}
	requireCurrentHead(result, currentHead);
	return {
		...result,
		ownership: { ...result.ownership, writer: incomingWriter },
		handoff: {
			from: result.ownership.writer,
			to: incomingWriter,
			currentHead,
			reason,
			nextAction,
		},
	};
}

export function recordVerifierResult(result, {
	currentHead,
	status,
	evidence,
	findings = [],
}) {
	requireCurrentHead(result, currentHead);
	if (!result.ownership.verifier) fail("ownership_incomplete", "verifier ownership is not assigned");
	if (!["passed", "failed", "blocked"].includes(status) || !evidence) {
		fail("invalid_verification", "verifier status and evidence are required");
	}
	return {
		...result,
		verifierResult: { verifier: result.ownership.verifier, currentHead, status, evidence, findings },
	};
}

export function advanceCoordinationStage(result, { target, currentHead, evidence }) {
	requireCurrentHead(result, currentHead);
	const currentIndex = STAGES.indexOf(result.stage);
	const targetIndex = STAGES.indexOf(target);
	if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
		fail("invalid_stage_transition", `stage must advance one step from ${result.stage}`);
	}
	if (!evidence || typeof evidence !== "object") {
		fail("missing_evidence", `evidence is required for ${target}`);
	}
	if (target === "Integrated" && evidence.kind !== "vertical_journey") {
		fail("missing_evidence", "Integrated requires a vertical journey");
	}
	if (target === "Accepted" && (!evidence.environment || !evidence.command || !evidence.result)) {
		fail("missing_evidence", "Accepted requires environment, command and result");
	}
	if (result.verifierResult?.status === "failed" || result.verifierResult?.status === "blocked") {
		fail("verification_blocked", "failed or blocked verification prevents acceptance");
	}
	return { ...result, stage: target, evidence: { ...evidence, currentHead } };
}

export async function startCoordinationSession({
	issue,
	worktree,
	roles = {},
	outputDirectory,
}) {
	validateContract(issue);
	validateWorktree(worktree);
	if (typeof outputDirectory !== "string" || !outputDirectory) {
		fail("invalid_output", "an output directory is required");
	}
	const blockers = blockersFor(issue, roles);
	const result = {
		version: 1,
		issue: { number: issue.number, title: issue.title },
		milestone: issue.milestone?.title ?? "unassigned",
		ownership: {
			owner: roles.owner ?? null,
			writer: roles.writer ?? null,
			verifier: roles.verifier ?? null,
		},
		worktree: {
			path: worktree.path,
			branch: worktree.branch,
			baseSha: worktree.baseSha,
			headSha: worktree.headSha,
			dirty: Boolean(worktree.dirty),
			changedFiles: [...worktree.changedFiles],
		},
		currentHead: worktree.headSha,
		stage: blockers.length ? "Blocked" : "Ready to implement",
		blockers,
		nextAction: blockers.length ? "Resolve blockers and rerun the session readback." : "Assign the bounded slice and begin implementation.",
	};

	await mkdir(outputDirectory, { recursive: true });
	await writeFile(join(outputDirectory, "SESSION_BOARD.md"), boardMarkdown(result));
	await writeFile(join(outputDirectory, "CONTEXT.md"), contextMarkdown(result));
	await writeFile(join(outputDirectory, "session.json"), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

if (process.argv[1] && process.argv[1].endsWith("coordination.mjs") && process.argv[2] === "start") {
	const [inputPath, outputDirectory] = process.argv.slice(3);
	if (!inputPath || !outputDirectory) {
		console.error("usage: coordination.mjs start <input.json> <output-directory>");
		process.exitCode = 2;
	} else {
		try {
			const { readFile } = await import("node:fs/promises");
			const input = JSON.parse(await readFile(inputPath, "utf8"));
			const result = await startCoordinationSession({ ...input, outputDirectory });
			console.log(JSON.stringify(result, null, 2));
		} catch (error) {
			console.error(error instanceof CoordinationError ? `${error.code}: ${error.message}` : error);
			process.exitCode = 1;
		}
	}
}
