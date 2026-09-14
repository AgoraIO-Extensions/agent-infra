import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runGitHubIssueConformance } from "./github-connection-e2e.mjs";

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
							full_name: "AGORAconnectionE2E/connector-conformance",
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
					actionVersionId: `${args.actionId}@v5`,
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
		actions.push({ action, input });
		const result =
			action === "github.get_repository"
				? {
						default_branch: "main",
						full_name: "AGORAconnectionE2E/connector-conformance",
						id: 1368335067,
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
			guides.map((action) => [action, `${action}@v5`]),
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
					actionVersionId: `${args.actionId}@v5`,
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
						full_name: "AGORAconnectionE2E/connector-conformance",
						id: 1368335067,
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
	return mcpResponse(id, {
		action: {
			actionId,
			actionVersionId: `${actionId}@v5`,
			effect:
				actionId.startsWith("github.get_") ||
				actionId.startsWith("github.list_")
					? "READ"
					: "WRITE",
		},
	});
}

function testRepository() {
	return {
		default_branch: "main",
		full_name: "AGORAconnectionE2E/connector-conformance",
		id: 1368335067,
		private: true,
	};
}
