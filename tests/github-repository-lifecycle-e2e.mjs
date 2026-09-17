import { pathToFileURL } from "node:url";
import { assertSingleAccount, mcpClient } from "./github-review-e2e.mjs";

export const githubRepositoryLifecycleActionIds = [
	"github.create_repository",
	"github.update_repository",
	"github.add_repository_collaborator",
	"github.fork_repository",
	"github.sync_fork_branch_with_upstream",
	"github.dispatch_workflow",
	"github.cancel_workflow_run",
	"github.rerun_failed_jobs",
	"github.rerun_workflow",
	"github.disable_workflow",
	"github.enable_workflow",
	"github.remove_repository_collaborator",
	"github.delete_repository",
];

export async function runGitHubRepositoryLifecycle({
	environment,
	fetch,
	runId,
	sleep = (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true")
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (typeof runId !== "string" || !runId.trim())
		throw new Error("runId is required");
	const client = mcpClient(fetch, token);
	await assertSingleAccount(client, "328682695");
	for (const actionId of githubRepositoryLifecycleActionIds) {
		const guide = await client.call("get_action_guide", { actionId }, true);
		if (
			guide?.action?.actionVersionId !== `${actionId}@v7` ||
			guide.action.effect !== "WRITE"
		)
			throw new Error(`${actionId} has an unapproved ActionVersion`);
	}
	const owner = "AGORAconnectionE2E";
	const forkOwner = "AgoraConnectionE2EORG";
	const name =
		`connection-e2e-${runId.replace(/[^A-Za-z0-9-]/g, "-").toLowerCase()}`.slice(
			0,
			90,
		);
	const marker = `connection-e2e:${runId}`;
	let creationStarted = false;
	let owned = false;
	let collaboratorMutationStarted = false;
	let forkCreationStarted = false;
	let forkOwned = false;
	let forkDeleted = false;
	let deleted = false;
	let failure;
	const cleanupFailures = [];
	const recordCleanupFailure = (error) =>
		cleanupFailures.push(
			error instanceof Error ? error : new Error("unknown cleanup failure"),
		);
	const calls = [];
	const execute = async (actionId, input, retrySafe = false) => {
		const projection = await client.execute(actionId, input, retrySafe);
		if (projection.actionVersionId !== `${actionId}@v7`)
			throw new Error(`${actionId} executed an unapproved ActionVersion`);
		if (githubRepositoryLifecycleActionIds.includes(actionId))
			calls.push({
				actionVersionId: projection.actionVersionId,
				callId: projection.callId,
				status: projection.status,
			});
		return projection.result;
	};
	const poll = async (actionId, input, predicate, message) => {
		for (let attempt = 0; attempt < 15; attempt += 1) {
			try {
				const result = await execute(actionId, input, true);
				if (predicate(result)) return result;
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("Provider resource was not found")
				)
					throw error;
			}
			if (attempt < 14) await sleep(2_000);
		}
		throw new Error(message);
	};
	const findDispatchedRun = async (workflowId, created) =>
		poll(
			"github.list_workflow_runs",
			{
				branch: "main",
				created: `>=${created}`,
				event: "workflow_dispatch",
				owner,
				perPage: 20,
				repo: name,
			},
			(result) => {
				const matches = result?.workflow_runs?.filter(
					(run) =>
						run.workflow_id === workflowId &&
						run.event === "workflow_dispatch" &&
						run.head_branch === "main",
				);
				if (matches?.length > 1)
					throw new Error("workflow run discovery was ambiguous");
				return matches?.length === 1;
			},
			"workflow run was not discovered",
		).then((result) =>
			result.workflow_runs.find(
				(run) =>
					run.workflow_id === workflowId &&
					run.event === "workflow_dispatch" &&
					run.head_branch === "main",
			),
		);
	const waitForRerun = async (runId) => {
		await poll(
			"github.get_workflow_run",
			{ owner, repo: name, runId },
			(run) => run?.status !== "completed",
			"workflow rerun did not start",
		);
		await poll(
			"github.get_workflow_run",
			{ owner, repo: name, runId },
			(run) => run?.status === "completed" && run.conclusion === "failure",
			"workflow rerun did not fail as expected",
		);
	};
	try {
		const collaboratorTarget = await execute(
			"github.get_user",
			{ username: "connectionE2E2" },
			true,
		);
		if (
			String(collaboratorTarget?.id) !== "329435106" ||
			collaboratorTarget.login !== "connectionE2E2"
		)
			throw new Error("collaborator GitHub identity does not match");
		try {
			await execute("github.get_repository", { owner, repo: name }, true);
			throw new Error("fixture repository already exists");
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("Provider resource was not found")
			)
				throw error;
		}
		try {
			await execute(
				"github.get_repository",
				{ owner: forkOwner, repo: name },
				true,
			);
			throw new Error("fixture fork already exists");
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!error.message.includes("Provider resource was not found")
			)
				throw error;
		}
		creationStarted = true;
		const created = await execute("github.create_repository", {
			autoInit: true,
			description: marker,
			hasDiscussions: false,
			hasIssues: true,
			hasProjects: false,
			hasWiki: false,
			idempotencyKey: `${runId}:repository-create`,
			name,
			private: true,
		});
		if (
			created?.name !== name ||
			created.owner?.login !== owner ||
			created.private !== true ||
			created.description !== marker
		)
			throw new Error("repository ownership marker does not match");
		owned = true;
		const updatedMarker = `${marker}:updated`;
		const updated = await execute("github.update_repository", {
			description: updatedMarker,
			hasDiscussions: false,
			hasIssues: true,
			hasProjects: false,
			hasWiki: false,
			idempotencyKey: `${runId}:repository-update`,
			name,
			owner,
			private: true,
			repo: name,
			visibility: "private",
		});
		if (
			updated?.name !== name ||
			updated.owner?.login !== owner ||
			updated.private !== true ||
			updated.description !== updatedMarker
		)
			throw new Error("repository update did not match");
		collaboratorMutationStarted = true;
		const collaborator = await execute("github.add_repository_collaborator", {
			idempotencyKey: `${runId}:repository-collaborator-add`,
			owner,
			permission: "pull",
			repo: name,
			username: "connectionE2E2",
		});
		if (
			collaborator?.invited !== true ||
			collaborator.invitation?.invitee?.login !== "connectionE2E2"
		)
			throw new Error("repository collaborator invitation did not match");
		forkCreationStarted = true;
		const fork = await execute("github.fork_repository", {
			defaultBranchOnly: true,
			idempotencyKey: `${runId}:repository-fork`,
			name,
			organization: forkOwner,
			owner,
			repo: name,
		});
		if (
			fork?.name !== name ||
			fork.owner?.login !== forkOwner ||
			String(fork.owner?.id) !== "329053903" ||
			fork.private !== true ||
			fork.fork !== true ||
			fork.description !== `${marker}:updated` ||
			fork.parent?.full_name !== `${owner}/${name}`
		)
			throw new Error("fork ownership marker does not match");
		forkOwned = true;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			try {
				const branch = await execute(
					"github.get_branch",
					{ branch: "main", owner: forkOwner, repo: name },
					true,
				);
				if (branch?.name !== "main")
					throw new Error("fork default branch did not match");
				break;
			} catch (error) {
				if (
					attempt === 5 ||
					!(error instanceof Error) ||
					!error.message.includes("Provider resource was not found")
				)
					throw error;
				await sleep(2_000);
			}
		}
		await execute("github.create_or_update_file", {
			branch: "main",
			contentBase64: Buffer.from(marker).toString("base64"),
			idempotencyKey: `${runId}:repository-fork-source-update`,
			message: marker,
			owner,
			path: "connection-e2e-sync-marker.txt",
			repo: name,
		});
		const sync = await execute("github.sync_fork_branch_with_upstream", {
			branch: "main",
			idempotencyKey: `${runId}:repository-fork-sync`,
			owner: forkOwner,
			repo: name,
		});
		if (sync?.base_branch !== "main")
			throw new Error("fork synchronization did not match");
		const workflows = [
			{
				file: "connection-e2e-cancel.yml",
				name: "Connection E2E Cancel",
				run: "sleep 300",
			},
			{
				file: "connection-e2e-failure.yml",
				name: "Connection E2E Failure",
				run: "exit 1",
			},
		];
		for (const workflow of workflows)
			await execute("github.create_or_update_file", {
				branch: "main",
				contentBase64: Buffer.from(
					`name: ${workflow.name}\non:\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${workflow.run}\n`,
				).toString("base64"),
				idempotencyKey: `${runId}:workflow:${workflow.file}`,
				message: marker,
				owner,
				path: `.github/workflows/${workflow.file}`,
				repo: name,
			});
		const cancelWorkflow = await poll(
			"github.get_workflow",
			{ owner, repo: name, workflowId: workflows[0].file },
			(workflow) => workflow?.state === "active",
			"cancel workflow was not indexed",
		);
		const cancelDispatchStarted = new Date().toISOString();
		const cancelDispatch = await execute("github.dispatch_workflow", {
			idempotencyKey: `${runId}:workflow:cancel:dispatch`,
			inputs: {},
			owner,
			ref: "main",
			repo: name,
			workflowId: workflows[0].file,
		});
		if (cancelDispatch?.dispatched !== true)
			throw new Error("cancel workflow dispatch did not match");
		const cancelRun = await findDispatchedRun(
			cancelWorkflow.id,
			cancelDispatchStarted,
		);
		const cancelled = await execute("github.cancel_workflow_run", {
			idempotencyKey: `${runId}:workflow:cancel`,
			owner,
			repo: name,
			runId: cancelRun.id,
		});
		if (cancelled?.cancel_requested !== true)
			throw new Error("workflow cancellation did not match");
		await poll(
			"github.get_workflow_run",
			{ owner, repo: name, runId: cancelRun.id },
			(run) => run?.status === "completed" && run.conclusion === "cancelled",
			"workflow cancellation did not complete",
		);
		const failureWorkflow = await poll(
			"github.get_workflow",
			{ owner, repo: name, workflowId: workflows[1].file },
			(workflow) => workflow?.state === "active",
			"failure workflow was not indexed",
		);
		const failureDispatchStarted = new Date().toISOString();
		const failureDispatch = await execute("github.dispatch_workflow", {
			idempotencyKey: `${runId}:workflow:failure:dispatch`,
			inputs: {},
			owner,
			ref: "main",
			repo: name,
			workflowId: workflows[1].file,
		});
		if (failureDispatch?.dispatched !== true)
			throw new Error("failure workflow dispatch did not match");
		const failureRun = await findDispatchedRun(
			failureWorkflow.id,
			failureDispatchStarted,
		);
		await poll(
			"github.get_workflow_run",
			{ owner, repo: name, runId: failureRun.id },
			(run) => run?.status === "completed" && run.conclusion === "failure",
			"failure workflow did not fail as expected",
		);
		const failedJobs = await execute("github.rerun_failed_jobs", {
			enableDebugLogging: false,
			idempotencyKey: `${runId}:workflow:rerun-failed`,
			owner,
			repo: name,
			runId: failureRun.id,
		});
		if (failedJobs?.rerun_requested !== true)
			throw new Error("failed-job rerun did not match");
		await waitForRerun(failureRun.id);
		const rerun = await execute("github.rerun_workflow", {
			enableDebugLogging: false,
			idempotencyKey: `${runId}:workflow:rerun`,
			owner,
			repo: name,
			runId: failureRun.id,
		});
		if (rerun?.rerun_requested !== true)
			throw new Error("workflow rerun did not match");
		await waitForRerun(failureRun.id);
		await execute("github.disable_workflow", {
			idempotencyKey: `${runId}:workflow:disable`,
			owner,
			repo: name,
			workflowId: workflows[1].file,
		});
		await poll(
			"github.get_workflow",
			{ owner, repo: name, workflowId: workflows[1].file },
			(workflow) => workflow?.state === "disabled_manually",
			"workflow was not disabled",
		);
		await execute("github.enable_workflow", {
			idempotencyKey: `${runId}:workflow:enable`,
			owner,
			repo: name,
			workflowId: workflows[1].file,
		});
		await poll(
			"github.get_workflow",
			{ owner, repo: name, workflowId: workflows[1].file },
			(workflow) => workflow?.state === "active",
			"workflow was not enabled",
		);
	} catch (error) {
		failure = error;
	} finally {
		if (forkCreationStarted && !forkOwned) {
			try {
				const current = await execute(
					"github.get_repository",
					{ owner: forkOwner, repo: name },
					true,
				);
				if (
					current?.name === name &&
					current.owner?.login === forkOwner &&
					String(current.owner?.id) === "329053903" &&
					current.private === true &&
					current.fork === true &&
					current.description === `${marker}:updated` &&
					current.parent?.full_name === `${owner}/${name}`
				)
					forkOwned = true;
				else
					recordCleanupFailure(
						new Error("fork cleanup ownership marker does not match"),
					);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("Provider resource was not found")
				)
					recordCleanupFailure(error);
			}
		}
		if (forkOwned) {
			try {
				const current = await execute(
					"github.get_repository",
					{ owner: forkOwner, repo: name },
					true,
				);
				if (
					current?.name !== name ||
					current.owner?.login !== forkOwner ||
					String(current.owner?.id) !== "329053903" ||
					current.private !== true ||
					current.fork !== true ||
					current.description !== `${marker}:updated` ||
					current.parent?.full_name !== `${owner}/${name}`
				)
					recordCleanupFailure(
						new Error("fork delete ownership marker does not match"),
					);
				else {
					await execute("github.delete_repository", {
						idempotencyKey: `${runId}:repository-fork-delete`,
						owner: forkOwner,
						repo: name,
					});
					forkDeleted = true;
				}
				if (forkDeleted)
					try {
						await execute(
							"github.get_repository",
							{ owner: forkOwner, repo: name },
							true,
						);
						recordCleanupFailure(new Error("fork remained after deletion"));
					} catch (error) {
						if (
							!(error instanceof Error) ||
							!error.message.includes("Provider resource was not found")
						)
							recordCleanupFailure(error);
					}
			} catch (error) {
				recordCleanupFailure(error);
			}
		}
		if (creationStarted && !owned) {
			try {
				const current = await execute(
					"github.get_repository",
					{ owner, repo: name },
					true,
				);
				if (
					current?.name === name &&
					current.owner?.login === owner &&
					current.private === true &&
					current.description === marker
				)
					owned = true;
				else
					recordCleanupFailure(
						new Error("repository cleanup ownership marker does not match"),
					);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!error.message.includes("Provider resource was not found")
				)
					recordCleanupFailure(error);
			}
		}
		if (owned) {
			try {
				const current = await execute(
					"github.get_repository",
					{ owner, repo: name },
					true,
				);
				if (
					current?.name !== name ||
					current.owner?.login !== owner ||
					current.private !== true ||
					![marker, `${marker}:updated`].includes(current.description)
				) {
					recordCleanupFailure(
						new Error("repository delete ownership marker does not match"),
					);
				} else {
					if (collaboratorMutationStarted)
						try {
							await execute("github.remove_repository_collaborator", {
								idempotencyKey: `${runId}:repository-collaborator-remove`,
								owner,
								repo: name,
								username: "connectionE2E2",
							});
						} catch (error) {
							recordCleanupFailure(error);
						}
					await execute("github.delete_repository", {
						idempotencyKey: `${runId}:repository-delete`,
						owner,
						repo: name,
					});
					deleted = true;
				}
				if (deleted) {
					try {
						await execute("github.get_repository", { owner, repo: name }, true);
						recordCleanupFailure(
							new Error("repository remained after deletion"),
						);
					} catch (error) {
						if (
							!(error instanceof Error) ||
							!error.message.includes("Provider resource was not found")
						)
							recordCleanupFailure(error);
					}
				}
			} catch (error) {
				recordCleanupFailure(error);
			}
		}
	}
	if (cleanupFailures.length > 0)
		throw new Error(
			`${failure instanceof Error ? `${failure.message}; ` : ""}cleanup failed: ${cleanupFailures.map(({ message }) => message).join("; ")}`,
		);
	if (failure) throw failure;
	return {
		actionVersionIds: githubRepositoryLifecycleActionIds.map(
			(id) => `${id}@v7`,
		),
		calls,
		cleanup: "SUCCEEDED",
		repository: `${owner}/${name}`,
		runId,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const runId = process.argv[2];
	runGitHubRepositoryLifecycle({ environment: process.env, fetch, runId })
		.then((evidence) =>
			process.stdout.write(
				`${JSON.stringify({ ...evidence, outcome: "SUCCEEDED", suite: "repository-lifecycle" })}\n`,
			),
		)
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify({ error: error instanceof Error ? error.message : "Repository lifecycle failed", outcome: "FAILED", runId, suite: "repository-lifecycle" })}\n`,
			);
			process.exitCode = 1;
		});
}
