import { pathToFileURL } from "node:url";

const endpoint = "https://agent-connector.gz3.agoralab.co/mcp";
const target = {
	owner: "AgoraConnectionE2EORG",
	repository: "connector-conformance",
	repositoryId: 1369705971,
};
const reviewerExternalAccount = "329435106";

const actionEffects = {
	"github.get_repository": "READ",
	"github.get_current_user": "READ",
	"github.get_pull_request": "READ",
	"github.get_pull_request_review": "READ",
	"github.list_pull_request_reviews": "READ",
	"github.list_pull_request_review_comments": "READ",
	"github.create_pull_request_review": "WRITE",
	"github.submit_pull_request_review": "WRITE",
	"github.create_pull_request_review_comment": "WRITE",
	"github.reply_pull_request_review_comment": "WRITE",
	"github.update_pull_request_review_comment": "WRITE",
	"github.delete_pull_request_review_comment": "WRITE",
	"github.delete_pending_pull_request_review": "WRITE",
};

export const githubReviewActionIds = Object.keys(actionEffects);

export async function runGitHubReviewConformance({
	environment,
	fetch,
	runId,
}) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true") {
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	}
	const primaryToken = environment.CONNECTION_E2E_TOKEN?.trim();
	const reviewerToken = environment.CONNECTION_E2E_REVIEWER_TOKEN?.trim();
	if (!primaryToken) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (!reviewerToken)
		throw new Error("CONNECTION_E2E_REVIEWER_TOKEN is required");
	if (typeof runId !== "string" || !runId.trim())
		throw new Error("runId is required");

	const primary = mcpClient(fetch, primaryToken);
	const reviewer = mcpClient(fetch, reviewerToken);
	const marker = `connection-e2e:${runId}`;
	const branch = `connection-e2e-review-${runId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
	const path = `fixtures/${branch}.txt`;
	const calls = [];
	const approvedVersions = new Map();
	let branchCreationStarted = false;
	let branchCreated = false;
	let expectedHeadSha;
	let failure;
	let pullCreationStarted = false;
	let pullHandled = false;
	let pullNumber;

	await assertSingleAccount(primary, "328682695");
	await assertSingleAccount(reviewer, "329435106");
	const dismissGuide = await primary.call(
		"get_action_guide",
		{ actionId: "github.dismiss_pull_request_review" },
		true,
	);
	if (
		dismissGuide?.action?.actionVersionId !==
			"github.dismiss_pull_request_review@v8" ||
		dismissGuide.action.effect !== "WRITE"
	) {
		throw new Error(
			"github.dismiss_pull_request_review has an unapproved ActionVersion",
		);
	}
	const search = await reviewer.call(
		"search_actions",
		{ limit: 50, query: "", service: "github" },
		true,
	);
	const discovered = search?.actions?.map((action) => action.actionId).sort();
	if (
		!Array.isArray(discovered) ||
		JSON.stringify(discovered) !==
			JSON.stringify([...githubReviewActionIds].sort())
	) {
		throw new Error(
			"Reviewer PAT must expose exactly the approved review actions",
		);
	}
	for (const actionId of githubReviewActionIds) {
		const guide = await reviewer.call("get_action_guide", { actionId }, true);
		if (
			guide?.action?.actionId !== actionId ||
			guide?.action?.actionVersionId !== `${actionId}@v8` ||
			guide.action.effect !== actionEffects[actionId]
		) {
			throw new Error(`${actionId} has an unapproved ActionVersion`);
		}
		approvedVersions.set(actionId, guide.action.actionVersionId);
	}

	const primaryExecute = async (actionId, input, retrySafe = false) =>
		(await primary.execute(actionId, input, retrySafe)).result;
	const reviewerExecute = async (actionId, input) => {
		const projection = await reviewer.execute(
			actionId,
			input,
			actionEffects[actionId] === "READ",
		);
		const actionVersionId = approvedVersions.get(actionId);
		if (actionVersionId !== `${actionId}@v8`) {
			throw new Error(`${actionId} has no approved ActionVersion`);
		}
		if (projection.actionVersionId !== actionVersionId) {
			throw new Error(`${actionId} executed an unapproved ActionVersion`);
		}
		calls.push({
			actionVersionId,
			callId: projection.callId,
			status: projection.status,
		});
		return projection.result;
	};

	try {
		const repository = await primaryExecute(
			"github.get_repository",
			{ owner: target.owner, repo: target.repository },
			true,
		);
		assertRepository(repository);
		const mainBranch = await primaryExecute(
			"github.get_branch",
			{ branch: "main", owner: target.owner, repo: target.repository },
			true,
		);
		if (!mainBranch?.commit?.sha)
			throw new Error("main branch did not return a commit SHA");
		branchCreationStarted = true;
		const createdRef = await primaryExecute("github.create_ref", {
			idempotencyKey: `${runId}:fixture-ref-create`,
			owner: target.owner,
			ref: `refs/heads/${branch}`,
			repo: target.repository,
			sha: mainBranch.commit.sha,
		});
		if (createdRef?.ref !== `refs/heads/${branch}`)
			throw new Error("fixture ref does not match");
		branchCreated = true;
		const file = await primaryExecute("github.create_or_update_file", {
			branch,
			content: `${marker}\n`,
			idempotencyKey: `${runId}:fixture-file-create`,
			message: marker,
			owner: target.owner,
			path,
			repo: target.repository,
		});
		const headSha = file?.commit?.sha;
		if (!headSha) throw new Error("fixture file did not return a commit SHA");
		expectedHeadSha = headSha;
		pullCreationStarted = true;
		const pull = await primaryExecute("github.create_pull_request", {
			base: "main",
			body: marker,
			draft: false,
			head: branch,
			idempotencyKey: `${runId}:fixture-pull-create`,
			maintainerCanModify: false,
			owner: target.owner,
			repo: target.repository,
			title: marker,
		});
		const createdPullNumber = positiveInteger(
			pull?.number,
			"fixture pull number",
		);
		if (pull?.body !== marker || pull?.head?.sha !== headSha) {
			throw new Error("fixture pull ownership marker does not match");
		}
		pullNumber = createdPullNumber;

		assertRepository(
			await reviewerExecute("github.get_repository", {
				owner: target.owner,
				repo: target.repository,
			}),
		);
		const currentUser = await reviewerExecute("github.get_current_user", {});
		if (String(currentUser?.id) !== "329435106")
			throw new Error("reviewer identity does not match");
		assertOwnedPull(
			await reviewerExecute("github.get_pull_request", {
				owner: target.owner,
				pullNumber,
				repo: target.repository,
			}),
			marker,
			pullNumber,
		);
		await reviewerExecute("github.list_pull_request_reviews", {
			owner: target.owner,
			pullNumber,
			repo: target.repository,
		});
		await reviewerExecute("github.list_pull_request_review_comments", {
			owner: target.owner,
			pullNumber,
			repo: target.repository,
		});

		const comment = await reviewerExecute(
			"github.create_pull_request_review_comment",
			{
				body: `${marker} comment`,
				commitId: headSha,
				idempotencyKey: `${runId}:comment-create`,
				line: 1,
				owner: target.owner,
				path,
				pullNumber,
				repo: target.repository,
				side: "RIGHT",
			},
		);
		const commentId = ownedCommentId(comment, marker);
		const updated = await reviewerExecute(
			"github.update_pull_request_review_comment",
			{
				body: `${marker} updated`,
				commentId,
				idempotencyKey: `${runId}:comment-update`,
				owner: target.owner,
				repo: target.repository,
			},
		);
		ownedCommentId(updated, marker);
		const reply = await reviewerExecute(
			"github.reply_pull_request_review_comment",
			{
				body: `${marker} reply`,
				commentId,
				idempotencyKey: `${runId}:comment-reply`,
				owner: target.owner,
				pullNumber,
				repo: target.repository,
			},
		);
		const replyId = ownedCommentId(reply, marker);
		const comments = await reviewerExecute(
			"github.list_pull_request_review_comments",
			{
				owner: target.owner,
				pullNumber,
				repo: target.repository,
			},
		);
		for (const id of [commentId, replyId]) {
			if (
				!comments?.comments?.some(
					(item) => item.id === id && item.body?.includes(marker),
				)
			) {
				throw new Error(
					`review comment ownership marker does not match: ${id}`,
				);
			}
		}
		await reviewerExecute("github.delete_pull_request_review_comment", {
			commentId: replyId,
			idempotencyKey: `${runId}:reply-delete`,
			owner: target.owner,
			repo: target.repository,
		});
		await reviewerExecute("github.delete_pull_request_review_comment", {
			commentId,
			idempotencyKey: `${runId}:comment-delete`,
			owner: target.owner,
			repo: target.repository,
		});

		const review = await reviewerExecute("github.create_pull_request_review", {
			body: `${marker} pending`,
			comments: [],
			commitId: headSha,
			idempotencyKey: `${runId}:review-create`,
			owner: target.owner,
			pullNumber,
			repo: target.repository,
		});
		const reviewId = ownedPendingReviewId(review, marker);
		ownedPendingReviewId(
			await reviewerExecute("github.get_pull_request_review", {
				owner: target.owner,
				pullNumber,
				repo: target.repository,
				reviewId,
			}),
			marker,
		);
		const submitted = await reviewerExecute(
			"github.submit_pull_request_review",
			{
				body: `${marker} submitted`,
				event: "APPROVE",
				idempotencyKey: `${runId}:review-submit`,
				owner: target.owner,
				pullNumber,
				repo: target.repository,
				reviewId,
			},
		);
		if (
			submitted?.id !== reviewId ||
			submitted?.state !== "APPROVED" ||
			String(submitted?.user?.id) !== reviewerExternalAccount
		) {
			throw new Error("submitted review does not match");
		}
		const dismissed = await primary.execute(
			"github.dismiss_pull_request_review",
			{
				idempotencyKey: `${runId}:review-dismiss`,
				message: marker,
				owner: target.owner,
				pullNumber,
				repo: target.repository,
				reviewId,
			},
		);
		if (
			dismissed.actionVersionId !== "github.dismiss_pull_request_review@v8" ||
			dismissed.result?.id !== reviewId ||
			dismissed.result?.state !== "DISMISSED"
		) {
			throw new Error("dismissed review does not match");
		}
		const reviews = await reviewerExecute("github.list_pull_request_reviews", {
			owner: target.owner,
			pullNumber,
			repo: target.repository,
		});
		if (
			!reviews?.reviews?.some(
				(item) =>
					item.id === reviewId &&
					item.state === "DISMISSED" &&
					item.body?.includes(marker) &&
					String(item.user?.id) === reviewerExternalAccount,
			)
		) {
			throw new Error("submitted review ownership marker does not match");
		}
		const cleanupReview = await reviewerExecute(
			"github.create_pull_request_review",
			{
				body: `${marker} cleanup`,
				comments: [],
				commitId: headSha,
				idempotencyKey: `${runId}:cleanup-review-create`,
				owner: target.owner,
				pullNumber,
				repo: target.repository,
			},
		);
		const cleanupReviewId = ownedPendingReviewId(cleanupReview, marker);
		ownedPendingReviewId(
			await reviewerExecute("github.delete_pending_pull_request_review", {
				idempotencyKey: `${runId}:cleanup-review-delete`,
				owner: target.owner,
				pullNumber,
				repo: target.repository,
				reviewId: cleanupReviewId,
			}),
			marker,
		);
	} catch (error) {
		failure = error;
	} finally {
		if (branchCreationStarted && !branchCreated) {
			try {
				const branchFound = await reconcileBranch({ branch, primaryExecute });
				failure ??= new Error(
					branchFound
						? "fixture branch exists but ownership is unproven"
						: "fixture branch reconciliation did not find the owned branch",
				);
			} catch (error) {
				failure ??= error;
			}
		}
		if (pullCreationStarted && !pullNumber) {
			try {
				pullNumber = await reconcilePullNumber({
					branch,
					expectedHeadSha,
					marker,
					primaryExecute,
				});
			} catch (error) {
				failure ??= error;
			}
			if (!pullNumber) {
				failure ??= new Error(
					"fixture pull reconciliation did not find the owned pull",
				);
			}
		}
		if (pullNumber) {
			try {
				await cleanupReviewerArtifacts({
					marker,
					pullNumber,
					reviewerExecute,
					runId,
				});
			} catch (error) {
				failure ??= error;
			}
			try {
				await primaryExecute("github.update_pull_request", {
					idempotencyKey: `${runId}:fixture-pull-close`,
					owner: target.owner,
					pullNumber,
					repo: target.repository,
					state: "closed",
				});
				pullHandled = true;
			} catch (error) {
				failure ??= error;
			}
		}
		if (branchCreated && (!pullCreationStarted || pullHandled)) {
			try {
				await primaryExecute("github.delete_ref", {
					idempotencyKey: `${runId}:fixture-ref-delete`,
					owner: target.owner,
					ref: `heads/${branch}`,
					repo: target.repository,
				});
			} catch (error) {
				failure ??= error;
			}
		}
	}
	if (failure) throw failure;

	return {
		actionVersionIds: githubReviewActionIds.map((id) => `${id}@v8`),
		calls,
		cleanup: "SUCCEEDED",
		primaryActionVersionIds: ["github.dismiss_pull_request_review@v8"],
		pullNumber,
		runId,
	};
}

async function reconcileBranch({ branch, primaryExecute }) {
	const result = await primaryExecute(
		"github.list_matching_refs",
		{
			owner: target.owner,
			ref: `heads/${branch}`,
			repo: target.repository,
		},
		true,
	);
	const matches = (result?.refs ?? []).filter(
		(ref) => ref.ref === `refs/heads/${branch}`,
	);
	if (matches.length > 1)
		throw new Error("fixture branch reconciliation is ambiguous");
	return matches.length === 1;
}

async function reconcilePullNumber({
	branch,
	expectedHeadSha,
	marker,
	primaryExecute,
}) {
	const result = await primaryExecute(
		"github.list_pull_requests",
		{
			base: "main",
			direction: "desc",
			head: `${target.owner}:${branch}`,
			owner: target.owner,
			page: 1,
			perPage: 10,
			repo: target.repository,
			sort: "updated",
			state: "all",
		},
		true,
	);
	const matches = (result?.pull_requests ?? []).filter(
		(pull) =>
			pull.body === marker &&
			pull.title === marker &&
			pull.head?.ref === branch &&
			pull.head?.sha === expectedHeadSha,
	);
	if (matches.length > 1)
		throw new Error("fixture pull reconciliation is ambiguous");
	if (!matches[0]) return undefined;
	const pullNumber = positiveInteger(
		matches[0].number,
		"reconciled pull number",
	);
	const pull = await primaryExecute(
		"github.get_pull_request",
		{ owner: target.owner, pullNumber, repo: target.repository },
		true,
	);
	if (
		pull?.body !== marker ||
		pull?.title !== marker ||
		pull?.head?.ref !== branch ||
		pull?.head?.sha !== expectedHeadSha ||
		pull?.state !== "open"
	) {
		throw new Error("reconciled pull ownership marker does not match");
	}
	return pullNumber;
}

async function cleanupReviewerArtifacts({
	marker,
	pullNumber,
	reviewerExecute,
	runId,
}) {
	const failures = [];
	let ownedComments = [];
	try {
		const comments = await listAllReviewerArtifacts(
			reviewerExecute,
			"github.list_pull_request_review_comments",
			"comments",
			{ owner: target.owner, pullNumber, repo: target.repository },
		);
		ownedComments = comments
			.filter(
				(comment) =>
					comment.body?.includes(marker) &&
					String(comment.user?.id) === reviewerExternalAccount,
			)
			.sort(
				(left, right) =>
					Number(Boolean(right.in_reply_to_id)) -
					Number(Boolean(left.in_reply_to_id)),
			);
	} catch (error) {
		failures.push(error);
	}
	for (const comment of ownedComments) {
		try {
			await reviewerExecute("github.delete_pull_request_review_comment", {
				commentId: positiveInteger(comment.id, "cleanup review comment id"),
				idempotencyKey: `${runId}:cleanup-comment-${comment.id}`,
				owner: target.owner,
				repo: target.repository,
			});
		} catch (error) {
			failures.push(error);
		}
	}
	let reviews = { reviews: [] };
	try {
		reviews = {
			reviews: await listAllReviewerArtifacts(
				reviewerExecute,
				"github.list_pull_request_reviews",
				"reviews",
				{ owner: target.owner, pullNumber, repo: target.repository },
			),
		};
	} catch (error) {
		failures.push(error);
	}
	for (const review of reviews?.reviews ?? []) {
		if (
			review.state !== "PENDING" ||
			!review.body?.includes(marker) ||
			String(review.user?.id) !== reviewerExternalAccount
		)
			continue;
		try {
			await reviewerExecute("github.delete_pending_pull_request_review", {
				idempotencyKey: `${runId}:cleanup-review-${review.id}`,
				owner: target.owner,
				pullNumber,
				repo: target.repository,
				reviewId: positiveInteger(review.id, "cleanup review id"),
			});
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, "Reviewer artifact cleanup failed");
	}
}

async function listAllReviewerArtifacts(
	reviewerExecute,
	actionId,
	envelope,
	input,
) {
	const items = [];
	for (let page = 1; page <= 10; page += 1) {
		const result = await reviewerExecute(actionId, {
			...input,
			page,
			perPage: 100,
		});
		const batch = result?.[envelope];
		if (!Array.isArray(batch)) {
			throw new Error(`${actionId} returned an invalid cleanup result`);
		}
		items.push(...batch);
		if (batch.length < 100) return items;
	}
	throw new Error(`${actionId} cleanup pagination exceeded the limit`);
}

export function mcpClient(fetch, token) {
	let id = 0;
	return {
		async call(name, args, retrySafe = false) {
			const request = {
				body: JSON.stringify({
					id: ++id,
					jsonrpc: "2.0",
					method: "tools/call",
					params: { arguments: args, name },
				}),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			};
			let response;
			for (let attempt = 0; attempt < (retrySafe ? 2 : 1); attempt += 1) {
				try {
					response = await fetch(endpoint, {
						...request,
						signal: AbortSignal.timeout(30_000),
					});
				} catch (error) {
					if (retrySafe && attempt === 0) continue;
					throw error;
				}
				if (!retrySafe || response.status < 500 || attempt === 1) break;
			}
			if (!response?.ok)
				throw new Error(`Connection returned HTTP ${response?.status}`);
			const payload = await response.json();
			if (payload.error) {
				const message = safeMcpErrorMessage(payload.error.message);
				const operation =
					name === "execute_action" && typeof args.actionId === "string"
						? `${name}:${args.actionId}`
						: name;
				throw new Error(
					`Connection MCP error ${payload.error.code} during ${operation}${message}`,
				);
			}
			return payload.result?.structuredContent;
		},
		async execute(actionId, input, retrySafe = false) {
			const projection = await this.call(
				"execute_action",
				{ actionId, input },
				retrySafe,
			);
			if (
				projection?.action !== actionId ||
				!projection.callId ||
				projection.status !== "SUCCEEDED"
			) {
				throw new Error(`${actionId} did not succeed`);
			}
			return projection;
		},
	};
}

function safeMcpErrorMessage(value) {
	const allowed = new Set([
		"Connection authorization is not active",
		"Provider authorization is no longer valid",
		"Provider request failed",
		"Provider resource was not found",
		"Provider write submission outcome is unknown; reconciliation is pending",
	]);
	return typeof value === "string" && allowed.has(value) ? `: ${value}` : "";
}

export async function assertSingleAccount(client, externalAccount) {
	const result = await client.call(
		"list_connections",
		{ service: "github" },
		true,
	);
	const active = result?.connections?.filter(
		(connection) =>
			connection.providerId === "github" && connection.status === "ACTIVE",
	);
	if (
		!Array.isArray(active) ||
		active.length !== 1 ||
		active[0]?.externalAccount !== externalAccount
	) {
		throw new Error(
			"Connection E2E consumer must expose exactly the approved GitHub account",
		);
	}
}

export function assertRepository(repository) {
	if (
		repository?.id !== target.repositoryId ||
		repository.full_name !== `${target.owner}/${target.repository}` ||
		repository.private !== true ||
		repository.default_branch !== "main"
	) {
		throw new Error("repository boundary does not match");
	}
}

function assertOwnedPull(pull, marker, number) {
	if (
		pull?.number !== number ||
		pull?.body !== marker ||
		pull?.state !== "open"
	) {
		throw new Error("fixture pull ownership marker does not match");
	}
}

function ownedCommentId(comment, marker) {
	if (
		!comment?.body?.includes(marker) ||
		String(comment.user?.id) !== reviewerExternalAccount
	)
		throw new Error("review comment ownership marker does not match");
	return positiveInteger(comment.id, "review comment id");
}

function ownedPendingReviewId(review, marker) {
	if (
		review?.state !== "PENDING" ||
		!review?.body?.includes(marker) ||
		String(review.user?.id) !== reviewerExternalAccount
	) {
		throw new Error("pending review ownership marker does not match");
	}
	return positiveInteger(review.id, "review id");
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
	const runId = process.argv[2] ?? "local";
	runGitHubReviewConformance({ environment: process.env, fetch, runId })
		.then((evidence) => {
			process.stdout.write(
				`${JSON.stringify({ ...evidence, outcome: "SUCCEEDED", suite: "review" })}\n`,
			);
		})
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify({
					error:
						error instanceof Error
							? error.message
							: "GitHub review conformance failed",
					outcome: "FAILED",
					runId,
					suite: "review",
				})}\n`,
			);
			process.exitCode = 1;
		});
}
