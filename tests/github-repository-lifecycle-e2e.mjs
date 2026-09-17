import { pathToFileURL } from "node:url";
import { assertSingleAccount, mcpClient } from "./github-review-e2e.mjs";

export const githubRepositoryLifecycleActionIds = [
	"github.create_repository",
	"github.update_repository",
	"github.add_repository_collaborator",
	"github.fork_repository",
	"github.sync_fork_branch_with_upstream",
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
