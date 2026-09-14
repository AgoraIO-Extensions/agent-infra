import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const target = {
	externalAccount: "328682695",
	owner: "AGORAconnectionE2E",
	repository: "connector-conformance",
	repositoryId: 1368335067,
};
const connectionEndpoint = "https://agent-connector.la3.agoralab.co/mcp";
const requestTimeoutMs = 30_000;
const actionEffects = {
	"github.get_repository": "READ",
	"github.create_issue": "WRITE",
	"github.get_issue": "READ",
	"github.update_issue": "WRITE",
	"github.create_issue_comment": "WRITE",
	"github.get_issue_comment": "READ",
	"github.update_issue_comment": "WRITE",
	"github.delete_issue_comment": "WRITE",
	"github.list_issue_comments": "READ",
};

export async function runGitHubIssueConformance({ environment, fetch, runId }) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true") {
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	}
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) {
		throw new Error("CONNECTION_E2E_TOKEN is required");
	}
	if (typeof runId !== "string" || !runId.trim()) {
		throw new Error("runId is required");
	}
	let requestId = 0;
	const call = async (name, args) => {
		requestId += 1;
		const response = await fetch(connectionEndpoint, {
			body: JSON.stringify({
				id: requestId,
				jsonrpc: "2.0",
				method: "tools/call",
				params: { arguments: args, name },
			}),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
			signal: AbortSignal.timeout(requestTimeoutMs),
		});
		if (!response.ok)
			throw new Error(`Connection returned HTTP ${response.status}`);
		const payload = await response.json();
		if (payload.error) {
			throw new Error(
				`Connection MCP error ${payload.error.code ?? "unknown"}`,
			);
		}
		return payload.result?.structuredContent;
	};

	const connectionResult = await call("list_connections", {
		service: "github",
	});
	const connection = connectionResult?.connections?.find(
		(item) => item.externalAccount === target.externalAccount,
	);
	if (connection?.providerId !== "github" || connection.status !== "ACTIVE") {
		throw new Error("expected GitHub test Provider Connection is not ACTIVE");
	}

	const repositoryCall = await call("execute_action", {
		actionId: "github.get_repository",
		input: { owner: target.owner, repo: target.repository },
	});
	if (repositoryCall?.status !== "SUCCEEDED") {
		throw new Error("repository preflight did not succeed");
	}
	const repository = repositoryCall.result;
	if (repository?.id !== target.repositoryId) {
		throw new Error("repository ID does not match");
	}
	if (
		repository.full_name !== `${target.owner}/${target.repository}` ||
		repository.private !== true ||
		repository.default_branch !== "main"
	) {
		throw new Error("repository boundary does not match");
	}
	const actionVersions = {};
	for (const [actionId, effect] of Object.entries(actionEffects)) {
		const guide = await call("get_action_guide", { actionId });
		const approvedVersion = `${actionId}@v5`;
		if (guide?.action?.actionVersionId !== approvedVersion) {
			throw new Error(`${actionId} has an unapproved ActionVersion`);
		}
		if (
			guide?.action?.actionId !== actionId ||
			guide.action.effect !== effect ||
			typeof guide.action.actionVersionId !== "string"
		) {
			throw new Error(`${actionId} contract does not match`);
		}
		actionVersions[actionId] = guide.action.actionVersionId;
	}

	const calls = [];
	const execute = async (actionId, input) => {
		const projection = await call("execute_action", { actionId, input });
		if (
			projection?.action !== actionId ||
			typeof projection.callId !== "string" ||
			!projection.callId ||
			projection.status !== "SUCCEEDED"
		) {
			throw new Error(`${actionId} did not succeed`);
		}
		calls.push({
			actionId,
			callId: projection.callId,
			status: projection.status,
		});
		return projection.result;
	};
	const marker = `connection-e2e:${runId}`;
	const idempotencyKeys = new Set();
	const key = (step) => {
		const value = `${runId}:${step}`;
		idempotencyKeys.add(value);
		return value;
	};
	const repositoryInput = { owner: target.owner, repo: target.repository };
	let issueNumber;
	let commentId;
	let commentDeleted = false;
	let commentDeleteStarted = false;
	let issueClosed = false;
	let issueCloseStarted = false;
	let cleanup = "SUCCEEDED";
	let result;
	let failure;
	let cleanupError;
	try {
		const issue = await execute("github.create_issue", {
			...repositoryInput,
			body: `${marker} created`,
			idempotencyKey: key("issue-create"),
			title: `${marker} conformance`,
		});
		const createdIssueNumber = requirePositiveInteger(
			issue?.number,
			"created issue number",
		);
		if (
			issue?.body !== `${marker} created` ||
			issue?.title !== `${marker} conformance` ||
			issue?.state !== "open"
		) {
			throw new Error("created issue ownership marker does not match");
		}
		issueNumber = createdIssueNumber;

		const createdIssue = await execute("github.get_issue", {
			...repositoryInput,
			issueNumber,
		});
		if (
			createdIssue?.body !== `${marker} created` ||
			createdIssue?.number !== issueNumber ||
			createdIssue?.state !== "open" ||
			createdIssue?.title !== `${marker} conformance`
		) {
			throw new Error("created issue readback does not match");
		}
		await execute("github.update_issue", {
			...repositoryInput,
			body: `${marker} updated`,
			idempotencyKey: key("issue-update"),
			issueNumber,
			title: `${marker} updated`,
		});
		const updatedIssue = await execute("github.get_issue", {
			...repositoryInput,
			issueNumber,
		});
		if (
			updatedIssue?.body !== `${marker} updated` ||
			updatedIssue?.number !== issueNumber ||
			updatedIssue?.state !== "open" ||
			updatedIssue?.title !== `${marker} updated`
		) {
			throw new Error("updated issue readback does not match");
		}

		const comment = await execute("github.create_issue_comment", {
			...repositoryInput,
			body: `${marker} comment`,
			idempotencyKey: key("comment-create"),
			issueNumber,
		});
		const createdCommentId = requirePositiveInteger(
			comment?.id,
			"created comment ID",
		);
		if (comment?.body !== `${marker} comment`) {
			throw new Error("created comment ownership marker does not match");
		}
		commentId = createdCommentId;
		const createdComment = await execute("github.get_issue_comment", {
			...repositoryInput,
			commentId,
		});
		if (
			createdComment?.body !== `${marker} comment` ||
			createdComment?.id !== commentId
		) {
			throw new Error("created comment readback does not match");
		}
		await execute("github.update_issue_comment", {
			...repositoryInput,
			body: `${marker} comment updated`,
			commentId,
			idempotencyKey: key("comment-update"),
		});
		const updatedComment = await execute("github.get_issue_comment", {
			...repositoryInput,
			commentId,
		});
		if (updatedComment?.body !== `${marker} comment updated`) {
			throw new Error("updated comment marker does not match");
		}

		commentDeleteStarted = true;
		try {
			await execute("github.delete_issue_comment", {
				...repositoryInput,
				commentId,
				idempotencyKey: key("comment-delete"),
			});
			commentDeleted = true;
		} catch (error) {
			const reconciliation = await execute("github.list_issue_comments", {
				...repositoryInput,
				issueNumber,
			});
			if (
				!Array.isArray(reconciliation?.comments) ||
				reconciliation.comments.some((entry) => entry?.id === commentId)
			) {
				throw error;
			}
			commentDeleted = true;
			cleanup = "RECONCILED";
		}
		if (cleanup === "SUCCEEDED") {
			const comments = await execute("github.list_issue_comments", {
				...repositoryInput,
				issueNumber,
			});
			if (
				!Array.isArray(comments?.comments) ||
				comments.comments.some((entry) => entry?.id === commentId)
			) {
				throw new Error("deleted comment is still visible");
			}
		}

		issueCloseStarted = true;
		await execute("github.update_issue", {
			...repositoryInput,
			idempotencyKey: key("issue-close"),
			issueNumber,
			state: "closed",
		});
		const closedIssue = await execute("github.get_issue", {
			...repositoryInput,
			issueNumber,
		});
		if (closedIssue?.state !== "closed") {
			throw new Error("test issue is not closed");
		}
		issueClosed = true;
		result = {
			actionVersions,
			calls,
			cleanup,
			idempotencyKeys: [...idempotencyKeys],
			issueNumber,
			runId,
		};
	} catch (error) {
		failure = error;
	} finally {
		if (commentId && !commentDeleted && !commentDeleteStarted) {
			try {
				await execute("github.delete_issue_comment", {
					...repositoryInput,
					commentId,
					idempotencyKey: key("comment-cleanup"),
				});
			} catch (error) {
				cleanup = "FAILED";
				cleanupError = error;
			}
		}
		if (issueNumber && !issueClosed) {
			try {
				let issueState = "open";
				if (issueCloseStarted) {
					const issue = await execute("github.get_issue", {
						...repositoryInput,
						issueNumber,
					});
					issueState = issue?.state;
				}
				if (issueState === "open") {
					await execute("github.update_issue", {
						...repositoryInput,
						idempotencyKey: key("issue-close"),
						issueNumber,
						state: "closed",
					});
				}
				if (issueState !== "closed") {
					const issue = await execute("github.get_issue", {
						...repositoryInput,
						issueNumber,
					});
					if (issue?.state !== "closed") {
						cleanup = "FAILED";
						cleanupError ??= new Error(
							"test issue cleanup did not close the issue",
						);
					}
				}
			} catch (error) {
				cleanup = "FAILED";
				cleanupError ??= error;
			}
		}
	}
	const evidence = {
		actionVersions,
		calls,
		cleanup,
		idempotencyKeys: [...idempotencyKeys],
		issueNumber,
	};
	if (failure && cleanupError) {
		throw new ConformanceError(
			"GitHub conformance and cleanup failed",
			evidence,
		);
	}
	if (failure) throw new ConformanceError(errorMessage(failure), evidence);
	if (cleanupError) {
		throw new ConformanceError(errorMessage(cleanupError), evidence);
	}
	return result;
}

class ConformanceError extends Error {
	constructor(message, evidence) {
		super(message);
		this.evidence = evidence;
	}
}

function errorMessage(error) {
	return error instanceof Error ? error.message : "GitHub E2E failed";
}

function requirePositiveInteger(value, name) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} is invalid`);
	}
	return value;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const runId = process.argv[2]?.trim() || randomUUID();
	try {
		const result = await runGitHubIssueConformance({
			environment: process.env,
			fetch: globalThis.fetch,
			runId,
		});
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(
			JSON.stringify({
				...(error instanceof ConformanceError ? error.evidence : {}),
				error: errorMessage(error),
				outcome: "FAILED",
				runId,
			}),
		);
		process.exitCode = 1;
	}
}
