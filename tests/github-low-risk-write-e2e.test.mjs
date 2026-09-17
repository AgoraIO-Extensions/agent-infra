import assert from "node:assert/strict";
import test from "node:test";

import { runGitHubLowRiskWriteConformance } from "./github-low-risk-write-e2e.mjs";

test("GitHub ref and label conformance creates, updates, and deletes owned resources", async () => {
	const actions = [];
	let ref;
	let label;
	let issueLabels = [];
	let assignees = [];
	let topics = [];
	let starred = true;
	let file;
	let milestone;
	let release;
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
					actionVersionId: `${args.actionId}@v8`,
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
				owner: { id: 329053903 },
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
		if (actionId === "github.create_issue")
			return call(request.id, actionId, { number: 17 });
		if (
			actionId === "github.add_issue_labels" ||
			actionId === "github.set_issue_labels"
		) {
			issueLabels = input.labels.map((name) => ({ name }));
			return call(request.id, actionId, { labels: issueLabels });
		}
		if (actionId === "github.remove_issue_label") {
			issueLabels = issueLabels.filter(({ name }) => name !== input.label);
			return call(request.id, actionId, { labels: issueLabels });
		}
		if (actionId === "github.clear_issue_labels") {
			issueLabels = [];
			return call(request.id, actionId, { ok: true });
		}
		if (actionId === "github.add_issue_assignees") {
			assignees = input.assignees.map((login) => ({ login }));
			return call(request.id, actionId, { assignees });
		}
		if (actionId === "github.remove_issue_assignees") {
			assignees = [];
			return call(request.id, actionId, { assignees });
		}
		if (actionId === "github.lock_issue")
			return call(request.id, actionId, { locked: true });
		if (actionId === "github.unlock_issue")
			return call(request.id, actionId, { locked: false });
		if (actionId === "github.create_or_update_file") {
			file = { path: input.path, sha: "file-sha" };
			return call(request.id, actionId, { content: file });
		}
		if (actionId === "github.delete_file") {
			file = undefined;
			return call(request.id, actionId, { content: null, commit: {} });
		}
		if (actionId === "github.get_file_contents" && !file)
			return provider404(request.id);
		if (actionId === "github.list_repository_topics")
			return call(request.id, actionId, { names: topics });
		if (actionId === "github.replace_repository_topics") {
			topics = [...input.names];
			return call(request.id, actionId, { names: topics });
		}
		if (actionId === "github.check_repository_starred")
			return call(request.id, actionId, { starred });
		if (actionId === "github.star_repository") starred = true;
		if (actionId === "github.unstar_repository") starred = false;
		if (actionId === "github.create_milestone") {
			milestone = { number: 31, title: input.title };
			return call(request.id, actionId, milestone);
		}
		if (actionId === "github.update_milestone") {
			milestone = { number: input.milestoneNumber, title: input.title };
			return call(request.id, actionId, milestone);
		}
		if (actionId === "github.delete_milestone") milestone = undefined;
		if (actionId === "github.generate_release_notes")
			return call(request.id, actionId, { body: "notes", name: "notes" });
		if (actionId === "github.create_release") {
			release = { id: 41, name: input.name, tag_name: input.tagName };
			return call(request.id, actionId, release);
		}
		if (actionId === "github.update_release") {
			release = { ...release, name: input.name };
			return call(request.id, actionId, release);
		}
		if (actionId === "github.delete_release") release = undefined;
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

	const evidence = await runGitHubLowRiskWriteConformance({
		environment: {
			CONNECTION_E2E_TOKEN: "test-token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch,
		runId: "write-run",
	});

	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.equal(evidence.calls.length, 27);
	assert.deepEqual(topics, []);
	assert.equal(starred, true);
	assert.equal(file, undefined);
	assert.equal(milestone, undefined);
	assert.equal(release, undefined);
	assert.ok(
		actions
			.filter(({ input }) => input.idempotencyKey !== undefined)
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
