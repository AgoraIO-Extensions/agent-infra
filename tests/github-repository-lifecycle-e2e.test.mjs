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
		"github.create_repository@v8",
		"github.update_repository@v8",
		"github.add_repository_collaborator@v8",
		"github.fork_repository@v8",
		"github.sync_fork_branch_with_upstream@v8",
		"github.dispatch_workflow@v8",
		"github.cancel_workflow_run@v8",
		"github.rerun_failed_jobs@v8",
		"github.rerun_workflow@v8",
		"github.disable_workflow@v8",
		"github.enable_workflow@v8",
		"github.delete_release_asset@v8",
		"github.remove_repository_collaborator@v8",
		"github.delete_repository@v8",
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
	const workflowActions = calls.filter(({ action }) =>
		[
			"github.dispatch_workflow",
			"github.cancel_workflow_run",
			"github.rerun_failed_jobs",
			"github.rerun_workflow",
			"github.disable_workflow",
			"github.enable_workflow",
		].includes(action),
	);
	assert.deepEqual(
		workflowActions.map(({ action }) => action),
		[
			"github.dispatch_workflow",
			"github.cancel_workflow_run",
			"github.dispatch_workflow",
			"github.rerun_failed_jobs",
			"github.rerun_workflow",
			"github.disable_workflow",
			"github.enable_workflow",
			"github.dispatch_workflow",
		],
	);
	assert.ok(
		workflowActions.every(
			({ input }) =>
				input.owner === "AGORAconnectionE2E" &&
				input.repo === "connection-e2e-repo-run",
		),
	);
	assert.equal(workflowActions[1].input.runId, 801);
	assert.equal(workflowActions[3].input.runId, 802);
	assert.equal(workflowActions[4].input.runId, 802);
	const assetDelete = calls.find(
		({ action }) => action === "github.delete_release_asset",
	);
	assert.deepEqual(assetDelete.input, {
		assetId: 902,
		idempotencyKey: "repo-run:release-asset-delete",
		owner: "AGORAconnectionE2E",
		repo: "connection-e2e-repo-run",
	});
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

test("repository lifecycle fails closed on ambiguous workflow run discovery and cleans repositories", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { ambiguousWorkflowRuns: true }),
			runId: "repo-run",
			sleep: async () => {},
		}),
		/workflow run discovery was ambiguous/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_repository").length,
		2,
	);
});

test("repository lifecycle refuses ambiguous release assets and cleans repositories", async () => {
	const calls = [];
	await assert.rejects(
		runGitHubRepositoryLifecycle({
			environment: {
				CONNECTION_E2E_TOKEN: "token",
				CONNECTION_GITHUB_E2E_ENABLED: "true",
			},
			fetch: lifecycleFetch(calls, { ambiguousReleaseAssets: true }),
			runId: "repo-run",
		}),
		/release asset fixture did not match/,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_release_asset")
			.length,
		0,
	);
	assert.equal(
		calls.filter(({ action }) => action === "github.delete_repository").length,
		2,
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
	const workflowIds = {
		"connection-e2e-cancel.yml": 701,
		"connection-e2e-failure.yml": 702,
		"connection-e2e-asset.yml": 703,
	};
	const workflowStates = new Map(
		Object.entries(workflowIds).map(([file, workflowId]) => [
			file,
			{ id: workflowId, name: file, state: "active" },
		]),
	);
	const workflowRuns = new Map();
	let lastDispatchedWorkflow;
	let releaseExists = false;
	let assetExists = false;
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
					actionVersionId: `${args.actionId}@v8`,
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
		if (action === "github.get_release_asset" && !assetExists)
			return Response.json({
				error: { code: -32001, message: "Provider resource was not found" },
				id: request.id,
				jsonrpc: "2.0",
			});
		if (action === "github.get_user")
			return response(request.id, {
				action,
				actionVersionId: `${action}@v8`,
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
				base_branch: "AGORAconnectionE2E:main",
				merge_type: "fast-forward",
				message: "Successfully synced with upstream",
			};
		} else if (action === "github.get_branch") {
			result = { name: "main" };
		} else if (action === "github.get_workflow") {
			result = workflowStates.get(input.workflowId);
		} else if (action === "github.dispatch_workflow") {
			const workflowId = workflowIds[input.workflowId];
			lastDispatchedWorkflow = workflowId;
			if (workflowId === workflowIds["connection-e2e-asset.yml"]) {
				releaseExists = true;
				assetExists = true;
			}
			workflowRuns.set(workflowId + 100, {
				conclusion:
					workflowId === workflowIds["connection-e2e-cancel.yml"]
						? null
						: workflowId === workflowIds["connection-e2e-asset.yml"]
							? "success"
							: "failure",
				event: "workflow_dispatch",
				head_branch: "main",
				id: workflowId + 100,
				status:
					workflowId === workflowIds["connection-e2e-cancel.yml"]
						? "in_progress"
						: "completed",
				workflow_id: workflowId,
			});
			result = { dispatched: true };
		} else if (action === "github.list_workflow_runs") {
			const run = workflowRuns.get(lastDispatchedWorkflow + 100);
			result = {
				total_count: config.ambiguousWorkflowRuns ? 2 : 1,
				workflow_runs: config.ambiguousWorkflowRuns
					? [run, { ...run, id: run.id + 1 }]
					: [run],
			};
		} else if (action === "github.cancel_workflow_run") {
			const run = workflowRuns.get(input.runId);
			Object.assign(run, { conclusion: "cancelled", status: "completed" });
			result = { cancel_requested: true };
		} else if (
			action === "github.rerun_failed_jobs" ||
			action === "github.rerun_workflow"
		) {
			workflowRuns.get(input.runId).rerunPhase = 1;
			result = { rerun_requested: true };
		} else if (action === "github.get_workflow_run") {
			const run = workflowRuns.get(input.runId);
			if (run.rerunPhase === 1) {
				run.rerunPhase = 2;
				result = { ...run, conclusion: null, status: "queued" };
			} else if (run.rerunPhase === 2) {
				run.rerunPhase = 0;
				Object.assign(run, { conclusion: "failure", status: "completed" });
				result = run;
			} else result = run;
		} else if (action === "github.disable_workflow") {
			workflowStates.get(input.workflowId).state = "disabled_manually";
			result = { acknowledged: true };
		} else if (action === "github.enable_workflow") {
			workflowStates.get(input.workflowId).state = "active";
			result = { acknowledged: true };
		} else if (action === "github.list_releases") {
			result = {
				releases: releaseExists
					? [
							{
								id: 901,
								name: "connection-e2e-repo-run-asset",
								tag_name: "connection-e2e-repo-run-asset",
							},
						]
					: [],
			};
		} else if (action === "github.list_release_assets") {
			const asset = {
				id: 902,
				name: "connection-e2e-repo-run-asset.txt",
			};
			result = {
				assets: assetExists
					? config.ambiguousReleaseAssets
						? [asset, { ...asset, id: 903 }]
						: [asset]
					: [],
			};
		} else if (action === "github.delete_release_asset") {
			assetExists = false;
			result = { acknowledged: true };
		} else if (action === "github.get_release_asset") {
			result = { id: 902, name: "connection-e2e-repo-run-asset.txt" };
		} else if (action === "github.delete_release") {
			releaseExists = false;
			result = { acknowledged: true };
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
			actionVersionId: `${action}@v8`,
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
