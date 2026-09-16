import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubCommitReactionConformance } from "./github-commit-reaction-e2e.mjs";

test("commit and reaction conformance requires the primary credential before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubCommitReactionConformance({
			environment: { CONNECTION_GITHUB_E2E_ENABLED: "true" },
			fetch: async () => {
				requests += 1;
			},
			runId: "missing-token",
		}),
		/CONNECTION_E2E_TOKEN is required/,
	);
	assert.equal(requests, 0);
});

test("commit and reaction conformance mutates only run-owned resources and cleans them", async () => {
	const calls = [];
	const evidence = await runGitHubCommitReactionConformance({
		environment: {
			CONNECTION_E2E_TOKEN: "primary-token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch: lifecycleFetch(calls),
		runId: "commit-run",
	});
	assert.deepEqual(evidence.actionVersionIds, [
		"github.create_commit_status@v7",
		"github.create_commit_comment@v7",
		"github.create_issue_reaction@v7",
		"github.create_issue_comment_reaction@v7",
	]);
	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.deepEqual(
		calls
			.filter(({ action }) => action.startsWith("github.create_"))
			.map(({ input }) => input.idempotencyKey),
		[
			"commit-run:ref-create",
			"commit-run:file-create",
			"commit-run:status-create",
			"commit-run:commit-comment-create",
			"commit-run:issue-create",
			"commit-run:issue-comment-create",
			"commit-run:issue-reaction-create",
			"commit-run:comment-reaction-create",
		],
	);
});

test("commit and reaction conformance cleans a created issue when ownership read fails", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubCommitReactionConformance({
			environment: {
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { failAction: "github.get_issue" }),
			runId: "commit-run",
		}),
		/fetch failed/,
	);
	assert.ok(
		calls.some(
			({ action, input }) =>
				action === "github.update_issue" && input.state === "closed",
		),
	);
});

test("commit and reaction conformance reconciles an uncertain branch before cleanup", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubCommitReactionConformance({
			environment: {
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { failCreateRef: true }),
			runId: "commit-run",
		}),
		/fetch failed/,
	);
	assert.ok(
		calls.some(
			({ action, input }) =>
				action === "github.delete_ref" &&
				input.ref === "heads/connection-e2e-commit-commit-run",
		),
	);
});

function lifecycleFetch(calls, config = {}) {
	const actionCounts = new Map();
	let branchAdvanced = false;
	let id = 0;
	return async (_url, options) => {
		const request = JSON.parse(options.body);
		const { arguments: args, name } = request.params;
		let structuredContent;
		if (name === "list_connections") {
			structuredContent = {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			};
		} else if (name === "get_action_guide") {
			structuredContent = {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect: "WRITE",
				},
			};
		} else {
			const action = args.actionId;
			const input = args.input;
			calls.push({ action, input });
			const actionCount = (actionCounts.get(action) ?? 0) + 1;
			actionCounts.set(action, actionCount);
			if (config.failCreateRef && action === "github.create_ref")
				throw new Error("fetch failed");
			if (action === config.failAction) throw new Error("fetch failed");
			if (action === "github.create_or_update_file") branchAdvanced = true;
			structuredContent = {
				action,
				actionVersionId: `${action}@v7`,
				callId: `call-${++id}`,
				result: providerResult(action, input, {
					actionCount,
					branchAdvanced,
					config,
				}),
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

function providerResult(action, input, state) {
	const marker = "connection-e2e:commit-run";
	return (
		{
			"github.create_commit_comment": {
				body: marker,
				commit_id: "commit-1",
				id: 40,
			},
			"github.create_commit_status": {
				context: marker,
				id: 30,
				state: "success",
			},
			"github.create_issue": {
				body: marker,
				number: 50,
				state: "open",
				title: marker,
			},
			"github.create_issue_comment": { body: marker, id: 60 },
			"github.create_issue_comment_reaction": { content: "eyes", id: 70 },
			"github.create_issue_reaction": { content: "rocket", id: 71 },
			"github.create_or_update_file": { commit: { sha: "commit-1" } },
			"github.get_branch": {
				commit: { sha: state.branchAdvanced ? "commit-1" : "main-1" },
			},
			"github.get_issue": {
				body: marker,
				number: 50,
				state: "open",
				title: marker,
			},
			"github.get_issue_comment": { body: marker, id: 60 },
			"github.get_commit_statuses": {
				statuses: [{ context: marker, id: 30, state: "success" }],
			},
			"github.get_repository": {
				default_branch: "main",
				full_name: "AgoraConnectionE2EORG/connector-conformance",
				id: 1369705971,
				private: true,
			},
			"github.list_matching_refs": {
				refs:
					state.config.failCreateRef && state.actionCount > 1
						? [
								{
									object: { sha: "main-1" },
									ref: "refs/heads/connection-e2e-commit-commit-run",
								},
							]
						: [],
			},
			"github.update_issue": {
				body: marker,
				number: 50,
				state: input.state,
				title: marker,
			},
		}[action] ?? { acknowledged: true, ref: input.ref }
	);
}
