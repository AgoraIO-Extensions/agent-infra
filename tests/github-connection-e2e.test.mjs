import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	runGitHubIssueConformance,
	runGitHubReadConformance,
} from "./github-connection-e2e.mjs";

test("GitHub read conformance emits sanitized evidence for every runnable scenario", async () => {
	const actions = [];
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const { arguments: args, name: tool } = request.params;
		if (tool === "list_connections") {
			return mcpResponse(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "get_action_guide") {
			return actionGuide(request.id, args.actionId);
		}
		actions.push(args.actionId);
		return mcpResponse(request.id, {
			action: args.actionId,
			callId: `read-call-${actions.length}`,
			result:
				args.actionId === "github.get_repository"
					? testRepository()
					: fakeReadResult(args.actionId),
			status: "SUCCEEDED",
		});
	};

	const evidence = await runGitHubReadConformance({
		environment: enabledEnvironment(),
		fetch,
		runId: "read-run",
	});

	assert.equal(actions.length, 77);
	assert.equal(actions[0], "github.get_repository");
	assert.equal(evidence.calls.length, 77);
	assert.deepEqual(evidence.failures, []);
	assert.deepEqual(evidence.skipped, [
		{
			actionVersionId: "github.get_pull_request_review@v7",
			reason: "SKIPPED_MISSING_SECOND_ACTOR",
		},
	]);
	assert.ok(
		evidence.calls.every(
			(call) =>
				call.actionVersionId.endsWith("@v7") &&
				call.inputHash.match(/^[a-f0-9]{64}$/) &&
				call.status === "SUCCEEDED",
		),
	);
	assert.doesNotMatch(
		JSON.stringify(evidence),
		/test-token|provider response body/,
	);
});

test("GitHub read conformance reports all reads after a fixture mismatch", async () => {
	const actions = [];
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const { arguments: args, name: tool } = request.params;
		if (tool === "list_connections") {
			return mcpResponse(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "get_action_guide")
			return actionGuide(request.id, args.actionId);
		actions.push(args.actionId);
		return mcpResponse(request.id, {
			action: args.actionId,
			callId: `read-call-${actions.length}`,
			result:
				args.actionId === "github.get_repository"
					? testRepository()
					: args.actionId === "github.list_commit_comments"
						? { comments: [] }
						: fakeReadResult(args.actionId),
			status: "SUCCEEDED",
		});
	};

	await assert.rejects(
		runGitHubReadConformance({
			environment: enabledEnvironment(),
			fetch,
			runId: "read-failure-run",
		}),
		(error) => {
			assert.deepEqual(error.evidence.failures, [
				{
					actionVersionId: "github.list_commit_comments@v7",
					error: "github.list_commit_comments fixture does not match",
				},
			]);
			assert.equal(actions.at(-1), "github.list_my_starred_repositories");
			return true;
		},
	);
});

test("GitHub conformance is disabled by default without any network request", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubIssueConformance({
			environment: {},
			fetch: async () => {
				requests += 1;
				throw new Error("network must not be reached");
			},
			runId: "run-disabled",
		}),
		/CONNECTION_GITHUB_E2E_ENABLED must be true/,
	);
	assert.equal(requests, 0);
});

test("GitHub conformance requires a Connection credential before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubIssueConformance({
			environment: { CONNECTION_GITHUB_E2E_ENABLED: "true" },
			fetch: async () => {
				requests += 1;
				throw new Error("network must not be reached");
			},
			runId: "run-no-token",
		}),
		/CONNECTION_E2E_TOKEN is required/,
	);
	assert.equal(requests, 0);
});

test("GitHub conformance CLI emits structured failure evidence", () => {
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("./github-connection-e2e.mjs", import.meta.url)),
			"run-cli",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				CONNECTION_E2E_TOKEN: "",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
		},
	);

	assert.equal(result.status, 1);
	assert.deepEqual(JSON.parse(result.stderr), {
		error: "CONNECTION_E2E_TOKEN is required",
		outcome: "FAILED",
		runId: "run-cli",
		suite: "issue",
	});
});

test("GitHub conformance rejects a mismatched repository before mutation", async () => {
	const calls = [];
	const urls = [];
	const fetch = async (url, init) => {
		urls.push(url);
		const request = JSON.parse(init.body);
		const tool = request.params.name;
		const action = request.params.arguments.actionId;
		calls.push(action ?? tool);
		const structuredContent =
			tool === "list_connections"
				? {
						connections: [
							{
								externalAccount: "328682695",
								providerId: "github",
								status: "ACTIVE",
							},
						],
					}
				: {
						action: "github.get_repository",
						result: {
							default_branch: "main",
							full_name: "AgoraConnectionE2EORG/connector-conformance",
							id: 999,
							private: true,
						},
						status: "SUCCEEDED",
					};
		return Response.json({
			id: request.id,
			jsonrpc: "2.0",
			result: { structuredContent },
		});
	};

	await assert.rejects(
		runGitHubIssueConformance({
			environment: {
				...enabledEnvironment(),
				CONNECTION_E2E_URL: "https://untrusted.example/mcp",
			},
			fetch,
			runId: "run-wrong-repository",
		}),
		/repository ID does not match/,
	);
	assert.deepEqual(calls, ["list_connections", "github.get_repository"]);
	assert.deepEqual(urls, [
		"https://agent-connector.la3.agoralab.co/mcp",
		"https://agent-connector.la3.agoralab.co/mcp",
	]);
});

test("GitHub conformance rejects an unmarked created issue before later mutation", async () => {
	const actions = [];
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const { arguments: args, name: tool } = request.params;
		if (tool === "list_connections") {
			return mcpResponse(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "get_action_guide") {
			return actionGuide(request.id, args.actionId);
		}
		actions.push(args.actionId);
		const result =
			args.actionId === "github.get_repository"
				? testRepository()
				: {
						body: "pre-existing issue",
						number: 19,
						state: "open",
						title: "wrong",
					};
		return mcpResponse(request.id, {
			action: args.actionId,
			callId: `call-${actions.length}`,
			result,
			status: "SUCCEEDED",
		});
	};

	await assert.rejects(
		runGitHubIssueConformance({
			environment: enabledEnvironment(),
			fetch,
			runId: "run-unmarked",
		}),
		/created issue ownership marker does not match/,
	);
	assert.deepEqual(actions, ["github.get_repository", "github.create_issue"]);
});

test("GitHub conformance rejects an unapproved ActionVersion before mutation", async () => {
	const actions = [];
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const { arguments: args, name: tool } = request.params;
		if (tool === "list_connections") {
			return mcpResponse(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "get_action_guide") {
			return mcpResponse(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v6`,
					effect:
						args.actionId.startsWith("github.get_") ||
						args.actionId.startsWith("github.list_")
							? "READ"
							: "WRITE",
				},
			});
		}
		actions.push(args.actionId);
		return mcpResponse(request.id, {
			action: args.actionId,
			callId: "call-preflight",
			result: testRepository(),
			status: "SUCCEEDED",
		});
	};

	await assert.rejects(
		runGitHubIssueConformance({
			environment: enabledEnvironment(),
			fetch,
			runId: "run-version-drift",
		}),
		/unapproved ActionVersion/,
	);
	assert.deepEqual(actions, ["github.get_repository"]);
});

test("GitHub conformance completes the marked issue and comment lifecycle", async () => {
	const actions = [];
	const guides = [];
	let notFoundReads = 0;
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const tool = request.params.name;
		const args = request.params.arguments;
		if (tool === "list_connections") {
			return mcpResponse(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "get_action_guide") {
			guides.push(args.actionId);
			return mcpResponse(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect:
						args.actionId.startsWith("github.get_") ||
						args.actionId.startsWith("github.list_")
							? "READ"
							: "WRITE",
				},
			});
		}
		const action = args.actionId;
		const input = args.input;
		if (
			action === "github.get_issue_comment" &&
			actions.some((entry) => entry.action === "github.delete_issue_comment")
		) {
			notFoundReads += 1;
			return Response.json({
				error: {
					code: -32001,
					data: { providerHttpStatus: 404 },
					message: "Provider request failed",
				},
				id: request.id,
				jsonrpc: "2.0",
			});
		}
		actions.push({ action, input });
		const result =
			action === "github.get_repository"
				? {
						default_branch: "main",
						full_name: "AgoraConnectionE2EORG/connector-conformance",
						id: 1369705971,
						private: true,
					}
				: action === "github.create_issue"
					? { body: input.body, number: 17, state: "open", title: input.title }
					: action === "github.get_issue"
						? {
								body: actions.some(
									(entry) => entry.action === "github.update_issue",
								)
									? "connection-e2e:run-happy updated"
									: "connection-e2e:run-happy created",
								number: 17,
								state: actions.some(
									(entry) =>
										entry.action === "github.update_issue" &&
										entry.input.state === "closed",
								)
									? "closed"
									: "open",
								title: actions.some(
									(entry) => entry.action === "github.update_issue",
								)
									? "connection-e2e:run-happy updated"
									: "connection-e2e:run-happy conformance",
							}
						: action === "github.create_issue_comment"
							? { body: input.body, id: 23 }
							: action === "github.get_issue_comment"
								? {
										body: actions.some(
											(entry) => entry.action === "github.update_issue_comment",
										)
											? "connection-e2e:run-happy comment updated"
											: "connection-e2e:run-happy comment",
										id: 23,
									}
								: action === "github.list_issue_comments"
									? { comments: [] }
									: {};
		return mcpResponse(request.id, {
			action,
			callId: `call-${actions.length}`,
			result,
			status: "SUCCEEDED",
		});
	};

	const result = await runGitHubIssueConformance({
		environment: enabledEnvironment(),
		fetch,
		runId: "run-happy",
	});

	assert.deepEqual(
		actions.map((entry) => entry.action),
		[
			"github.get_repository",
			"github.create_issue",
			"github.get_issue",
			"github.update_issue",
			"github.get_issue",
			"github.create_issue_comment",
			"github.get_issue_comment",
			"github.update_issue_comment",
			"github.get_issue_comment",
			"github.delete_issue_comment",
			"github.list_issue_comments",
			"github.get_issue",
			"github.update_issue",
			"github.get_issue",
		],
	);
	assert.deepEqual(guides, [
		"github.get_repository",
		"github.create_issue",
		"github.get_issue",
		"github.update_issue",
		"github.create_issue_comment",
		"github.get_issue_comment",
		"github.update_issue_comment",
		"github.delete_issue_comment",
		"github.list_issue_comments",
	]);
	assert.equal(notFoundReads, 1);
	const writes = actions.filter((entry) =>
		[
			"github.create_issue",
			"github.update_issue",
			"github.create_issue_comment",
			"github.update_issue_comment",
			"github.delete_issue_comment",
		].includes(entry.action),
	);
	assert.ok(
		writes.every(
			(entry) =>
				typeof entry.input.idempotencyKey === "string" &&
				entry.input.idempotencyKey.startsWith("run-happy:"),
		),
	);
	assert.deepEqual(result, {
		actionVersions: Object.fromEntries(
			guides.map((action) => [action, `${action}@v7`]),
		),
		calls: actions.slice(1).map((entry, index) => ({
			actionId: entry.action,
			callId: `call-${index + 2}`,
			status: "SUCCEEDED",
		})),
		cleanup: "SUCCEEDED",
		idempotencyKeys: [
			"run-happy:issue-create",
			"run-happy:issue-update",
			"run-happy:comment-create",
			"run-happy:comment-update",
			"run-happy:comment-delete",
			"run-happy:issue-close",
		],
		issueNumber: 17,
		runId: "run-happy",
	});
});

test("GitHub conformance never retries a started comment deletion", async () => {
	const actions = [];
	let notFoundReads = 0;
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const tool = request.params.name;
		const args = request.params.arguments;
		if (tool === "list_connections") {
			return mcpResponse(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "get_action_guide") {
			return mcpResponse(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect:
						args.actionId.startsWith("github.get_") ||
						args.actionId.startsWith("github.list_")
							? "READ"
							: "WRITE",
				},
			});
		}
		const action = args.actionId;
		const input = args.input;
		if (
			action === "github.get_issue_comment" &&
			actions.includes("github.delete_issue_comment")
		) {
			notFoundReads += 1;
			return Response.json({
				error: {
					code: -32001,
					data: { providerHttpStatus: 404 },
					message: "Provider request failed",
				},
				id: request.id,
				jsonrpc: "2.0",
			});
		}
		actions.push(action);
		if (action === "github.delete_issue_comment") {
			return Response.json({
				error: { code: -32001, message: "Provider outcome is uncertain" },
				id: request.id,
				jsonrpc: "2.0",
			});
		}
		const result =
			action === "github.get_repository"
				? {
						default_branch: "main",
						full_name: "AgoraConnectionE2EORG/connector-conformance",
						id: 1369705971,
						private: true,
					}
				: action === "github.create_issue"
					? { body: input.body, number: 18, state: "open", title: input.title }
					: action === "github.get_issue"
						? {
								body: actions.some((entry) => entry === "github.update_issue")
									? "connection-e2e:run-uncertain updated"
									: "connection-e2e:run-uncertain created",
								number: 18,
								state:
									actions.filter((entry) => entry === "github.update_issue")
										.length > 1
										? "closed"
										: "open",
								title: actions.some((entry) => entry === "github.update_issue")
									? "connection-e2e:run-uncertain updated"
									: "connection-e2e:run-uncertain conformance",
							}
						: action === "github.create_issue_comment"
							? { body: input.body, id: 24 }
							: action === "github.get_issue_comment"
								? {
										body: actions.some(
											(entry) => entry === "github.update_issue_comment",
										)
											? "connection-e2e:run-uncertain comment updated"
											: "connection-e2e:run-uncertain comment",
										id: 24,
									}
								: action === "github.list_issue_comments"
									? { comments: [] }
									: {};
		return mcpResponse(request.id, {
			action,
			callId: `call-${actions.length}`,
			result,
			status: "SUCCEEDED",
		});
	};

	const result = await runGitHubIssueConformance({
		environment: enabledEnvironment(),
		fetch,
		runId: "run-uncertain",
	});
	assert.equal(result.cleanup, "RECONCILED");
	assert.equal(
		actions.filter((action) => action === "github.delete_issue_comment").length,
		1,
	);
	assert.equal(
		actions.filter((action) => action === "github.list_issue_comments").length,
		1,
	);
	assert.equal(notFoundReads, 1);
});

function enabledEnvironment() {
	return {
		CONNECTION_E2E_TOKEN: "connection-test-token",
		CONNECTION_GITHUB_E2E_ENABLED: "true",
	};
}

function mcpResponse(id, structuredContent) {
	return Response.json({
		id,
		jsonrpc: "2.0",
		result: { structuredContent },
	});
}

function actionGuide(id, actionId) {
	const verb = actionId.slice("github.".length).split("_", 1)[0];
	return mcpResponse(id, {
		action: {
			actionId,
			actionVersionId: `${actionId}@v7`,
			effect: ["check", "compare", "get", "list", "search"].includes(verb)
				? "READ"
				: "WRITE",
		},
	});
}

function testRepository() {
	return {
		default_branch: "main",
		full_name: "AgoraConnectionE2EORG/connector-conformance",
		id: 1369705971,
		private: true,
	};
}

function fakeReadResult(actionId) {
	const exact = {
		"github.check_pull_request_merged": { merged: false },
		"github.check_repository_starred": { starred: true },
		"github.compare_commits": { comparison: {} },
		"github.get_branch": { name: "main" },
		"github.get_commit": { sha: "410b111ccf673ab03ecb7239391442e226ad48fd" },
		"github.get_current_user": { id: 328682695 },
		"github.get_file_contents": { path: "fixtures/read-target.txt" },
		"github.get_issue": { number: 1 },
		"github.get_issue_comment": { id: 5662497553 },
		"github.get_label": { name: "connection-e2e-fixture" },
		"github.get_latest_release": { id: 388309497 },
		"github.get_milestone": { number: 1 },
		"github.get_pull_request": { number: 2 },
		"github.get_ref": { ref: "refs/heads/main" },
		"github.get_release": { id: 388309497 },
		"github.get_release_asset": { id: 563149878 },
		"github.get_release_by_tag": { tag_name: "connection-e2e-fixture-v1" },
		"github.get_repository_permission_for_user": { user: { id: 328682695 } },
		"github.get_repository_readme": { path: "README.md" },
		"github.get_user": { id: 328682695 },
		"github.get_workflow": { id: 357727076 },
		"github.get_workflow_run": { id: 34833158492 },
		"github.list_repository_languages": { languages: {} },
	};
	if (exact[actionId]) return exact[actionId];
	const members = {
		"github.list_assignees": { id: 328682695 },
		"github.list_branches": { name: "main" },
		"github.list_check_runs_for_ref": { id: 103940918709 },
		"github.list_commit_comments": { id: 200307541 },
		"github.list_commits": { sha: "410b111ccf673ab03ecb7239391442e226ad48fd" },
		"github.list_directory_contents": { path: "README.md" },
		"github.list_issue_comments": { id: 5662497553 },
		"github.list_issue_events": { actor: { id: 328682695 } },
		"github.list_issue_labels": { name: "connection-e2e-fixture" },
		"github.list_issue_timeline_events": { actor: { id: 328682695 } },
		"github.list_matching_refs": { ref: "refs/heads/main" },
		"github.list_milestones": { number: 1 },
		"github.list_my_repositories": { id: 1369705971 },
		"github.list_my_starred_repositories": { id: 1369705971 },
		"github.list_organization_repositories": { id: 1369705971 },
		"github.list_pull_request_commits": {
			sha: "82285418de307b681dd8842e24c1af705a88345d",
		},
		"github.list_pull_request_files": { filename: "fixtures/pull-request.txt" },
		"github.list_pull_requests": { number: 2 },
		"github.list_pull_requests_associated_with_commit": { number: 2 },
		"github.list_release_assets": { id: 563149878 },
		"github.list_releases": { id: 388309497 },
		"github.list_repository_contributors": { id: 328682695 },
		"github.list_repository_collaborators": { id: 328682695 },
		"github.list_repository_events": { repo: { id: 1369705971 } },
		"github.list_repository_issue_events": { actor: { id: 328682695 } },
		"github.list_repository_issues": { number: 1 },
		"github.list_repository_labels": { name: "connection-e2e-fixture" },
		"github.list_repository_stargazers": { id: 328682695 },
		"github.list_repository_tags": { name: "connection-e2e-fixture-v1" },
		"github.list_workflow_run_artifacts": { id: 10343191621 },
		"github.list_workflow_run_jobs": { id: 103940918709 },
		"github.list_workflow_runs": { id: 34833158492 },
		"github.list_repository_workflows": { id: 357727076 },
		"github.search_commits": {
			sha: "410b111ccf673ab03ecb7239391442e226ad48fd",
		},
		"github.search_issues_and_pull_requests": { number: 1 },
		"github.search_labels": { name: "connection-e2e-fixture" },
		"github.search_repositories": { id: 1369705971 },
		"github.search_users": { id: 328682695 },
	};
	const envelopes = {
		"github.get_commit_statuses": "statuses",
		"github.list_assignees": "assignees",
		"github.list_authenticated_user_events": "events",
		"github.list_authenticated_user_received_events": "events",
		"github.list_branches": "branches",
		"github.list_check_runs_for_ref": "check_runs",
		"github.list_commit_comments": "comments",
		"github.list_commits": "commits",
		"github.list_directory_contents": "entries",
		"github.list_issue_comments": "comments",
		"github.list_issue_events": "events",
		"github.list_issue_labels": "labels",
		"github.list_issue_timeline_events": "events",
		"github.list_matching_refs": "refs",
		"github.list_milestones": "milestones",
		"github.list_my_repositories": "repositories",
		"github.list_my_starred_repositories": "repositories",
		"github.list_organization_repositories": "repositories",
		"github.list_public_events": "events",
		"github.list_pull_request_commits": "commits",
		"github.list_pull_request_files": "files",
		"github.list_pull_request_requested_reviewers": "users",
		"github.list_pull_request_review_comments": "comments",
		"github.list_pull_request_reviews": "reviews",
		"github.list_pull_requests": "pull_requests",
		"github.list_pull_requests_associated_with_commit": "pull_requests",
		"github.list_release_assets": "assets",
		"github.list_releases": "releases",
		"github.list_repository_collaborators": "collaborators",
		"github.list_repository_contributors": "contributors",
		"github.list_repository_events": "events",
		"github.list_repository_forks": "repositories",
		"github.list_repository_issue_events": "events",
		"github.list_repository_issues": "issues",
		"github.list_repository_labels": "labels",
		"github.list_repository_stargazers": "stargazers",
		"github.list_repository_tags": "tags",
		"github.list_repository_topics": "names",
		"github.list_repository_watchers": "watchers",
		"github.list_repository_workflows": "workflows",
		"github.list_user_public_events": "events",
		"github.list_user_received_public_events": "events",
		"github.list_user_repositories": "repositories",
		"github.list_workflow_run_artifacts": "artifacts",
		"github.list_workflow_run_jobs": "jobs",
		"github.list_workflow_runs": "workflow_runs",
		"github.search_code": "items",
		"github.search_commits": "items",
		"github.search_issues_and_pull_requests": "items",
		"github.search_labels": "items",
		"github.search_repositories": "repositories",
		"github.search_topics": "items",
		"github.search_users": "items",
	};
	const envelope = envelopes[actionId];
	assert.ok(envelope, `missing fake result for ${actionId}`);
	return { [envelope]: members[actionId] ? [members[actionId]] : [] };
}
