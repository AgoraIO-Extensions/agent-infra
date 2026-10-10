import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type PullRequest = {
	number: number;
	merged: boolean;
	draft: boolean;
	base: { ref: string };
	head: { sha: string; repo: { full_name: string } | null };
};
type Comment = {
	id: number;
	body: string;
	updated_at: string;
	user: { login: string; type: string };
};
type Event = {
	sender: { type: string };
	comment: { body: string; author_association: string };
	issue: { number: number; pull_request?: unknown };
};
const marker = /<!-- pr-agent-review-state:v1\s*([\s\S]*?)\s*-->/g;
function state(
	comment: Comment,
): {
	last_run?: { complete?: boolean; head_sha?: string; kind?: string };
} | null {
	const matches = [...comment.body.matchAll(marker)];
	if (matches.length !== 1) return null;
	try {
		return JSON.parse(matches[0]?.[1] ?? "") as ReturnType<typeof state>;
	} catch {
		return null;
	}
}
function hash(body: string) {
	return createHash("sha256").update(body).digest("hex");
}
function bot(comment: Comment) {
	return (
		comment.user.type === "Bot" && comment.user.login === "github-actions[bot]"
	);
}
export function eligible(event: Event, pr: PullRequest, repository: string) {
	return (
		event.sender.type === "User" &&
		event.comment.body === "/review" &&
		["OWNER", "MEMBER", "COLLABORATOR"].includes(
			event.comment.author_association,
		) &&
		Boolean(event.issue.pull_request) &&
		event.issue.number === pr.number &&
		pr.merged === true &&
		pr.draft === false &&
		pr.base.ref === "connection" &&
		pr.head.repo?.full_name === repository &&
		/^[a-f0-9]{40}$/.test(pr.head.sha)
	);
}
export function evidence(
	comments: Comment[],
	head: string,
	started: string,
	before: Record<string, string>,
) {
	const start = Date.parse(started);
	if (!/^[a-f0-9]{40}$/.test(head) || !Number.isFinite(start)) return null;
	return (
		comments.find((comment) => {
			const output = state(comment)?.last_run;
			return (
				bot(comment) &&
				output?.head_sha === head &&
				output.complete === true &&
				output.kind === "full" &&
				Date.parse(comment.updated_at) >= start &&
				before[String(comment.id)] !== hash(comment.body)
			);
		}) ?? null
	);
}
export function conclusion(
	analysis: string,
	current: PullRequest,
	head: string,
	comments: Comment[],
	started: string,
	before: Record<string, string>,
) {
	return analysis === "success" &&
		current.head.sha === head &&
		current.merged === true &&
		evidence(comments, head, started, before) !== null
		? "success"
		: "failure";
}
export async function runControl() {
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	if (repository !== "AgoraIO-Extensions/agent-infra")
		throw new Error("Invalid repository");
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("Missing scoped GitHub token");
	const api = async (path: string, method = "GET", body?: unknown) => {
		const response = await fetch(
			`https://api.github.com/repos/${repository}/${path}`,
			{
				method,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
					"content-type": "application/json",
				},
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(15000),
				redirect: "error",
			},
		);
		if (!response.ok)
			throw new Error(`Review control API failed (${response.status})`);
		return response.json();
	};
	const comments = async (pr: number) => {
		const items: Comment[] = [];
		for (let page = 1; page <= 100; page++) {
			const rows = (await api(
				`issues/${pr}/comments?per_page=100&page=${page}`,
			)) as Comment[];
			items.push(...rows);
			if (rows.length < 100) return items;
		}
		throw new Error("Review comments exceed control bound");
	};
	if (process.argv[2] === "prepare") {
		const event = JSON.parse(
			await readFile(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
		) as Event;
		if (!Number.isSafeInteger(event.issue.number) || event.issue.number < 1)
			throw new Error("Invalid event PR");
		const pr = (await api(`pulls/${event.issue.number}`)) as PullRequest;
		if (!eligible(event, pr, repository)) {
			await appendFile(process.env.GITHUB_OUTPUT ?? "", "allowed=false\n");
			return;
		}
		const existing = await comments(pr.number);
		const before = Object.fromEntries(
			existing.filter(bot).map((c) => [String(c.id), hash(c.body)]),
		);
		const output = {
			allowed: "true",
			pr: String(pr.number),
			head: pr.head.sha,
			started: new Date().toISOString(),
			before: JSON.stringify(before),
		};
		await appendFile(
			process.env.GITHUB_OUTPUT ?? "",
			Object.entries(output)
				.map(([key, value]) => `${key}=${value}\n`)
				.join(""),
		);
	} else if (process.argv[2] === "publish") {
		const prNumber = Number(process.env.REVIEW_PR);
		const head = process.env.REVIEW_HEAD ?? "";
		if (
			!Number.isSafeInteger(prNumber) ||
			prNumber < 1 ||
			!/^[a-f0-9]{40}$/.test(head)
		)
			throw new Error("Invalid captured review target");
		const current = (await api(`pulls/${prNumber}`)) as PullRequest;
		if (
			current.base.ref !== "connection" ||
			current.head.repo?.full_name !== repository ||
			!current.merged ||
			current.head.sha !== head
		)
			throw new Error("Review target changed; no Check published");
		const result = conclusion(
			process.env.REVIEW_RESULT ?? "",
			current,
			head,
			await comments(prNumber),
			process.env.REVIEW_STARTED ?? "",
			JSON.parse(process.env.REVIEW_BEFORE ?? ""),
		);
		await api("check-runs", "POST", {
			name: "review",
			head_sha: head,
			status: "completed",
			conclusion: result,
			output: {
				title: "Merged Connection PR review",
				summary:
					result === "success"
						? "A fresh full PR-Agent result was published for the captured head. This is review execution evidence, not a coverage or human approval claim."
						: "Review failed, produced no fresh current-head result, or was skipped. Release admission remains closed.",
			},
			details_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
		});
		if (result !== "success")
			throw new Error("Current-head Review recovery failed");
	} else throw new Error("Unknown review control operation");
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runControl().catch(() => {
		console.error("Connection Review recovery failed; raw error withheld");
		process.exitCode = 1;
	});
}
