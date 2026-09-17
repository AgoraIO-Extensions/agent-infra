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

test("repository lifecycle creates, updates, removes its collaborator, and deletes one private test repository", async () => {
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
		"github.add_repository_collaborator@v7",
		"github.fork_repository@v7",
		"github.sync_fork_branch_with_upstream@v7",
		"github.remove_repository_collaborator@v7",
		"github.delete_repository@v7",
	]);
	assert.equal(evidence.cleanup, "SUCCEEDED");
	const collaboratorPreflight = calls.findIndex(
		({ action }) => action === "github.get_user",
	);
	assert.ok(collaboratorPreflight >= 0);
	assert.ok(
		collaboratorPreflight <
			calls.findIndex(({ action }) => action === "github.create_repository"),
	);
	assert.equal(
		calls.filter(
			({ action }) => action === "github.add_repository_collaborator",
		).length,
		1,
	);
	assert.equal(
		calls.find(({ action }) => action === "github.add_repository_collaborator")
			?.input.permission,
		"pull",
	);
	assert.equal(
		calls.filter(
			({ action }) => action === "github.remove_repository_collaborator",
		).length,
		1,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_repository").length,
		2,
	);
	const deletes = calls.filter(
		({ action }) => action === "github.delete_repository",
	);
	assert.equal(deletes[0].input.owner, "AgoraConnectionE2EORG");
	assert.equal(deletes[1].input.owner, "AGORAconnectionE2E");
});

test("repository lifecycle waits a bounded number of times for the fork branch", async () => {
	const calls = [];
	let waits = 0;
	const evidence = await runGitHubRepositoryLifecycle({
		environment: {
			CONNECTION_E2E_TOKEN: "token",
			CONNECTION_GITHUB_E2E_ENABLED: "true",
		},
		fetch: lifecycleFetch(calls, { branchUnavailableAttempts: 2 }),
		runId: "repo-run",
		sleep: async () => {
			waits += 1;
		},
	});
	assert.equal(evidence.cleanup, "SUCCEEDED");
	assert.equal(
		calls.filter(({ action }) => action === "github.get_branch").length,
		3,
	);
	assert.equal(waits, 2);
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
		calls.filter(
			({ action, input }) =>
				action === "github.delete_repository" &&
				input.owner === "AGORAconnectionE2E",
		).length,
		0,
	);
});

test("repository lifecycle refuses to delete a fork with a foreign marker", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { foreignForkDescriptionOnCleanup: true }),
			runId: "repo-run",
		}),
		/fork delete ownership marker does not match/,
	);
	assert.equal(
		calls.filter(
			({ action, input }) =>
				action === "github.delete_repository" &&
				input.owner === "AgoraConnectionE2EORG",
		).length,
		0,
	);
});

test("repository lifecycle removes the collaborator and repository after an invitation mismatch", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { inviteeLogin: "unexpected-user" }),
			runId: "repo-run",
		}),
		/repository collaborator invitation did not match/,
	);
	const actions = calls.map(({ action }) => action);
	assert.ok(
		actions.indexOf("github.add_repository_collaborator") <
			actions.indexOf("github.remove_repository_collaborator"),
	);
	assert.ok(
		actions.indexOf("github.remove_repository_collaborator") <
			actions.indexOf("github.delete_repository"),
	);
});

test("repository lifecycle confirms repository deletion after collaborator cleanup fails", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { failCollaboratorRemoval: true }),
			runId: "repo-run",
		}),
		/cleanup failed: .*remove_repository_collaborator/,
	);
	assert.equal(
		calls.filter(
			({ action, input }) =>
				action === "github.get_repository" &&
				input.owner === "AGORAconnectionE2E",
		).length,
		3,
	);
});

test("repository lifecycle reports collaborator and repository cleanup failures", async () => {
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch([], {
				failCollaboratorRemoval: true,
				failRepositoryDeletion: true,
			}),
			runId: "repo-run",
		}),
		(error) =>
			error.message.includes("remove_repository_collaborator") &&
			error.message.includes("delete_repository"),
	);
});

function lifecycleFetch(calls, config = {}) {
	let exists = false;
	let forkExists = false;
	let description = "";
	let id = 0;
	let branchAttempts = 0;
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
		if (
			action === "github.get_repository" &&
			(input.owner === "AgoraConnectionE2EORG" ? !forkExists : !exists)
		)
			return Response.json({
				error: { code: -32001, message: "Provider resource was not found" },
				id: request.id,
				jsonrpc: "2.0",
			});
		if (action === "github.get_user")
			return response(request.id, {
				action,
				actionVersionId: `${action}@v7`,
				callId: `call-${++id}`,
				result: { id: 329435106, login: "connectionE2E2" },
				status: "SUCCEEDED",
			});
		if (
			action === "github.get_branch" &&
			branchAttempts++ < (config.branchUnavailableAttempts ?? 0)
		)
			return Response.json({
				error: { code: -32001, message: "Provider resource was not found" },
				id: request.id,
				jsonrpc: "2.0",
			});
		if (
			action === "github.remove_repository_collaborator" &&
			config.failCollaboratorRemoval
		)
			return Response.json({
				error: { code: -32001, message: "collaborator removal failed" },
				id: request.id,
				jsonrpc: "2.0",
			});
		if (action === "github.delete_repository" && config.failRepositoryDeletion)
			return Response.json({
				error: { code: -32001, message: "repository deletion failed" },
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
		} else if (action === "github.add_repository_collaborator") {
			result = {
				invitation: {
					invitee: { login: config.inviteeLogin ?? "connectionE2E2" },
				},
				invited: true,
			};
		} else if (action === "github.remove_repository_collaborator") {
			result = { acknowledged: true };
		} else if (action === "github.fork_repository") {
			forkExists = true;
			result = forkRepository(input.name, description);
		} else if (action === "github.create_or_update_file") {
			result = {
				commit: { sha: "source-update" },
				content: { path: input.path },
			};
		} else if (action === "github.sync_fork_branch_with_upstream") {
			result = {
				base_branch: "main",
				merge_type: "fast-forward",
				message: "Successfully synced with upstream",
			};
		} else if (action === "github.get_branch") {
			result = { name: "main" };
		} else if (action === "github.delete_repository") {
			if (input.owner === "AgoraConnectionE2EORG") forkExists = false;
			else exists = false;
			result = { acknowledged: true };
		} else if (input.owner === "AgoraConnectionE2EORG")
			result = forkRepository(
				input.repo,
				config.foreignForkDescriptionOnCleanup
					? "connection-e2e:repo-run:updated-foreign"
					: description,
			);
		else
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

function forkRepository(name, description) {
	return {
		description,
		fork: true,
		name,
		owner: { id: 329053903, login: "AgoraConnectionE2EORG" },
		parent: { full_name: `AGORAconnectionE2E/${name}` },
		private: true,
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
