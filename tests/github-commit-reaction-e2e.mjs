import { pathToFileURL } from "node:url";

import {
	assertRepository,
	assertSingleAccount,
	mcpClient,
} from "./github-review-e2e.mjs";

export const githubCommitReactionActionIds = [
	"github.create_commit_status",
	"github.create_commit_comment",
	"github.create_issue_reaction",
	"github.create_issue_comment_reaction",
];

export async function runGitHubCommitReactionConformance({
	environment,
	fetch,
	runId,
}) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true")
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (typeof runId !== "string" || !runId.trim())
		throw new Error("runId is required");
	const client = mcpClient(fetch, token);
	await assertSingleAccount(client, "328682695");
	for (const actionId of githubCommitReactionActionIds) {
		const guide = await client.call("get_action_guide", { actionId }, true);
		if (
			guide?.action?.actionVersionId !== `${actionId}@v7` ||
			guide.action.effect !== "WRITE"
		)
			throw new Error(`${actionId} has an unapproved ActionVersion`);
	}
	const target = {
		owner: "AgoraConnectionE2EORG",
		repo: "connector-conformance",
	};
	const marker = `connection-e2e:${runId}`;
	const branch = `connection-e2e-commit-${runId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
	const calls = [];
	let branchCreated = false;
	let issueNumber;
	let commentId;
	let cleanupFailure;
	let failure;
	const execute = async (actionId, input, retrySafe = false) => {
		const projection = await client.execute(actionId, input, retrySafe);
		if (projection.actionVersionId !== `${actionId}@v7`)
			throw new Error(`${actionId} executed an unapproved ActionVersion`);
		if (githubCommitReactionActionIds.includes(actionId))
			calls.push({
				actionVersionId: projection.actionVersionId,
				callId: projection.callId,
				status: projection.status,
			});
		return projection.result;
	};
	try {
		assertRepository(await execute("github.get_repository", target, true));
		const main = await execute(
			"github.get_branch",
			{ ...target, branch: "main" },
			true,
		);
		if (!main?.commit?.sha)
			throw new Error("main branch did not return a commit SHA");
		const existing = await execute(
			"github.list_matching_refs",
			{ ...target, ref: `heads/${branch}` },
			true,
		);
		if (
			(existing?.refs ?? []).some((item) => item.ref === `refs/heads/${branch}`)
		)
			throw new Error("fixture ref already exists");
		await execute("github.create_ref", {
			...target,
			idempotencyKey: `${runId}:ref-create`,
			ref: `refs/heads/${branch}`,
			sha: main.commit.sha,
		});
		branchCreated = true;
		const file = await execute("github.create_or_update_file", {
			...target,
			branch,
			content: `${marker}\n`,
			idempotencyKey: `${runId}:file-create`,
			message: marker,
			path: `fixtures/${branch}.txt`,
		});
		const commitSha = file?.commit?.sha;
		if (!commitSha) throw new Error("fixture commit did not return a SHA");
		const status = await execute("github.create_commit_status", {
			...target,
			context: marker,
			description: marker,
			idempotencyKey: `${runId}:status-create`,
			sha: commitSha,
			state: "success",
			targetUrl: `https://github.com/${target.owner}/${target.repo}/actions`,
		});
		if (
			status?.context !== marker ||
			status.state !== "success" ||
			status.sha !== commitSha
		)
			throw new Error("commit status ownership marker does not match");
		const commitComment = await execute("github.create_commit_comment", {
			...target,
			body: marker,
			commitSha,
			idempotencyKey: `${runId}:commit-comment-create`,
		});
		if (commitComment?.body !== marker || commitComment.commit_id !== commitSha)
			throw new Error("commit comment ownership marker does not match");
		const issue = await execute("github.create_issue", {
			...target,
			body: marker,
			idempotencyKey: `${runId}:issue-create`,
			title: marker,
		});
		if (
			issue?.body !== marker ||
			issue.title !== marker ||
			!Number.isSafeInteger(issue.number)
		)
			throw new Error("issue ownership marker does not match");
		issueNumber = issue.number;
		const comment = await execute("github.create_issue_comment", {
			...target,
			body: marker,
			idempotencyKey: `${runId}:issue-comment-create`,
			issueNumber,
		});
		if (comment?.body !== marker || !Number.isSafeInteger(comment.id))
			throw new Error("issue comment ownership marker does not match");
		commentId = comment.id;
		const issueReaction = await execute("github.create_issue_reaction", {
			...target,
			content: "rocket",
			idempotencyKey: `${runId}:issue-reaction-create`,
			issueNumber,
		});
		if (issueReaction?.content !== "rocket")
			throw new Error("issue reaction does not match");
		const commentReaction = await execute(
			"github.create_issue_comment_reaction",
			{
				...target,
				commentId,
				content: "eyes",
				idempotencyKey: `${runId}:comment-reaction-create`,
			},
		);
		if (commentReaction?.content !== "eyes")
			throw new Error("issue comment reaction does not match");
	} catch (error) {
		failure = error;
	} finally {
		const cleanupFailures = [];
		if (commentId) {
			try {
				await execute("github.delete_issue_comment", {
					...target,
					commentId,
					idempotencyKey: `${runId}:comment-delete`,
				});
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (issueNumber) {
			try {
				const closed = await execute("github.update_issue", {
					...target,
					idempotencyKey: `${runId}:issue-close`,
					issueNumber,
					state: "closed",
				});
				if (closed?.number !== issueNumber || closed.state !== "closed")
					cleanupFailures.push(new Error("issue close did not complete"));
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (branchCreated) {
			try {
				await execute("github.delete_ref", {
					...target,
					idempotencyKey: `${runId}:ref-delete`,
					ref: `heads/${branch}`,
				});
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (cleanupFailures.length > 0)
			cleanupFailure = new Error(
				`${failure instanceof Error ? `${failure.message}; ` : ""}cleanup failed: ${cleanupFailures.map((item) => (item instanceof Error ? item.message : "unknown error")).join("; ")}`,
			);
	}
	if (cleanupFailure) throw cleanupFailure;
	if (failure) throw failure;
	return {
		actionVersionIds: githubCommitReactionActionIds.map((id) => `${id}@v7`),
		calls,
		cleanup: "SUCCEEDED",
		runId,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const runId = process.argv[2];
	runGitHubCommitReactionConformance({ environment: process.env, fetch, runId })
		.then((evidence) =>
			process.stdout.write(
				`${JSON.stringify({ ...evidence, outcome: "SUCCEEDED", suite: "commit-reaction" })}\n`,
			),
		)
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify({ error: error instanceof Error ? error.message : "Commit reaction conformance failed", outcome: "FAILED", runId, suite: "commit-reaction" })}\n`,
			);
			process.exitCode = 1;
		});
}
