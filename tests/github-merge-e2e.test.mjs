import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubMergeConformance } from "./github-merge-e2e.mjs";

test("merge conformance requires its credential before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubMergeConformance({
			environment: { CONNECTION_GITHUB_E2E_ENABLED: "true" },
			fetch: async () => {
				requests += 1;
			},
			runId: "missing",
		}),
		/CONNECTION_E2E_TOKEN is required/,
	);
	assert.equal(requests, 0);
});

test("merge conformance merges only run-owned disposable branches", async () => {
	const calls = [];
	const evidence = await runGitHubMergeConformance({
		environment: {
			CONNECTION_E2E_TOKEN: "token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch: lifecycleFetch(calls),
		runId: "merge-run",
	});
	assert.deepEqual(evidence.actionVersionIds, [
		"github.merge_branch@v7",
		"github.merge_pull_request@v7",
	]);
	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.ok(calls.every(({ input }) => input.base !== "main"));
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_ref").length,
		4,
	);
});

function lifecycleFetch(calls) {
	let id = 0;
	return async (_url, options) => {
		const request = JSON.parse(options.body);
		const { arguments: args, name } = request.params;
		let structuredContent;
		if (name === "list_connections")
			structuredContent = {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			};
		else if (name === "get_action_guide")
			structuredContent = {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect: "WRITE",
				},
			};
		else {
			calls.push({ action: args.actionId, input: args.input });
			structuredContent = {
				action: args.actionId,
				actionVersionId: `${args.actionId}@v7`,
				callId: `call-${++id}`,
				result: resultFor(args.actionId, args.input),
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

function resultFor(action, input) {
	const marker = "connection-e2e:merge-run";
	if (action === "github.get_repository")
		return {
			default_branch: "main",
			full_name: "AgoraConnectionE2EORG/connector-conformance",
			id: 1369705971,
			private: true,
		};
	if (action === "github.get_branch")
		return {
			commit: {
				sha:
					input.branch === "main" || input.branch.includes("base")
						? "main-sha"
						: input.branch.includes("pr-head")
							? "pr-head-sha"
							: "branch-head-sha",
			},
		};
	if (action === "github.create_or_update_file")
		return {
			commit: {
				sha: input.branch.includes("pr-head")
					? "pr-head-sha"
					: "branch-head-sha",
			},
		};
	if (action === "github.merge_branch")
		return { sha: "branch-merge-sha", commit: { sha: "branch-merge-sha" } };
	if (action === "github.create_pull_request")
		return {
			base: { ref: "connection-e2e-pr-base-merge-run" },
			body: marker,
			head: { ref: "connection-e2e-pr-head-merge-run", sha: "pr-head-sha" },
			number: 80,
			state: "open",
			title: marker,
		};
	if (action === "github.get_pull_request")
		return {
			base: { ref: "connection-e2e-pr-base-merge-run" },
			body: marker,
			head: { ref: "connection-e2e-pr-head-merge-run", sha: "pr-head-sha" },
			number: 80,
			state: "open",
			title: marker,
		};
	if (action === "github.merge_pull_request")
		return { merged: true, message: "merged", sha: "pr-merge-sha" };
	if (action === "github.check_pull_request_merged") return { merged: true };
	if (action === "github.list_matching_refs") return { refs: [] };
	return { acknowledged: true, ref: input.ref };
}
