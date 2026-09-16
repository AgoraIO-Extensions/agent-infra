import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runGitHubReviewConformance } from "./github-review-e2e.mjs";

test("GitHub review conformance completes an owned two-account lifecycle", async () => {
	const calls = [];
	const fetch = lifecycleFetch(calls);

	const evidence = await runGitHubReviewConformance({
		environment: {
			CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
			CONNECTION_E2E_TOKEN: "primary-token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch,
		runId: "review-run",
	});

	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.equal(evidence.pullNumber, 17);
	assert.deepEqual(
		evidence.actionVersionIds,
		reviewActions.map((id) => `${id}@v7`),
	);
	assert.ok(evidence.calls.every((call) => call.status === "SUCCEEDED"));
	assert.doesNotMatch(JSON.stringify(evidence), /primary-token|reviewer-token/);
	assert.deepEqual(
		calls
			.filter(({ token }) => token === "reviewer-token")
			.map(({ action }) => action),
		[
			"list_connections",
			"search_actions",
			...reviewActions.map(() => "get_action_guide"),
			"github.get_repository",
			"github.get_current_user",
			"github.get_pull_request",
			"github.list_pull_request_reviews",
			"github.list_pull_request_review_comments",
			"github.create_pull_request_review_comment",
			"github.update_pull_request_review_comment",
			"github.reply_pull_request_review_comment",
			"github.list_pull_request_review_comments",
			"github.delete_pull_request_review_comment",
			"github.delete_pull_request_review_comment",
			"github.create_pull_request_review",
			"github.get_pull_request_review",
			"github.submit_pull_request_review",
			"github.list_pull_request_reviews",
			"github.create_pull_request_review",
			"github.delete_pending_pull_request_review",
			"github.list_pull_request_review_comments",
			"github.list_pull_request_reviews",
		],
	);
	assert.deepEqual(
		calls
			.filter(({ token }) => token === "primary-token")
			.map(({ action }) => action),
		[
			"list_connections",
			"github.get_repository",
			"github.get_ref",
			"github.create_ref",
			"github.create_or_update_file",
			"github.create_pull_request",
			"github.update_pull_request",
			"github.delete_ref",
		],
	);
});

test("GitHub review conformance never retries a started reviewer write", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, {
				cleanupDeleteFailureId: 102,
				failAction: "github.create_pull_request_review_comment",
				marker: "connection-e2e:write-network-failure",
			}),
			runId: "write-network-failure",
		}),
		/fetch failed after submission started/,
	);
	assert.equal(
		calls.filter(
			({ action, token }) =>
				action === "github.create_pull_request_review_comment" &&
				token === "reviewer-token",
		).length,
		1,
	);
	assert.deepEqual(
		calls
			.filter(
				({ action, token }) =>
					action === "github.delete_pull_request_review_comment" &&
					token === "reviewer-token",
			)
			.map(({ input }) => input.commentId),
		[102, 101],
	);
	assert.ok(
		calls.some(
			({ action, token }) =>
				action === "github.list_pull_request_reviews" &&
				token === "reviewer-token",
		),
	);
	assert.deepEqual(
		calls
			.filter(({ token, input }) => token === "primary-token" && input)
			.slice(-2)
			.map(({ action }) => action),
		["github.update_pull_request", "github.delete_ref"],
	);
});

test("GitHub review conformance paginates marker-scoped cleanup", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, {
				failAction: "github.create_pull_request_review_comment",
				marker: "connection-e2e:paginated-cleanup",
				paginatedCleanup: true,
			}),
			runId: "paginated-cleanup",
		}),
		/fetch failed after submission started/,
	);
	assert.deepEqual(
		calls
			.filter(
				({ action, input }) =>
					action === "github.list_pull_request_review_comments" && input?.page,
			)
			.slice(-2)
			.map(({ input }) => input.page),
		[1, 2],
	);
	assert.ok(
		calls.some(
			({ action, input }) =>
				action === "github.delete_pull_request_review_comment" &&
				input?.commentId === 777,
		),
	);
});

test("GitHub review conformance reconciles an orphaned fixture pull read-only", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, {
				malformedPull: true,
				marker: "connection-e2e:orphaned-pull",
			}),
			runId: "orphaned-pull",
		}),
		/fixture pull number is invalid/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.create_pull_request")
			.length,
		1,
	);
	assert.deepEqual(
		calls
			.filter(({ token, input }) => token === "primary-token" && input)
			.slice(-4)
			.map(({ action }) => action),
		[
			"github.list_pull_requests",
			"github.get_pull_request",
			"github.update_pull_request",
			"github.delete_ref",
		],
	);
});

test("GitHub review conformance reconciles an uncertain fixture branch", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, {
				malformedRef: true,
				marker: "connection-e2e:uncertain-branch",
			}),
			runId: "uncertain-branch",
		}),
		/fixture ref does not match/,
	);
	assert.deepEqual(
		calls
			.filter(({ token, input }) => token === "primary-token" && input)
			.slice(-2)
			.map(({ action }) => action),
		["github.create_ref", "github.list_matching_refs"],
	);
});

test("GitHub review conformance preserves the branch when pull reconciliation fails", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, {
				malformedPull: true,
				marker: "connection-e2e:missing-pull",
				reconciliationEmpty: true,
			}),
			runId: "missing-pull",
		}),
		/fixture pull number is invalid/,
	);
	assert.deepEqual(
		calls
			.filter(({ token, input }) => token === "primary-token" && input)
			.slice(-1)
			.map(({ action }) => action),
		["github.list_pull_requests"],
	);
});

test("GitHub review conformance is disabled before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {},
			fetch: async () => {
				requests += 1;
			},
			runId: "disabled",
		}),
		/CONNECTION_GITHUB_E2E_ENABLED must be true/,
	);
	assert.equal(requests, 0);
});

test("GitHub review conformance requires the reviewer PAT before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: async () => {
				requests += 1;
			},
			runId: "missing-reviewer",
		}),
		/CONNECTION_E2E_REVIEWER_TOKEN is required/,
	);
	assert.equal(requests, 0);
});

test("GitHub review conformance preserves the safe MCP error message", async () => {
	for (const [message, expected] of [
		[
			"Provider request failed",
			"Connection MCP error -32001 during list_connections: Provider request failed",
		],
		[
			"Bearer secret-token",
			"Connection MCP error -32001 during list_connections",
		],
	]) {
		await assert.rejects(
			runGitHubReviewConformance({
				environment: {
					CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
					CONNECTION_E2E_TOKEN: "primary-token",
					CONNECTION_GITHUB_E2E_ENABLED: "true",
				},
				fetch: async (_url, init) => {
					const request = JSON.parse(init.body);
					return Response.json({
						error: {
							code: -32001,
							data: { providerBody: "must-not-appear" },
							message,
						},
						id: request.id,
						jsonrpc: "2.0",
					});
				},
				runId: "mcp-error",
			}),
			(error) => {
				assert.equal(error.message, expected);
				assert.doesNotMatch(error.message, /must-not-appear|secret-token/);
				return true;
			},
		);
	}
});

test("GitHub review conformance CLI emits sanitized failure evidence", () => {
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("./github-review-e2e.mjs", import.meta.url)),
			"cli-review-run",
		],
		{
			encoding: "utf8",
			env: {
				...process.env,
				CONNECTION_E2E_REVIEWER_TOKEN: "",
				CONNECTION_E2E_TOKEN: "primary-secret",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
		},
	);
	assert.equal(result.status, 1);
	assert.deepEqual(JSON.parse(result.stderr), {
		error: "CONNECTION_E2E_REVIEWER_TOKEN is required",
		outcome: "FAILED",
		runId: "cli-review-run",
		suite: "review",
	});
	assert.doesNotMatch(`${result.stdout}${result.stderr}`, /primary-secret/);
});

test("GitHub review conformance preserves an unowned fixture before reviewer mutation", async () => {
	const executed = [];
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const token = init.headers.authorization.replace("Bearer ", "");
		const { arguments: args, name: tool } = request.params;
		if (tool === "list_connections") {
			return response(request.id, {
				connections: [
					{
						externalAccount:
							token === "reviewer-token" ? "329435106" : "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "search_actions") {
			return response(request.id, {
				actions: reviewActions.map((actionId) => ({ actionId })),
			});
		}
		if (tool === "get_action_guide") {
			return response(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect: writeActions.has(args.actionId) ? "WRITE" : "READ",
				},
			});
		}
		executed.push({ action: args.actionId, token });
		const result = providerResult(args.actionId, args.input, executed);
		if (args.actionId === "github.create_pull_request")
			result.body = "someone-else";
		if (args.actionId === "github.list_pull_requests")
			result.pull_requests[0].body = "someone-else";
		return response(request.id, {
			action: args.actionId,
			actionVersionId: `${args.actionId}@v7`,
			callId: `call-${executed.length}`,
			result,
			status: "SUCCEEDED",
		});
	};

	await assert.rejects(
		runGitHubReviewConformance({
			environment: {
				CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token",
				CONNECTION_E2E_TOKEN: "primary-token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch,
			runId: "unowned",
		}),
		/fixture pull ownership marker does not match/,
	);
	assert.deepEqual(
		executed.slice(-2).map(({ action }) => action),
		["github.create_pull_request", "github.list_pull_requests"],
	);
	assert.equal(
		executed.some(
			({ action, token }) =>
				token === "reviewer-token" && writeActions.has(action),
		),
		false,
	);
});

const reviewActions = [
	"github.get_repository",
	"github.get_current_user",
	"github.get_pull_request",
	"github.get_pull_request_review",
	"github.list_pull_request_reviews",
	"github.list_pull_request_review_comments",
	"github.create_pull_request_review",
	"github.submit_pull_request_review",
	"github.create_pull_request_review_comment",
	"github.reply_pull_request_review_comment",
	"github.update_pull_request_review_comment",
	"github.delete_pull_request_review_comment",
	"github.delete_pending_pull_request_review",
];

const writeActions = new Set(reviewActions.slice(6));

function lifecycleFetch(calls, options = {}) {
	return async (_url, init) => {
		const request = JSON.parse(init.body);
		const token = init.headers.authorization.replace("Bearer ", "");
		const { arguments: args, name: tool } = request.params;
		const action = tool === "get_action_guide" ? tool : (args.actionId ?? tool);
		calls.push({ action, input: args.input, token });
		if (options.failAction === action && token === "reviewer-token") {
			throw new TypeError("fetch failed after submission started");
		}
		if (
			action === "github.delete_pull_request_review_comment" &&
			args.input?.commentId === options.cleanupDeleteFailureId
		) {
			throw new TypeError("cleanup delete failed");
		}
		if (tool === "list_connections") {
			return response(request.id, {
				connections: [
					{
						externalAccount:
							token === "reviewer-token" ? "329435106" : "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		}
		if (tool === "search_actions") {
			return response(request.id, {
				actions: reviewActions.map((actionId) => ({ actionId })),
			});
		}
		if (tool === "get_action_guide") {
			return response(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect: writeActions.has(args.actionId) ? "WRITE" : "READ",
				},
			});
		}
		if (options.malformedPull && action === "github.create_pull_request") {
			return response(request.id, {
				action,
				actionVersionId: `${action}@v7`,
				callId: `call-${calls.length}`,
				result: {
					body: options.marker,
					head: { sha: "head-sha" },
					state: "open",
					title: options.marker,
				},
				status: "SUCCEEDED",
			});
		}
		if (options.malformedRef && action === "github.create_ref") {
			return response(request.id, {
				action,
				actionVersionId: `${action}@v7`,
				callId: `call-${calls.length}`,
				result: { object: { sha: "base-sha" } },
				status: "SUCCEEDED",
			});
		}
		if (
			options.paginatedCleanup &&
			action === "github.list_pull_request_review_comments" &&
			args.input?.page
		) {
			const comments =
				args.input.page === 1
					? Array.from({ length: 100 }, (_, index) => ({
							body: "foreign",
							id: 1_000 + index,
							user: { id: 7 },
						}))
					: [
							{
								body: options.marker,
								id: 777,
								user: { id: 329435106 },
							},
						];
			return response(request.id, {
				action,
				actionVersionId: `${action}@v7`,
				callId: `call-${calls.length}`,
				result: { comments },
				status: "SUCCEEDED",
			});
		}
		return response(request.id, {
			action: args.actionId,
			actionVersionId: `${args.actionId}@v7`,
			callId: `call-${calls.length}`,
			result:
				options.reconciliationEmpty && action === "github.list_pull_requests"
					? { pull_requests: [] }
					: providerResult(
							args.actionId,
							args.input,
							calls,
							options.marker ?? "connection-e2e:review-run",
						),
			status: "SUCCEEDED",
		});
	};
}

function providerResult(
	action,
	input,
	calls,
	marker = "connection-e2e:review-run",
) {
	if (action === "github.get_repository") {
		return {
			default_branch: "main",
			full_name: "AgoraConnectionE2EORG/connector-conformance",
			id: 1369705971,
			private: true,
		};
	}
	if (action === "github.get_current_user")
		return { id: 329435106, login: "connectionE2E2" };
	if (action === "github.get_ref")
		return { object: { sha: "base-sha" }, ref: "refs/heads/main" };
	if (action === "github.create_ref")
		return { object: { sha: "base-sha" }, ref: input.ref };
	if (action === "github.list_matching_refs") {
		return {
			refs: [{ object: { sha: "base-sha" }, ref: `refs/${input.ref}` }],
		};
	}
	if (action === "github.create_or_update_file")
		return { commit: { sha: "head-sha" } };
	if (action === "github.create_pull_request") {
		return {
			body: input.body,
			head: { sha: "head-sha" },
			number: 17,
			state: "open",
			title: input.title,
		};
	}
	if (action === "github.get_pull_request") {
		const branch = calls
			.find(({ action: item }) => item === "github.create_ref")
			?.input?.ref?.replace("refs/heads/", "");
		return {
			body: marker,
			head: { ref: branch, sha: "head-sha" },
			number: 17,
			state: "open",
			title: marker,
		};
	}
	if (action === "github.list_pull_requests") {
		return {
			pull_requests: [
				{
					body: marker,
					head: { ref: input.head.split(":").at(-1), sha: "head-sha" },
					number: 17,
					state: "open",
					title: marker,
				},
			],
		};
	}
	if (action === "github.create_pull_request_review_comment")
		return { body: input.body, id: 101, user: { id: 329435106 } };
	if (action === "github.update_pull_request_review_comment")
		return { body: input.body, id: 101, user: { id: 329435106 } };
	if (action === "github.reply_pull_request_review_comment")
		return {
			body: input.body,
			id: 102,
			in_reply_to_id: 101,
			user: { id: 329435106 },
		};
	if (action === "github.list_pull_request_review_comments") {
		const deleted = calls.filter(
			({ action: item, input: executedInput }) =>
				item === "github.delete_pull_request_review_comment" && executedInput,
		).length;
		return {
			comments:
				deleted === 0
					? [
							{
								body: `${marker} updated`,
								id: 101,
								user: { id: 329435106 },
							},
							{
								body: `${marker} reply`,
								id: 102,
								in_reply_to_id: 101,
								user: { id: 329435106 },
							},
							{
								body: `${marker} foreign`,
								id: 999,
								user: { id: 7 },
							},
						]
					: [],
		};
	}
	if (action === "github.create_pull_request_review") {
		const count = calls.filter(
			({ action: item, input: executedInput }) =>
				item === action && executedInput,
		).length;
		return {
			body: input.body,
			id: count === 1 ? 201 : 202,
			state: "PENDING",
			user: { id: 329435106 },
		};
	}
	if (action === "github.get_pull_request_review")
		return {
			body: marker,
			id: 201,
			state: "PENDING",
			user: { id: 329435106 },
		};
	if (action === "github.submit_pull_request_review")
		return {
			body: input.body,
			id: 201,
			state: "COMMENTED",
			user: { id: 329435106 },
		};
	if (action === "github.list_pull_request_reviews")
		return {
			reviews: [
				{
					body: marker,
					id: 201,
					state: "COMMENTED",
					user: { id: 329435106 },
				},
			],
		};
	if (action === "github.delete_pending_pull_request_review")
		return {
			body: marker,
			id: 202,
			state: "PENDING",
			user: { id: 329435106 },
		};
	if (action === "github.update_pull_request")
		return { number: 17, state: "closed" };
	return {};
}

function response(id, structuredContent) {
	return Response.json({ id, jsonrpc: "2.0", result: { structuredContent } });
}
