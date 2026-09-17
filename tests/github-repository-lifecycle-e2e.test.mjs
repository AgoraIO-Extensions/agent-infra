import assert from "node:assert/strict";
import test from "node:test";
import { runGitHubRepositoryLifecycle } from "./github-repository-lifecycle-e2e.mjs";

test("repository lifecycle requires a credential before networking", async () => {
	let requests = 0;
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: { CONNECTION_GITHUB_E2E_ENABLED: "true" },
			fetch: async () => {
				requests += 1;
			},
			runId: "repo-run",
		}),
		/CONNECTION_E2E_TOKEN is required/,
	);
	assert.equal(requests, 0);
});

test("repository lifecycle creates, updates, and deletes one private test repository", async () => {
	const calls = [];
	const evidence = await runGitHubRepositoryLifecycle({
		environment: {
			CONNECTION_E2E_TOKEN: "token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch: lifecycleFetch(calls),
		runId: "repo-run",
	});
	assert.deepEqual(evidence.actionVersionIds, [
		"github.create_repository@v7",
		"github.update_repository@v7",
		"github.delete_repository@v7",
	]);
	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_repository").length,
		1,
	);
});

test("repository lifecycle refuses to delete a repository with only a marker prefix", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { foreignDescriptionOnCleanup: true }),
			runId: "repo-run",
		}),
		/repository delete ownership marker does not match/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_repository").length,
		0,
	);
});

function lifecycleFetch(calls, config = {}) {
	let exists = false;
	let description = "";
	let id = 0;
	return async (_url, options) => {
		const request = JSON.parse(options.body);
		const { arguments: args, name } = request.params;
		if (name === "list_connections")
			return response(request.id, {
				connections: [
					{
						externalAccount: "328682695",
						providerId: "github",
						status: "ACTIVE",
					},
				],
			});
		if (name === "get_action_guide")
			return response(request.id, {
				action: {
					actionId: args.actionId,
					actionVersionId: `${args.actionId}@v7`,
					effect: "WRITE",
				},
			});
		const action = args.actionId;
		const input = args.input;
		calls.push({ action, input });
		if (action === "github.get_repository" && !exists)
			return Response.json({
				error: { code: -32001, message: "Provider resource was not found" },
				id: request.id,
				jsonrpc: "2.0",
			});
		let result;
		if (action === "github.create_repository") {
			exists = true;
			description = input.description;
			result = repository(input.name, description);
		} else if (action === "github.update_repository") {
			description = input.description;
			result = repository(input.repo, description);
		} else if (action === "github.delete_repository") {
			exists = false;
			result = { acknowledged: true };
		} else
			result = repository(
				input.repo,
				config.foreignDescriptionOnCleanup
					? "connection-e2e:repo-run:updated-foreign"
					: description,
			);
		return response(request.id, {
			action,
			actionVersionId: `${action}@v7`,
			callId: `call-${++id}`,
			result,
			status: "SUCCEEDED",
		});
	};
}

function repository(name, description) {
	return {
		description,
		name,
		owner: { login: "AGORAconnectionE2E" },
		private: true,
	};
}
function response(id, structuredContent) {
	return Response.json({ id, jsonrpc: "2.0", result: { structuredContent } });
}
