import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubRefAndLabelConformance } from "./github-low-risk-write-e2e.mjs";

test("GitHub ref and label conformance creates, updates, and deletes owned resources", async () => {
	const actions = [];
	let ref;
	let label;
	const fetch = async (_url, init) => {
		const request = JSON.parse(init.body);
		const { arguments: args, name: tool } = request.params;
		if (tool === "list_connections")
			return response(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		if (tool === "get_action_guide")
			return response(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect: args.actionId.startsWith("github.get_") ? "READ" : "WRITE",
				},
			});
		const { actionId, input } = args;
		actions.push({ actionId, input });
		if (actionId === "github.get_repository")
			return call(request.id, actionId, {
				default_branch: "main",
				full_name: "AgoraConnectionE2EORG/connector-conformance",
				id: 1369705971,
				private: true,
			});
		if (actionId === "github.create_ref") ref = input.ref;
		if (actionId === "github.rename_branch")
			ref = `refs/heads/${input.newName}`;
		if (actionId === "github.delete_ref") ref = undefined;
		if (actionId === "github.get_ref" && !ref) return provider404(request.id);
		if (actionId === "github.create_label") label = input.name;
		if (actionId === "github.update_label") label = input.newName;
		if (actionId === "github.delete_label") label = undefined;
		if (actionId === "github.get_label" && !label)
			return provider404(request.id);
		const result =
			actionId === "github.get_ref"
				? { ref }
				: actionId === "github.get_label"
					? { name: label }
					: actionId === "github.rename_branch"
						? { name: input.newName }
						: actionId.includes("label")
							? { name: label, ok: true }
							: { ok: true, ref };
		return call(request.id, actionId, result);
	};

	const evidence = await runGitHubRefAndLabelConformance({
		environment: {
			CONNECTION_E2E_TOKEN: "test-token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch,
		runId: "write-run",
	});

	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.equal(evidence.calls.length, 7);
	assert.ok(
		actions
			.filter(({ actionId }) => !actionId.startsWith("github.get_"))
			.every(({ input }) => input.idempotencyKey?.startsWith("write-run:")),
	);
	assert.doesNotMatch(JSON.stringify(evidence), /test-token|provider response/);
});

function response(id, structuredContent) {
	return Response.json({ id, jsonrpc: "2.0", result: { structuredContent } });
}

function call(id, action, result) {
	return response(id, {
		action,
		callId: `call-${id}`,
		result,
		status: "SUCCEEDED",
	});
}

function provider404(id) {
	return Response.json({
		error: { code: -32001, data: { providerHttpStatus: 404 } },
		id,
		jsonrpc: "2.0",
	});
}
