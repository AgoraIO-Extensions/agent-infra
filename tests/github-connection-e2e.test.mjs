import assert from "node:assert/strict";
import test from "node:test";

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
								body: "connection-e2e:run-happy updated",
								number: 17,
								state: actions.some(
									(entry) =>
										entry.action === "github.update_issue" &&
										entry.input.state === "closed",
								)
									? "closed"
									: "open",
								title: "connection-e2e:run-happy updated",
							}
						: action === "github.create_issue_comment"
							? { body: input.body, id: 23 }
							: action === "github.get_issue_comment"
								? { body: "connection-e2e:run-happy comment updated", id: 23 }
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
					? { number: 18 }
					: action === "github.create_issue_comment"
						? { id: 24 }
						: action === "github.get_issue_comment"
							? { body: "connection-e2e:run-uncertain comment updated", id: 24 }
							: {};
		return mcpResponse(request.id, {
			action,
			callId: `call-${actions.length}`,
			result,
			status: "SUCCEEDED",
		});
	};

	await assert.rejects(
		runGitHubIssueConformance({
			environment: enabledEnvironment(),
			fetch,
			runId: "run-uncertain",
		}),
		/outcome is uncertain/,
	);
	assert.equal(
		actions.filter((action) => action === "github.delete_issue_comment").length,
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
