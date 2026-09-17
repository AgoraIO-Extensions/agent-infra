import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubReviewHealth } from "./github-review-health.mjs";

test("Reviewer v2 health probe verifies account and repository through exact read actions", async () => {
	const calls = [];
	const result = await runGitHubReviewHealth({
		environment: { CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token" },
		fetch: async (_url, options) => {
			const request = JSON.parse(options.body);
			calls.push(request);
			const responses = {
				list_connections: {
					connections: [
						{
							externalAccount: "329435106",
							providerId: "github",
							status: "ACTIVE",
						},
					],
				},
				get_action_guide: {
					action: {
						actionId: request.params.arguments.actionId,
						actionVersionId: `${request.params.arguments.actionId}@v8`,
						effect: "READ",
					},
				},
				execute_action:
					request.params.arguments.actionId === "github.get_current_user"
						? {
								action: "github.get_current_user",
								actionVersionId: "github.get_current_user@v8",
								callId: "call-user",
								result: { id: 329435106, login: "connectionE2E2" },
								status: "SUCCEEDED",
							}
						: {
								action: "github.get_repository",
								actionVersionId: "github.get_repository@v8",
								callId: "call-repo",
								result: {
									default_branch: "main",
									id: 1369705971,
									full_name: "AgoraConnectionE2EORG/connector-conformance",
									private: true,
								},
								status: "SUCCEEDED",
							},
			};
			return Response.json({
				jsonrpc: "2.0",
				id: request.id,
				result: { structuredContent: responses[request.params.name] },
			});
		},
	});

	assert.deepEqual(result, {
		actionVersionIds: [
			"github.get_current_user@v8",
			"github.get_repository@v8",
		],
		account: "connectionE2E2",
		repository: "AgoraConnectionE2EORG/connector-conformance",
		status: "SUCCEEDED",
	});
	assert.equal(
		calls.filter((call) => call.params.name === "execute_action").length,
		2,
	);
});

test("Reviewer v2 health probe fails closed on an unexpected account", async () => {
	await assert.rejects(
		runGitHubReviewHealth({
			environment: { CONNECTION_E2E_REVIEWER_TOKEN: "reviewer-token" },
			fetch: async (_url, options) => {
				const request = JSON.parse(options.body);
				return Response.json({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						structuredContent: {
							connections: [
								{
									externalAccount: "wrong",
									providerId: "github",
									status: "ACTIVE",
								},
							],
						},
					},
				});
			},
		}),
		/approved GitHub account/,
	);
});
