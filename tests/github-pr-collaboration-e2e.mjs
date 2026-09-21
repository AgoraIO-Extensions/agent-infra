import { pathToFileURL } from "node:url";

import {
	assertRepository,
	assertSingleAccount,
	mcpClient,
} from "./github-review-e2e.mjs";

export const githubPullRequestCollaborationActionIds = [
	"github.create_pull_request",
	"github.update_pull_request",
	"github.request_pull_request_reviewers",
	"github.remove_pull_request_reviewers",
	"github.update_pull_request_branch",
];

export async function runGitHubPullRequestCollaboration({
	environment,
	fetch,
	runId,
}) {
	const primaryToken = environment.CONNECTION_E2E_TOKEN?.trim();
	const reviewerToken = environment.CONNECTION_E2E_REVIEWER_TOKEN?.trim();
	if (!primaryToken) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (!reviewerToken)
		throw new Error("CONNECTION_E2E_REVIEWER_TOKEN is required");
	if (typeof runId !== "string" || !runId.trim())
		throw new Error("runId is required");

	const primary = mcpClient(fetch, primaryToken);
	const reviewer = mcpClient(fetch, reviewerToken);
	await assertSingleAccount(primary, "328682695");
	await assertSingleAccount(reviewer, "329435106");
	for (const actionId of githubPullRequestCollaborationActionIds) {
		const guide = await primary.call("get_action_guide", { actionId }, true);
		if (
			guide?.action?.actionVersionId !== `${actionId}@v9` ||
			guide.action.effect !== "WRITE"
		) {
			throw new Error(`${actionId} has an unapproved ActionVersion`);
		}
	}

	const marker = `connection-e2e:${runId}`;
	const suffix = runId.replace(/[^A-Za-z0-9._-]/g, "-");
	const baseBranch = `connection-e2e-base-${suffix}`;
	const headBranch = `connection-e2e-pr-${suffix}`;
	const target = {
		owner: "AgoraConnectionE2EORG",
		repo: "connector-conformance",
	};
	const calls = [];
	let baseCreated = false;
	let headCreated = false;
	let expectedHeadSha;
	let pullCreationStarted = false;
	let pullNumber;
	let reviewerRequested = false;
	let failure;
	const cleanupFailures = [];
	const refCreationAttempts = new Map();
	const execute = async (client, actionId, input, retrySafe = false) => {
		const projection = await client.execute(actionId, input, retrySafe);
		if (projection.actionVersionId !== `${actionId}@v9`)
			throw new Error(`${actionId} executed an unapproved ActionVersion`);
		if (githubPullRequestCollaborationActionIds.includes(actionId)) {
			calls.push({
				actionVersionId: projection.actionVersionId,
				callId: projection.callId,
				status: projection.status,
			});
		}
		return projection.result;
	};
	const createRef = async (branch, key, sha) => {
		const existing = await execute(
			primary,
			"github.list_matching_refs",
			{ ...target, ref: `heads/${branch}` },
			true,
		);
		if ((existing?.refs ?? []).length !== 0)
			throw new Error("fixture ref already exists");
		refCreationAttempts.set(branch, sha);
		try {
			await execute(primary, "github.create_ref", {
				...target,
				idempotencyKey: `${runId}:${key}-ref-create`,
				ref: `refs/heads/${branch}`,
				sha,
			});
			return true;
		} catch (error) {
			const refs = await execute(
				primary,
				"github.list_matching_refs",
				{ ...target, ref: `heads/${branch}` },
				true,
			);
			const matches = (refs?.refs ?? []).filter(
				(item) =>
					item.ref === `refs/heads/${branch}` && item.object?.sha === sha,
			);
			if (matches.length > 1)
				throw new Error("fixture ref reconciliation is ambiguous");
			if (matches.length === 1) return true;
			throw error;
		}
	};
	const reconcilePull = async () => {
		const result = await execute(
			primary,
			"github.list_pull_requests",
			{
				...target,
				base: baseBranch,
				direction: "desc",
				head: `${target.owner}:${headBranch}`,
				page: 1,
				perPage: 10,
				sort: "updated",
				state: "all",
			},
			true,
		);
		const matches = (result?.pull_requests ?? []).filter(
			(pull) =>
				pull.body === marker &&
				pull.title === marker &&
				pull.base?.ref === baseBranch &&
				pull.head?.ref === headBranch &&
				pull.head?.sha === expectedHeadSha,
		);
		if (matches.length > 1)
			throw new Error("fixture pull reconciliation is ambiguous");
		return matches[0]?.number;
	};

	try {
		assertRepository(
			await execute(primary, "github.get_repository", target, true),
		);
		const main = await execute(
			primary,
			"github.get_branch",
			{ ...target, branch: "main" },
			true,
		);
		if (!main?.commit?.sha)
			throw new Error("main branch did not return a commit SHA");
		baseCreated = await createRef(baseBranch, "base", main.commit.sha);
		headCreated = await createRef(headBranch, "head", main.commit.sha);
		const headFile = await execute(primary, "github.create_or_update_file", {
			...target,
			branch: headBranch,
			content: `${marker}\n`,
			idempotencyKey: `${runId}:head-file-create`,
			message: marker,
			path: `fixtures/${headBranch}.txt`,
		});
		const headSha = headFile?.commit?.sha;
		if (!headSha) throw new Error("head fixture did not return a commit SHA");
		expectedHeadSha = headSha;
		pullCreationStarted = true;
		let pull;
		try {
			pull = await execute(primary, "github.create_pull_request", {
				...target,
				base: baseBranch,
				body: marker,
				draft: false,
				head: headBranch,
				idempotencyKey: `${runId}:pull-create`,
				maintainerCanModify: false,
				title: marker,
			});
		} catch (error) {
			pullNumber = await reconcilePull();
			throw error;
		}
		const candidatePullNumber = positiveInteger(
			pull?.number,
			"pull request number",
		);
		const providerPull = await execute(
			primary,
			"github.get_pull_request",
			{ ...target, pullNumber: candidatePullNumber },
			true,
		);
		assertOwnedPull(providerPull, {
			baseBranch,
			headBranch,
			headSha,
			marker,
			title: marker,
		});
		pullNumber = candidatePullNumber;
		assertOwnedPull(pull, {
			baseBranch,
			headBranch,
			headSha,
			marker,
			pullNumber,
			title: marker,
		});
		const updatedMarker = `${marker}:updated`;
		assertOwnedPull(
			await execute(primary, "github.update_pull_request", {
				...target,
				body: updatedMarker,
				idempotencyKey: `${runId}:pull-update`,
				pullNumber,
				title: updatedMarker,
			}),
			{ marker: updatedMarker, pullNumber, title: updatedMarker },
		);
		const requested = await execute(
			primary,
			"github.request_pull_request_reviewers",
			{
				...target,
				idempotencyKey: `${runId}:reviewer-request`,
				pullNumber,
				reviewers: ["connectionE2E2"],
				teamReviewers: [],
			},
		);
		if (requested?.requested_reviewers?.[0]?.login !== "connectionE2E2")
			throw new Error("requested reviewer does not match");
		reviewerRequested = true;
		await execute(primary, "github.create_or_update_file", {
			...target,
			branch: baseBranch,
			content: `${marker}:base\n`,
			idempotencyKey: `${runId}:base-file-create`,
			message: `${marker}:base`,
			path: `fixtures/${baseBranch}.txt`,
		});
		await execute(primary, "github.update_pull_request_branch", {
			...target,
			expectedHeadSha: headSha,
			idempotencyKey: `${runId}:pull-branch-update`,
			pullNumber,
		});
		const updateDeadline = Date.now() + 30_000;
		let updatedHeadSha;
		while (Date.now() < updateDeadline) {
			const current = await execute(
				primary,
				"github.get_pull_request",
				{ ...target, pullNumber },
				true,
			);
			if (current?.head?.sha && current.head.sha !== headSha) {
				updatedHeadSha = current.head.sha;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		if (!updatedHeadSha)
			throw new Error("pull request branch update did not complete");
		const removed = await execute(
			primary,
			"github.remove_pull_request_reviewers",
			{
				...target,
				idempotencyKey: `${runId}:reviewer-remove`,
				pullNumber,
				reviewers: ["connectionE2E2"],
				teamReviewers: [],
			},
		);
		if (
			removed?.requested_reviewers?.some(
				(item) => item.login === "connectionE2E2",
			)
		)
			throw new Error("requested reviewer was not removed");
		reviewerRequested = false;
	} catch (error) {
		failure = error;
	} finally {
		if (reviewerRequested && pullNumber) {
			try {
				const removed = await execute(
					primary,
					"github.remove_pull_request_reviewers",
					{
						...target,
						idempotencyKey: `${runId}:reviewer-cleanup-remove`,
						pullNumber,
						reviewers: ["connectionE2E2"],
						teamReviewers: [],
					},
				);
				if (
					removed?.requested_reviewers?.some(
						(item) => item.login === "connectionE2E2",
					)
				)
					cleanupFailures.push(
						new Error("requested reviewer remained after cleanup"),
					);
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (pullCreationStarted && !pullNumber) {
			try {
				pullNumber = await reconcilePull();
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (pullNumber) {
			try {
				const closed = await execute(primary, "github.update_pull_request", {
					...target,
					idempotencyKey: `${runId}:pull-close`,
					pullNumber,
					state: "closed",
				});
				if (closed?.number !== pullNumber || closed.state !== "closed") {
					cleanupFailures.push(
						new Error("pull request close did not complete"),
					);
				} else {
					const confirmed = await execute(
						primary,
						"github.get_pull_request",
						{ ...target, pullNumber },
						true,
					);
					if (confirmed?.number !== pullNumber || confirmed.state !== "closed")
						cleanupFailures.push(
							new Error("pull request remained open after cleanup"),
						);
				}
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		for (const [created, branch, key] of [
			[headCreated, headBranch, "head"],
			[baseCreated, baseBranch, "base"],
		]) {
			const attemptedSha = refCreationAttempts.get(branch);
			if (!created && !attemptedSha) continue;
			try {
				if (!created) {
					const refs = await execute(
						primary,
						"github.list_matching_refs",
						{ ...target, ref: `heads/${branch}` },
						true,
					);
					const matches = (refs?.refs ?? []).filter(
						(item) =>
							item.ref === `refs/heads/${branch}` &&
							item.object?.sha === attemptedSha,
					);
					if (matches.length === 0) continue;
					if (matches.length > 1) {
						cleanupFailures.push(new Error("fixture ref cleanup is ambiguous"));
						continue;
					}
				}
				await execute(primary, "github.delete_ref", {
					...target,
					idempotencyKey: `${runId}:${key}-ref-delete`,
					ref: `heads/${branch}`,
				});
				const remaining = await execute(
					primary,
					"github.list_matching_refs",
					{ ...target, ref: `heads/${branch}` },
					true,
				);
				if (
					(remaining?.refs ?? []).some(
						(item) => item.ref === `refs/heads/${branch}`,
					)
				)
					cleanupFailures.push(new Error("fixture ref remained after cleanup"));
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
	}
	if (cleanupFailures.length > 0) {
		const cleanupMessage = cleanupFailures
			.map((error) =>
				error instanceof Error ? error.message : "unknown error",
			)
			.join("; ");
		throw new Error(
			`${failure instanceof Error ? `${failure.message}; ` : ""}cleanup failed: ${cleanupMessage}`,
		);
	}
	if (failure) throw failure;
	return {
		actionVersionIds: githubPullRequestCollaborationActionIds.map(
			(actionId) => `${actionId}@v9`,
		),
		calls,
		cleanup: "SUCCEEDED",
		pullNumber,
		runId,
	};
}

function assertOwnedPull(pull, expected) {
	if (
		pull?.body !== expected.marker ||
		(expected.title && pull.title !== expected.title) ||
		(expected.pullNumber && pull.number !== expected.pullNumber) ||
		(expected.baseBranch && pull.base?.ref !== expected.baseBranch) ||
		(expected.headBranch && pull.head?.ref !== expected.headBranch) ||
		(expected.headSha && pull.head?.sha !== expected.headSha) ||
		!Number.isSafeInteger(pull.number)
	) {
		throw new Error("pull request ownership marker does not match");
	}
}

function positiveInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${label} is invalid`);
	return value;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const runId = process.argv[2];
	runGitHubPullRequestCollaboration({ environment: process.env, fetch, runId })
		.then((evidence) =>
			process.stdout.write(
				`${JSON.stringify({ ...evidence, outcome: "SUCCEEDED", suite: "pull-request-collaboration" })}\n`,
			),
		)
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify({ error: error instanceof Error ? error.message : "Pull request collaboration failed", outcome: "FAILED", runId, suite: "pull-request-collaboration" })}\n`,
			);
			process.exitCode = 1;
		});
}
