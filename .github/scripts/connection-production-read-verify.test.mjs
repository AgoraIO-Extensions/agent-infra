import assert from "node:assert/strict";
import test from "node:test";

import { verifyProductionReads } from "./connection-production-read-verify.mjs";

test("requires an active connection and a successful real READ", async () => {
	const calls = [];
	const fetch = async (_url, request) => {
		const body = JSON.parse(request.body);
		calls.push(body.params.name);
		const structuredContent =
			body.params.name === "list_connections"
				? { connections: [{ status: "ACTIVE", actionVersionIds: ["bitbucket.get_pull_request@v6"] }] }
				: body.params.name === "get_action_guide"
					? { action: { actionId: "bitbucket.get_pull_request", actionVersionId: "bitbucket.get_pull_request@v6", effect: "READ" } }
					: { callId: "call-1", status: "SUCCEEDED" };
		return { ok: true, json: async () => ({ result: { structuredContent } }) };
	};
	const result = await verifyProductionReads({
		endpoint: "https://connection.example/mcp",
		fetch,
		probes: [{ service: "bitbucket", actionId: "bitbucket.get_pull_request", input: {} }],
		token: "secret",
	});
	assert.deepEqual(calls, ["list_connections", "get_action_guide", "execute_action"]);
	assert.equal(result[0].callId, "call-1");
});

test("fails when the Provider READ does not succeed", async () => {
	const fetch = async (_url, request) => {
		const name = JSON.parse(request.body).params.name;
		const structuredContent =
			name === "list_connections"
				? { connections: [{ status: "ACTIVE", actionVersionIds: ["jira.get_issue@v8"] }] }
				: name === "get_action_guide"
					? { action: { actionId: "jira.get_issue", actionVersionId: "jira.get_issue@v8", effect: "READ" } }
					: { callId: "call-1", status: "FAILED" };
		return { ok: true, json: async () => ({ result: { structuredContent } }) };
	};

	await assert.rejects(
		verifyProductionReads({
			endpoint: "https://connection.example/mcp",
			fetch,
			probes: [{ service: "jira", actionId: "jira.get_issue", input: {} }],
			token: "secret",
		}),
		/did not succeed/,
	);
});

test("rejects a probe whose action belongs to another service", async () => {
	await assert.rejects(
		verifyProductionReads({
			endpoint: "https://connection.example/mcp",
			fetch: async () => {
				throw new Error("must not call");
			},
			probes: [{ service: "bitbucket", actionId: "jira.get_issue", input: {} }],
			token: "secret",
		}),
		/does not belong/,
	);
});
