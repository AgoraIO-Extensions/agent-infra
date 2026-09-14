import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { githubV7VerificationEvidence } from "../packages/openconnector-adapter/src/verification/github-v7.ts";
import { githubV7ReadScenarios } from "../packages/openconnector-adapter/src/verification/github-v7-read-scenarios.ts";

const target = {
	externalAccount: "328682695",
	owner: "AgoraConnectionE2EORG",
	repository: "connector-conformance",
	repositoryId: 1369705971,
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

export async function runGitHubReadConformance({ environment, fetch, runId }) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true") {
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	}
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_TOKEN is required");
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
		if (payload.error)
			throw new McpCallError(payload.error.code, payload.error.data);
		return payload.result?.structuredContent;
	};

	const connectionResult = await call("list_connections", {
		service: "github",
	});
	const active = connectionResult?.connections?.filter(
		(item) => item.providerId === "github" && item.status === "ACTIVE",
	);
	if (
		!Array.isArray(active) ||
		active.length !== 1 ||
		active[0]?.externalAccount !== target.externalAccount
	) {
		throw new Error(
			"Connection E2E consumer must expose exactly the approved GitHub account",
		);
	}

	const runnable = githubV7ReadScenarios.filter(
		(scenario) => scenario.execution === "LIVE",
	);
	const repositoryScenario = runnable.find(
		(scenario) => scenario.actionVersionId === "github.get_repository@v7",
	);
	if (!repositoryScenario)
		throw new Error("repository preflight scenario is missing");
	const ordered = [
		repositoryScenario,
		...runnable.filter((scenario) => scenario !== repositoryScenario),
	];
	const calls = [];
	const failures = [];
	const skipped = githubV7ReadScenarios
		.filter((scenario) => scenario.execution !== "LIVE")
		.map((scenario) => ({
			actionVersionId: scenario.actionVersionId,
			reason: scenario.execution,
		}));
	for (const scenario of ordered) {
		const actionId = scenario.actionVersionId.slice(0, -3);
		try {
			const guide = await call("get_action_guide", { actionId });
			if (
				guide?.action?.actionId !== actionId ||
				guide.action.actionVersionId !== scenario.actionVersionId ||
				guide.action.effect !== "READ"
			) {
				throw new Error(`${actionId} contract does not match`);
			}
			const projection = await call("execute_action", {
				actionId,
				input: scenario.input,
			});
			if (
				projection?.action !== actionId ||
				typeof projection.callId !== "string" ||
				!projection.callId ||
				projection.status !== "SUCCEEDED"
			) {
				throw new Error(`${actionId} did not succeed`);
			}
			assertReadResult(actionId, projection.result);
			calls.push({
				actionVersionId: scenario.actionVersionId,
				callId: projection.callId,
				inputHash: createHash("sha256")
					.update(
						JSON.stringify(
							Object.fromEntries(Object.entries(scenario.input).sort()),
						),
					)
					.digest("hex"),
				status: projection.status,
				target: scenario.target,
			});
		} catch (error) {
			failures.push({
				actionVersionId: scenario.actionVersionId,
				error: errorMessage(error),
			});
			if (scenario === repositoryScenario) break;
		}
	}
	const evidence = {
		calls,
		failures,
		providerReleaseId: githubV7VerificationEvidence.providerReleaseId,
		runId,
		skipped,
	};
	if (failures.length > 0)
		throw new ConformanceError("GitHub read conformance failed", evidence);
	return evidence;
}

function assertReadResult(actionId, result) {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error(`${actionId} returned an invalid result`);
	}
	const exact = {
		"github.check_pull_request_merged": ["merged", false],
		"github.check_repository_starred": ["starred", true],
		"github.get_branch": ["name", "main"],
		"github.get_commit": ["sha", "410b111ccf673ab03ecb7239391442e226ad48fd"],
		"github.get_current_user": ["id", 328682695],
		"github.get_file_contents": ["path", "fixtures/read-target.txt"],
		"github.get_issue": ["number", 1],
		"github.get_issue_comment": ["id", 5662497553],
		"github.get_label": ["name", "connection-e2e-fixture"],
		"github.get_latest_release": ["id", 388309497],
		"github.get_milestone": ["number", 1],
		"github.get_pull_request": ["number", 2],
		"github.get_ref": ["ref", "refs/heads/main"],
		"github.get_release": ["id", 388309497],
		"github.get_release_asset": ["id", 563149878],
		"github.get_release_by_tag": ["tag_name", "connection-e2e-fixture-v1"],
		"github.get_repository_readme": ["path", "README.md"],
		"github.get_user": ["id", 328682695],
		"github.get_workflow": ["id", 357727076],
		"github.get_workflow_run": ["id", 34833158492],
	};
	const expected = exact[actionId];
	if (expected) {
		if (result[expected[0]] !== expected[1])
			throw new Error(`${actionId} fixture does not match`);
		return;
	}
	if (actionId === "github.get_repository") {
		if (
			result.id !== target.repositoryId ||
			result.full_name !== `${target.owner}/${target.repository}` ||
			result.private !== true ||
			result.default_branch !== "main"
		) {
			throw new Error("repository boundary does not match");
		}
		return;
	}
	if (actionId === "github.get_repository_permission_for_user") {
		if (result.user?.id !== 328682695)
			throw new Error(`${actionId} fixture does not match`);
		return;
	}
	if (actionId === "github.compare_commits") {
		if (!result.comparison || typeof result.comparison !== "object")
			throw new Error(`${actionId} returned an invalid result`);
		return;
	}
	if (actionId === "github.list_repository_languages") {
		if (!result.languages || typeof result.languages !== "object")
			throw new Error(`${actionId} returned an invalid result`);
		return;
	}
	const envelope = readArrayEnvelope(actionId);
	if (!envelope || !Array.isArray(result[envelope])) {
		throw new Error(`${actionId} returned an invalid result`);
	}
	const contains = {
		"github.list_assignees": ["id", 328682695],
		"github.list_branches": ["name", "main"],
		"github.list_check_runs_for_ref": ["id", 103940918709],
		"github.list_commit_comments": ["id", 200307541],
		"github.list_commits": ["sha", "410b111ccf673ab03ecb7239391442e226ad48fd"],
		"github.list_directory_contents": ["path", "README.md"],
		"github.list_issue_comments": ["id", 5662497553],
		"github.list_issue_events": ["actor.id", 328682695],
		"github.list_issue_labels": ["name", "connection-e2e-fixture"],
		"github.list_issue_timeline_events": ["actor.id", 328682695],
		"github.list_matching_refs": ["ref", "refs/heads/main"],
		"github.list_milestones": ["number", 1],
		"github.list_my_repositories": ["id", 1369705971],
		"github.list_my_starred_repositories": ["id", 1369705971],
		"github.list_organization_repositories": ["id", 1369705971],
		"github.list_pull_request_commits": [
			"sha",
			"82285418de307b681dd8842e24c1af705a88345d",
		],
		"github.list_pull_request_files": ["filename", "fixtures/pull-request.txt"],
		"github.list_pull_requests": ["number", 2],
		"github.list_pull_requests_associated_with_commit": ["number", 2],
		"github.list_release_assets": ["id", 563149878],
		"github.list_releases": ["id", 388309497],
		"github.list_repository_contributors": ["id", 328682695],
		"github.list_repository_collaborators": ["id", 328682695],
		"github.list_repository_events": ["repo.id", 1369705971],
		"github.list_repository_issue_events": ["actor.id", 328682695],
		"github.list_repository_issues": ["number", 1],
		"github.list_repository_labels": ["name", "connection-e2e-fixture"],
		"github.list_repository_stargazers": ["id", 328682695],
		"github.list_repository_tags": ["name", "connection-e2e-fixture-v1"],
		"github.list_workflow_run_artifacts": ["id", 10343191621],
		"github.list_workflow_run_jobs": ["id", 103940918709],
		"github.list_workflow_runs": ["id", 34833158492],
		"github.list_repository_workflows": ["id", 357727076],
		"github.search_commits": [
			"sha",
			"410b111ccf673ab03ecb7239391442e226ad48fd",
		],
		"github.search_issues_and_pull_requests": ["number", 1],
		"github.search_labels": ["name", "connection-e2e-fixture"],
		"github.search_repositories": ["id", 1369705971],
		"github.search_users": ["id", 328682695],
	};
	const member = contains[actionId];
	if (
		member &&
		!result[envelope].some((item) => valueAt(item, member[0]) === member[1])
	) {
		throw new Error(`${actionId} fixture does not match`);
	}
	const variableFeeds = new Set([
		"github.list_authenticated_user_events",
		"github.list_authenticated_user_received_events",
		"github.list_public_events",
		"github.list_user_public_events",
		"github.list_user_received_public_events",
	]);
	if (!member && variableFeeds.has(actionId)) return;
	const expectedEmpty = new Set([
		"github.get_commit_statuses",
		"github.list_pull_request_requested_reviewers",
		"github.list_pull_request_review_comments",
		"github.list_pull_request_reviews",
		"github.list_repository_forks",
		"github.list_repository_topics",
		"github.list_repository_watchers",
		"github.list_user_repositories",
		"github.search_code",
		"github.search_topics",
	]);
	if (!member && expectedEmpty.has(actionId) && result[envelope].length !== 0) {
		throw new Error(`${actionId} expected an empty fixture result`);
	}
	if (!member && !expectedEmpty.has(actionId)) {
		throw new Error(`${actionId} has no fixture assertion`);
	}
}

function valueAt(value, path) {
	return path.split(".").reduce((current, key) => current?.[key], value);
}

function readArrayEnvelope(actionId) {
	const groups = {
		artifacts: ["list_workflow_run_artifacts"],
		assets: ["list_release_assets"],
		assignees: ["list_assignees"],
		branches: ["list_branches"],
		check_runs: ["list_check_runs_for_ref"],
		collaborators: ["list_repository_collaborators"],
		comments: [
			"list_commit_comments",
			"list_issue_comments",
			"list_pull_request_review_comments",
		],
		commits: ["list_commits", "list_pull_request_commits"],
		contributors: ["list_repository_contributors"],
		entries: ["list_directory_contents"],
		events: [
			"list_authenticated_user_events",
			"list_authenticated_user_received_events",
			"list_issue_events",
			"list_issue_timeline_events",
			"list_public_events",
			"list_repository_events",
			"list_repository_issue_events",
			"list_user_public_events",
			"list_user_received_public_events",
		],
		files: ["list_pull_request_files"],
		items: [
			"search_code",
			"search_commits",
			"search_issues_and_pull_requests",
			"search_labels",
			"search_topics",
			"search_users",
		],
		issues: ["list_repository_issues"],
		jobs: ["list_workflow_run_jobs"],
		labels: ["list_issue_labels", "list_repository_labels"],
		milestones: ["list_milestones"],
		names: ["list_repository_topics"],
		pull_requests: [
			"list_pull_requests",
			"list_pull_requests_associated_with_commit",
		],
		refs: ["list_matching_refs"],
		releases: ["list_releases"],
		repositories: [
			"list_my_repositories",
			"list_my_starred_repositories",
			"list_organization_repositories",
			"list_repository_forks",
			"list_user_repositories",
			"search_repositories",
		],
		reviews: ["list_pull_request_reviews"],
		stargazers: ["list_repository_stargazers"],
		statuses: ["get_commit_statuses"],
		tags: ["list_repository_tags"],
		teams: [],
		users: ["list_pull_request_requested_reviewers"],
		watchers: ["list_repository_watchers"],
		workflow_runs: ["list_workflow_runs"],
		workflows: ["list_repository_workflows"],
	};
	const name = actionId.slice("github.".length);
	return Object.entries(groups).find(([, names]) => names.includes(name))?.[0];
}

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
			throw new McpCallError(payload.error.code, payload.error.data);
		}
		return payload.result?.structuredContent;
	};

	const connectionResult = await call("list_connections", {
		service: "github",
	});
	const activeGitHubConnections = connectionResult?.connections?.filter(
		(item) => item.providerId === "github" && item.status === "ACTIVE",
	);
	if (
		!Array.isArray(activeGitHubConnections) ||
		activeGitHubConnections.length !== 1 ||
		activeGitHubConnections[0]?.externalAccount !== target.externalAccount
	) {
		throw new Error(
			"Connection E2E consumer must expose exactly the approved GitHub account",
		);
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
		const approvedVersion = `${actionId}@v7`;
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
	const expectProviderNotFound = async (actionId, input) => {
		try {
			await call("execute_action", { actionId, input });
		} catch (error) {
			if (
				error instanceof McpCallError &&
				error.code === -32001 &&
				error.data?.providerHttpStatus === 404
			) {
				return;
			}
			throw error;
		}
		throw new Error(`${actionId} remained readable after deletion`);
	};
	const marker = `connection-e2e:${runId}`;
	const assertOwnedIssue = (issue) => {
		const hasCreatedMarker =
			issue?.body === `${marker} created` &&
			issue?.title === `${marker} conformance`;
		const hasUpdatedMarker =
			issue?.body === `${marker} updated` &&
			issue?.title === `${marker} updated`;
		if (
			issue?.number !== issueNumber ||
			(!hasCreatedMarker && !hasUpdatedMarker)
		) {
			throw new Error("test issue ownership marker does not match");
		}
	};
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
		} catch (error) {
			cleanup = "FAILED";
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
				cleanup = "FAILED";
				throw new Error("deleted comment is still visible");
			}
		}
		try {
			await expectProviderNotFound("github.get_issue_comment", {
				...repositoryInput,
				commentId,
			});
			commentDeleted = true;
		} catch (error) {
			cleanup = "FAILED";
			throw error;
		}

		const issueBeforeClose = await execute("github.get_issue", {
			...repositoryInput,
			issueNumber,
		});
		assertOwnedIssue(issueBeforeClose);
		if (issueBeforeClose.state !== "open") {
			throw new Error("test issue is not open before close");
		}
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
				let issue = await execute("github.get_issue", {
					...repositoryInput,
					issueNumber,
				});
				assertOwnedIssue(issue);
				if (issue.state === "open") {
					await execute("github.update_issue", {
						...repositoryInput,
						idempotencyKey: key("issue-close"),
						issueNumber,
						state: "closed",
					});
					issue = await execute("github.get_issue", {
						...repositoryInput,
						issueNumber,
					});
					assertOwnedIssue(issue);
				}
				if (issue.state !== "closed") {
					cleanup = "FAILED";
					cleanupError ??= new Error(
						"test issue cleanup did not close the issue",
					);
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

class McpCallError extends Error {
	constructor(code, data) {
		super(`Connection MCP error ${code ?? "unknown"}`);
		this.code = code;
		this.data = data;
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
	const isReadSuite = process.argv[2] === "read" && process.argv.length >= 4;
	const suite = isReadSuite ? "read" : "issue";
	const runId =
		(isReadSuite ? process.argv[3] : process.argv[2])?.trim() || randomUUID();
	try {
		const result = await (suite === "read"
			? runGitHubReadConformance
			: runGitHubIssueConformance)({
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
				suite,
			}),
		);
		process.exitCode = 1;
	}
}
