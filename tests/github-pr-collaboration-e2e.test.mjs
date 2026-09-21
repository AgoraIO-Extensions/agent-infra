import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubPullRequestCollaboration } from "./github-pr-collaboration-e2e.mjs";

test("pull request collaboration requires both scoped credentials before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {},
			fetch: async () => {
				requests += 1;
			},
			runId: "missing-token",
		}),
		/CONNECTION_E2E_TOKEN is required/,
	);
	assert.equal(requests, 0);
});

test("pull request collaboration rejects an unexpected reviewer account", async () => {
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: async (_url, options) => {
				const request = JSON.parse(options.body);
				const token = options.headers.authorization.replace("Bearer ", "");
				return Response.json({
					id: request.id,
					jsonrpc: "2.0",
					result: {
						structuredContent: {
							connections: [
								{
									externalAccount:
										token === "primary-token" ? "328682695" : "wrong",
									providerId: "github",
									status: "ACTIVE",
								},
							],
						},
					},
				});
			},
			runId: "wrong-reviewer",
		}),
		/approved GitHub account/,
	);
});

test("pull request collaboration completes and cleans an owned lifecycle", async () => {
	const calls = [];
	const evidence = await runGitHubPullRequestCollaboration({
		environment: {
			CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
			CONNECTION_E2E_TOKEN: "primary-token",
		},
		fetch: lifecycleFetch(calls),
		runId: "pr-run",
	});

	assert.deepEqual(evidence.actionVersionIds, [
		"github.create_pull_request@v9",
		"github.update_pull_request@v9",
		"github.request_pull_request_reviewers@v9",
		"github.remove_pull_request_reviewers@v9",
		"github.update_pull_request_branch@v9",
	]);
	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.equal(evidence.pullNumber, 31);
	assert.deepEqual(
		new Set(calls.filter(({ target }) => target).map(({ target }) => target)),
		new Set(evidence.actionVersionIds),
	);
	assert.deepEqual(
		calls
			.filter(({ action }) => action === "github.delete_ref")
			.map(({ input }) => input.ref),
		["heads/connection-e2e-pr-pr-run", "heads/connection-e2e-base-pr-run"],
	);
});

test("pull request collaboration reconciles an uncertain PR creation before cleanup", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: lifecycleFetch(calls, {
				failAction: "github.create_pull_request",
			}),
			runId: "pr-run",
		}),
		/fetch failed after submission started/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.create_pull_request")
			.length,
		1,
	);
	assert.ok(
		calls.some(
			({ action, input }) =>
				action === "github.update_pull_request" && input.state === "closed",
		),
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_ref").length,
		2,
	);
});

test("pull request collaboration fails when cleanup is incomplete", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: lifecycleFetch(calls, { failAction: "github.delete_ref" }),
			runId: "pr-run",
		}),
		/cleanup failed: fetch failed after submission started/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_ref").length,
		2,
	);
});

test("pull request collaboration reports cleanup failure after a lifecycle failure", async () => {
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: lifecycleFetch([], {
				failActions: ["github.create_pull_request", "github.delete_ref"],
			}),
			runId: "pr-run",
		}),
		/fetch failed after submission started; cleanup failed:/,
	);
});

test("pull request collaboration refuses a pre-existing fixture branch", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: lifecycleFetch(calls, { preexistingRef: true }),
			runId: "pr-run",
		}),
		/fixture ref already exists/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.create_ref").length,
		0,
	);
});

test("pull request collaboration closes a provider-owned PR when its create projection is malformed", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: lifecycleFetch(calls, { malformedCreateResponse: true }),
			runId: "pr-run",
		}),
		/ownership marker does not match/,
	);
	assert.ok(
		calls.some(
			({ action, input }) =>
				action === "github.update_pull_request" && input.state === "closed",
		),
	);
});

test("pull request collaboration rechecks an uncertain ref during cleanup", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubPullRequestCollaboration({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
			},
			fetch: lifecycleFetch(calls, { uncertainRef: true }),
			runId: "pr-run",
		}),
		/fetch failed after submission started/,
	);
	assert.ok(
		calls.some(
			({ action, input }) =>
				action === "github.delete_ref" &&
				input.ref === "heads/connection-e2e-base-pr-run",
		),
	);
});

function lifecycleFetch(calls, config = {}) {
	let branchUpdated = false;
	const deletedRefs = new Set();
	let executeId = 0;
	let pullClosed = false;
	const failedActions = new Set();
	const actionCounts = new Map();
	return async (_url, requestOptions) => {
		const request = JSON.parse(requestOptions.body);
		const token = requestOptions.headers.authorization.replace("Bearer ", "");
		const tool = request.params.name;
		const args = request.params.arguments;
		let structuredContent;
		if (tool === "list_connections") {
			structuredContent = {
				connections: [
					{
						externalAccount:
							token === "primary-token" ? "328682695" : "329435106",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			};
		} else if (tool === "get_action_guide") {
			structuredContent = {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v9`,
					effect: args.actionId.startsWith("github.get_") ? "READ" : "WRITE",
				},
			};
		} else {
			const action = args.actionId;
			const input = args.input;
			const target = targetActions.has(action) ? `${action}@v9` : undefined;
			calls.push({ action, input, target, token });
			const actionCount = (actionCounts.get(action) ?? 0) + 1;
			actionCounts.set(action, actionCount);
			if (
				config.uncertainRef &&
				((action === "github.create_ref" && actionCount === 1) ||
					(action === "github.list_matching_refs" &&
						(actionCount === 2 || actionCount === 3)))
			) {
				throw new Error("fetch failed after submission started");
			}
			const shouldFail =
				action === config.failAction || config.failActions?.includes(action);
			if (shouldFail && !failedActions.has(action)) {
				failedActions.add(action);
				throw new Error("fetch failed after submission started");
			}
			if (action === "github.update_pull_request_branch") branchUpdated = true;
			if (action === "github.update_pull_request" && input.state === "closed")
				pullClosed = true;
			if (action === "github.delete_ref") deletedRefs.add(input.ref);
			const result = providerResult(action, input, {
				actionCount,
				branchUpdated,
				config,
				deletedRefs,
				pullClosed,
			});
			structuredContent = {
				action,
				actionVersionId: `${action}@v9`,
				callId: `call-${++executeId}`,
				result,
				status: "SUCCEEDED",
			};
		}
		return Response.json({
			id: request.id,
			jsonrpc: "2.0",
			result: { structuredContent },
		});
	};
}

const targetActions = new Set([
	"github.create_pull_request",
	"github.update_pull_request",
	"github.request_pull_request_reviewers",
	"github.remove_pull_request_reviewers",
	"github.update_pull_request_branch",
]);

function providerResult(action, input, state) {
	const marker = "connection-e2e:pr-run";
	const results = {
		"github.create_or_update_file": {
			commit: { sha: input.branch?.includes("base") ? "base-2" : "head-1" },
		},
		"github.create_pull_request": {
			base: { ref: "connection-e2e-base-pr-run" },
			body: state.config.malformedCreateResponse ? "wrong" : marker,
			head: { ref: "connection-e2e-pr-pr-run", sha: "head-1" },
			number: 31,
			state: "open",
			title: marker,
		},
		"github.create_pull_request_review": {
			body: marker,
			id: 71,
			state: "PENDING",
			user: { id: 329435106 },
		},
		"github.dismiss_pull_request_review": {
			body: marker,
			id: 71,
			state: "DISMISSED",
			user: { id: 329435106 },
		},
		"github.get_branch": { commit: { sha: "main-1" } },
		"github.get_pull_request": {
			base: { ref: "connection-e2e-base-pr-run" },
			body: marker,
			head: {
				ref: "connection-e2e-pr-pr-run",
				sha: state.branchUpdated ? "head-2" : "head-1",
			},
			number: 31,
			state: state.pullClosed ? "closed" : "open",
			title: marker,
		},
		"github.get_repository": {
			default_branch: "main",
			full_name: "AgoraConnectionE2EORG/connector-conformance",
			id: 1369705971,
			private: true,
		},
		"github.list_pull_requests": {
			pull_requests: [
				{
					base: { ref: "connection-e2e-base-pr-run" },
					body: marker,
					head: { ref: "connection-e2e-pr-pr-run", sha: "head-1" },
					number: 31,
					title: marker,
				},
			],
		},
		"github.list_matching_refs": {
			refs:
				(state.config.preexistingRef ||
					(state.config.uncertainRef && state.actionCount >= 4)) &&
				!state.deletedRefs.has(input.ref)
					? [{ object: { sha: "main-1" }, ref: `refs/${input.ref}` }]
					: [],
		},
		"github.request_pull_request_reviewers": {
			requested_reviewers: [{ id: 329435106, login: "connectionE2E2" }],
		},
		"github.remove_pull_request_reviewers": { requested_reviewers: [] },
		"github.submit_pull_request_review": {
			body: marker,
			id: 71,
			state: "APPROVED",
			user: { id: 329435106 },
		},
		"github.update_pull_request": {
			body: input.body ?? marker,
			number: 31,
			state: input.state ?? "open",
			title: input.title ?? marker,
		},
		"github.update_pull_request_branch": {
			message: "Updating pull request branch.",
			url: "https://api.github.test/pr/31",
		},
	};
	return results[action] ?? { ref: `refs/${input.ref}` };
}
