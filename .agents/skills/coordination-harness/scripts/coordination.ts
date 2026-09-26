import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

type Declaration = {
	repository: string;
	issue: number;
	baseRef: string;
	goalContext: string;
	slice: { name: string; acceptanceCriteria: string[] };
	roles: {
		owner: string | null;
		writer: string | null;
		verifier: string | null;
	};
	resources: { files: string[]; external: string[] };
	validation: string[];
};
type Blocker = { code: string; message: string };
type Issue = {
	number: number;
	title: string;
	state: string;
	url: string;
	body: string;
	updatedAt: string;
	milestone: {
		number: number;
		title: string;
		state: string;
		url: string;
	} | null;
	closedByPullRequestsReferences: {
		nodes: { number: number }[];
		pageInfo: { hasNextPage: boolean };
	};
};
type PullRequest = {
	number: number;
	url: string;
	state: string;
	headRefOid: string;
	baseRefName: string;
	statusCheckRollup:
		| {
				name?: string;
				context?: string;
				status?: string;
				conclusion?: string;
				state?: string;
				detailsUrl?: string;
				targetUrl?: string;
		  }[]
		| null;
};

const sha = /^[0-9a-f]{40}$/;
const nonempty = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(nonempty);
const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function read(command: "git" | "gh", args: string[]): string {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			env: command === "gh" ? { ...process.env, GH_REPO: "" } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch {
		// Never echo tool output: it may contain private server or account data.
		throw new Error(`${command} ${args[0]} read failed`);
	}
}

function readJson(args: string[]) {
	try {
		return JSON.parse(read("gh", args));
	} catch {
		throw new Error(`gh ${args[0]} read failed or invalid JSON`);
	}
}

function validDeclaration(value: Declaration): boolean {
	return Boolean(
		value &&
			/^[\w.-]+\/[\w.-]+$/.test(value.repository) &&
			Number.isSafeInteger(value.issue) &&
			value.issue > 0 &&
			nonempty(value.baseRef) &&
			!value.baseRef.startsWith("-") &&
			nonempty(value.goalContext) &&
			nonempty(value.slice?.name) &&
			strings(value.slice?.acceptanceCriteria) &&
			value.slice.acceptanceCriteria.length > 0 &&
			new Set(value.slice.acceptanceCriteria).size ===
				value.slice.acceptanceCriteria.length &&
			["owner", "writer", "verifier"].every(
				(role) =>
					value.roles &&
					(value.roles[role as keyof Declaration["roles"]] === null ||
						nonempty(value.roles[role as keyof Declaration["roles"]])),
			) &&
			strings(value.resources?.files) &&
			value.resources.files.length > 0 &&
			value.resources.files.every(
				(path) =>
					!isAbsolute(path) &&
					!path.split("/").includes("..") &&
					!path.startsWith(".git/") &&
					!/[\r\n*?\\]/.test(path),
			) &&
			strings(value.resources?.external) &&
			strings(value.validation) &&
			value.validation.length > 0,
	);
}

function contract(body: string) {
	const sections = [
		...body.matchAll(/^## (.+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm),
	];
	for (const heading of [
		"Problem",
		"Scope",
		"Acceptance criteria",
		"Validation",
		"Blocked by",
	]) {
		const matches = sections.filter((section) => section[1] === heading);
		if (matches.length !== 1 || !matches[0]?.[2]?.trim()) {
			throw new Error(`missing or duplicate ${heading} section`);
		}
	}
	const acSection =
		sections.find((section) => section[1] === "Acceptance criteria")?.[2] ?? "";
	const rows = acSection
		.split(/\r?\n/)
		.filter((line) => /^\s*- \[[ xX]\]/.test(line));
	const ids = rows.map(
		(line) =>
			/^\s*- \[[ xX]\] (?:\*\*)?(AC-[1-9]\d*)(?:\*\*)?[:\s]+\S/.exec(line)?.[1],
	);
	if (
		!ids.length ||
		ids.some((id) => !id) ||
		new Set(ids).size !== ids.length
	) {
		throw new Error(
			"acceptance criteria require unique stable AC-N identifiers",
		);
	}
	const projection =
		sections.find((section) => section[1] === "Blocked by")?.[2] ?? "";
	const references = [
		...projection.matchAll(/(?:#|\/issues\/)([1-9]\d*)/g),
	].map((match) => Number(match[1]));
	if (!references.length && !/^\s*(?:- )?none\s*$/i.test(projection)) {
		throw new Error(
			"Blocked by must explicitly declare None or Issue references",
		);
	}
	return {
		acceptanceCriteria: ids as string[],
		projectedDependencies: [...new Set(references)],
	};
}

async function collect(input: Declaration) {
	const repository = readJson(["repo", "view", "--json", "nameWithOwner,url"]);
	if (
		!nonempty(repository.nameWithOwner) ||
		!nonempty(repository.url) ||
		repository.nameWithOwner.toLowerCase() !== input.repository.toLowerCase()
	) {
		throw new Error(
			"declared repository does not match current worktree repository",
		);
	}
	const [owner, name] = input.repository.split("/");
	const query = `query { repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
 issue(number:${input.issue}) { number title state url body updatedAt milestone { number title state url }
 closedByPullRequestsReferences(first:100) { nodes { number } pageInfo { hasNextPage } } } } }`;
	const response = readJson(["api", "graphql", "-f", `query=${query}`]);
	const issue: Issue = response.data?.repository?.issue;
	if (
		response.errors?.length ||
		!issue ||
		issue.number !== input.issue ||
		!nonempty(issue.body) ||
		!nonempty(issue.title) ||
		!nonempty(issue.url) ||
		!nonempty(issue.updatedAt) ||
		!["OPEN", "CLOSED"].includes(issue.state) ||
		!("milestone" in issue) ||
		(issue.milestone !== null &&
			(!Number.isInteger(issue.milestone.number) ||
				!nonempty(issue.milestone.title) ||
				!nonempty(issue.milestone.url) ||
				!nonempty(issue.milestone.state))) ||
		!Array.isArray(issue.closedByPullRequestsReferences?.nodes) ||
		issue.closedByPullRequestsReferences.nodes.some(
			(pr) => !Number.isSafeInteger(pr.number) || pr.number < 1,
		) ||
		issue.closedByPullRequestsReferences.pageInfo?.hasNextPage !== false
	) {
		throw new Error("primary Issue read incomplete");
	}
	const dependencyPages = readJson([
		"api",
		"--paginate",
		"--slurp",
		`repos/${input.repository}/issues/${input.issue}/dependencies/blocked_by?per_page=100`,
	]);
	if (
		!Array.isArray(dependencyPages) ||
		dependencyPages.some((page) => !Array.isArray(page))
	) {
		throw new Error("native dependency read incomplete");
	}
	const dependencies = dependencyPages.flat().map((dependency) => {
		if (
			!Number.isInteger(dependency.number) ||
			!["open", "closed"].includes(dependency.state) ||
			!nonempty(dependency.html_url)
		)
			throw new Error("native dependency read incomplete");
		return {
			number: dependency.number as number,
			state: dependency.state as string,
			url: dependency.html_url as string,
		};
	});
	const issueContract = contract(issue.body);
	for (const number of issueContract.projectedDependencies) {
		if (!dependencies.some((dependency) => dependency.number === number)) {
			throw new Error(
				`declared dependency #${number} missing from native dependency readback`,
			);
		}
	}
	// Search also covers related PRs that mention the Issue without closing it.
	const related = readJson([
		"pr",
		"list",
		"--repo",
		input.repository,
		"--state",
		"all",
		"--search",
		`${input.issue} in:body`,
		"--limit",
		"100",
		"--json",
		"number,body",
	]);
	if (
		!Array.isArray(related) ||
		related.length >= 100 ||
		related.some(
			(pr) => !Number.isInteger(pr.number) || typeof pr.body !== "string",
		)
	)
		throw new Error("related PR discovery incomplete");
	const reference = new RegExp(`(?:#|/issues/)${input.issue}(?!\\d)`);
	const prNumbers = new Set<number>([
		...issue.closedByPullRequestsReferences.nodes.map((pr) => pr.number),
		...related.filter((pr) => reference.test(pr.body)).map((pr) => pr.number),
	]);
	const pullRequests = [...prNumbers].map((number) => {
		const pr: PullRequest = readJson([
			"pr",
			"view",
			String(number),
			"--repo",
			input.repository,
			"--json",
			"number,url,state,headRefOid,baseRefName,statusCheckRollup",
		]);
		if (
			pr.number !== number ||
			!sha.test(pr.headRefOid) ||
			!nonempty(pr.url) ||
			!["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
			!nonempty(pr.baseRefName) ||
			!Array.isArray(pr.statusCheckRollup) ||
			pr.statusCheckRollup.some(
				(check) =>
					!nonempty(check.name ?? check.context) ||
					!nonempty(check.status ?? check.state),
			)
		)
			throw new Error("PR/CI read incomplete");
		return {
			number,
			url: pr.url,
			state: pr.state,
			headSha: pr.headRefOid,
			baseRef: pr.baseRefName,
			checks: pr.statusCheckRollup.map((check) => ({
				name: check.name ?? check.context,
				status: check.status ?? check.state,
				conclusion: check.conclusion ?? null,
				url: check.detailsUrl ?? check.targetUrl ?? null,
			})),
		};
	});
	const worktree = read("git", ["rev-parse", "--show-toplevel"]).trim();
	const branch = read("git", [
		"symbolic-ref",
		"--quiet",
		"--short",
		"HEAD",
	]).trim();
	const headSha = read("git", ["rev-parse", "HEAD"]).trim();
	const baseSha = read("git", [
		"rev-parse",
		"--verify",
		`${input.baseRef}^{commit}`,
	]).trim();
	const mergeBaseSha = read("git", ["merge-base", baseSha, headSha]).trim();
	if (
		!nonempty(worktree) ||
		!nonempty(branch) ||
		![headSha, baseSha, mergeBaseSha].every((value) => sha.test(value))
	) {
		throw new Error("worktree read incomplete");
	}
	const trackedDiff = read("git", ["diff", "--binary", baseSha]);
	const dirty = read("git", [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	const untracked = read("git", [
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
		.split("\0")
		.filter(Boolean);
	const changedFiles = [
		...new Set([
			...read("git", ["diff", "--name-only", "-z", baseSha])
				.split("\0")
				.filter(Boolean),
			...untracked,
		]),
	].sort();
	const untrackedDigests = await Promise.all(
		untracked.map(async (file) => [
			file,
			digest(await readFile(join(worktree, file))),
		]),
	);
	if (
		headSha !== read("git", ["rev-parse", "HEAD"]).trim() ||
		baseSha !==
			read("git", [
				"rev-parse",
				"--verify",
				`${input.baseRef}^{commit}`,
			]).trim() ||
		dirty !==
			read("git", ["status", "--porcelain=v1", "--untracked-files=all"]) ||
		digest(trackedDiff) !== digest(read("git", ["diff", "--binary", baseSha]))
	) {
		throw new Error("worktree changed during startup readback; rerun");
	}
	return {
		repository: {
			name: repository.nameWithOwner as string,
			url: repository.url as string,
		},
		issue: {
			number: issue.number,
			title: issue.title,
			state: issue.state,
			url: issue.url,
			updatedAt: issue.updatedAt,
			contractSha256: digest(issue.body),
		},
		acceptanceCriteria: issueContract.acceptanceCriteria,
		milestone: issue.milestone ?? { observed: "none" },
		dependencies,
		pullRequests,
		worktree: {
			path: worktree,
			branch,
			baseRef: input.baseRef,
			baseSha,
			mergeBaseSha,
			headSha,
			dirty: dirty.length > 0,
			changedFiles,
			diffSha256: digest(trackedDiff),
			untrackedDigests,
		},
	};
}

async function start(input: Declaration) {
	if (!validDeclaration(input))
		throw new Error("invalid startup declaration; see Skill contract");
	const cache = `.local-coordination/issue-${input.issue}`;
	// The fixed cache must already be ignored; caller cannot write an arbitrary destination.
	read("git", ["check-ignore", "-q", `${cache}/session.json`]);
	const blockers: Blocker[] = [];
	let facts: Awaited<ReturnType<typeof collect>> | null = null;
	try {
		facts = await collect(input);
	} catch (error) {
		blockers.push({
			code: "read_or_contract_failed",
			message: error instanceof Error ? error.message : "read failed",
		});
	}
	for (const role of ["owner", "writer", "verifier"] as const) {
		if (!input.roles[role])
			blockers.push({
				code: "ownership_incomplete",
				message: `${role}: unassigned`,
			});
	}
	if (facts) {
		if (facts.issue.state !== "OPEN")
			blockers.push({
				code: "issue_closed",
				message: "primary Issue is not open",
			});
		for (const id of input.slice.acceptanceCriteria) {
			if (!facts.acceptanceCriteria.includes(id))
				blockers.push({
					code: "slice_contract_missing",
					message: `${id} is absent from current Issue`,
				});
		}
		for (const dependency of facts.dependencies) {
			if (dependency.state !== "closed")
				blockers.push({
					code: "unresolved_dependency",
					message: dependency.url,
				});
		}
		for (const file of facts.worktree.changedFiles) {
			if (
				!input.resources.files.some(
					(owned) =>
						file === owned || (owned.endsWith("/") && file.startsWith(owned)),
				)
			) {
				blockers.push({ code: "file_outside_boundary", message: file });
			}
		}
	}
	const receipt = {
		version: 1,
		readAt: new Date().toISOString(),
		repository: input.repository,
		primaryIssue: input.issue,
		goalContext: input.goalContext,
		slice: {
			name: input.slice.name,
			acceptanceCriteria: input.slice.acceptanceCriteria,
		},
		roles: Object.fromEntries(
			(["owner", "writer", "verifier"] as const).map((role) => [
				role,
				input.roles[role] ?? "unassigned",
			]),
		),
		resources: {
			files: input.resources.files,
			external: input.resources.external,
		},
		validation: input.validation,
		facts,
		stage: blockers.length ? "Blocked" : "Ready to implement",
		blockers,
		nextAction: blockers.length
			? "Resolve listed blockers and rerun current readback."
			: "Implement only the declared slice under existing Issue and review gates.",
	};
	const markdown = `# Coordination startup\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n\nGitHub and Git remain authoritative. This is a disposable local readback, not acceptance evidence.\n`;
	await mkdir(cache, { recursive: true });
	await writeFile(
		join(cache, "session.json"),
		`${JSON.stringify(receipt, null, 2)}\n`,
	);
	await writeFile(join(cache, "SESSION_BOARD.md"), markdown);
	await writeFile(join(cache, "CONTEXT.md"), markdown);
	return receipt;
}

if (process.argv[2] !== "start" || process.argv.length !== 4) {
	console.error("usage: node coordination.ts start <declaration.json>");
	process.exitCode = 2;
} else {
	try {
		const receipt = await start(
			JSON.parse(await readFile(process.argv[3] ?? "", "utf8")),
		);
		console.log(JSON.stringify(receipt, null, 2));
		process.exitCode = receipt.stage === "Blocked" ? 1 : 0;
	} catch {
		console.error(
			"startup failed: declaration, local ignored cache or readback unavailable; no Ready receipt produced",
		);
		process.exitCode = 1;
	}
}
