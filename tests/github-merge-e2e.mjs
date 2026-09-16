import { pathToFileURL } from "node:url";
import {
	assertRepository,
	assertSingleAccount,
	mcpClient,
} from "./github-review-e2e.mjs";

export const githubMergeActionIds = [
	"github.merge_branch",
	"github.merge_pull_request",
];

export async function runGitHubMergeConformance({ environment, fetch, runId }) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true")
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (typeof runId !== "string" || !runId.trim())
		throw new Error("runId is required");
	const client = mcpClient(fetch, token);
	await assertSingleAccount(client, "328682695");
	for (const actionId of githubMergeActionIds) {
		const guide = await client.call("get_action_guide", { actionId }, true);
		if (
			guide?.action?.actionVersionId !== `${actionId}@v7` ||
			guide.action.effect !== "WRITE"
		)
			throw new Error(`${actionId} has an unapproved ActionVersion`);
	}
	const target = {
		owner: "AgoraConnectionE2EORG",
		repo: "connector-conformance",
	};
	const marker = `connection-e2e:${runId}`;
	const suffix = runId.replace(/[^A-Za-z0-9._-]/g, "-");
	const branches = [
		`connection-e2e-merge-base-${suffix}`,
		`connection-e2e-merge-head-${suffix}`,
		`connection-e2e-pr-base-${suffix}`,
		`connection-e2e-pr-head-${suffix}`,
	];
	const created = [];
	const calls = [];
	let cleanupFailure;
	let expectedPrHeadSha;
	let failure;
	let pullNumber;
	let pullMerged = false;
	const execute = async (actionId, input, retrySafe = false) => {
		const projection = await client.execute(actionId, input, retrySafe);
		if (projection.actionVersionId !== `${actionId}@v7`)
			throw new Error(`${actionId} executed an unapproved ActionVersion`);
		if (githubMergeActionIds.includes(actionId))
			calls.push({
				actionVersionId: projection.actionVersionId,
				callId: projection.callId,
				status: projection.status,
			});
		return projection.result;
	};
	try {
		assertRepository(await execute("github.get_repository", target, true));
		const main = await execute(
			"github.get_branch",
			{ ...target, branch: "main" },
			true,
		);
		const mainSha = main?.commit?.sha;
		if (!mainSha) throw new Error("main branch did not return a commit SHA");
		for (const branch of branches) {
			const existing = await execute(
				"github.list_matching_refs",
				{ ...target, ref: `heads/${branch}` },
				true,
			);
			if (
				(existing?.refs ?? []).some(
					(item) => item.ref === `refs/heads/${branch}`,
				)
			)
				throw new Error("fixture ref already exists");
			created.push(branch);
			await execute("github.create_ref", {
				...target,
				idempotencyKey: `${runId}:${branch}:create`,
				ref: `refs/heads/${branch}`,
				sha: mainSha,
			});
		}
		for (const head of [branches[1], branches[3]]) {
			await execute("github.create_or_update_file", {
				...target,
				branch: head,
				content: `${marker}:${head}\n`,
				idempotencyKey: `${runId}:${head}:file`,
				message: marker,
				path: `fixtures/${head}.txt`,
			});
		}
		const branchHead = await execute(
			"github.get_branch",
			{ ...target, branch: branches[1] },
			true,
		);
		if (!branchHead?.commit?.sha || branchHead.commit.sha === mainSha)
			throw new Error("merge branch head is not run-owned");
		const branchMerge = await execute("github.merge_branch", {
			...target,
			base: branches[0],
			commitMessage: marker,
			head: branches[1],
			idempotencyKey: `${runId}:branch-merge`,
		});
		const branchMergeSha = branchMerge?.sha ?? branchMerge?.commit?.sha;
		if (!branchMergeSha || branchMergeSha === mainSha)
			throw new Error("branch merge did not return a commit SHA");
		const mergedBranch = await execute(
			"github.get_branch",
			{ ...target, branch: branches[0] },
			true,
		);
		if (mergedBranch?.commit?.sha !== branchMergeSha)
			throw new Error("branch merge was not confirmed");
		const prHead = await execute(
			"github.get_branch",
			{ ...target, branch: branches[3] },
			true,
		);
		const prHeadSha = prHead?.commit?.sha;
		if (!prHeadSha || prHeadSha === mainSha)
			throw new Error("pull request head is not run-owned");
		expectedPrHeadSha = prHeadSha;
		const pull = await execute("github.create_pull_request", {
			...target,
			base: branches[2],
			body: marker,
			draft: false,
			head: branches[3],
			idempotencyKey: `${runId}:pull-create`,
			maintainerCanModify: false,
			title: marker,
		});
		if (
			pull?.body !== marker ||
			pull.title !== marker ||
			pull.base?.ref !== branches[2] ||
			pull.head?.ref !== branches[3] ||
			pull.head?.sha !== prHeadSha ||
			!Number.isSafeInteger(pull.number)
		)
			throw new Error("pull request ownership marker does not match");
		pullNumber = pull.number;
		const confirmed = await execute(
			"github.get_pull_request",
			{ ...target, pullNumber: pull.number },
			true,
		);
		if (
			confirmed?.body !== marker ||
			confirmed.title !== marker ||
			confirmed.state !== "open" ||
			confirmed.base?.ref !== branches[2] ||
			confirmed.head?.ref !== branches[3] ||
			confirmed.head?.sha !== prHeadSha
		)
			throw new Error("pull request ownership marker does not match");
		const merged = await execute("github.merge_pull_request", {
			...target,
			commitMessage: marker,
			commitTitle: marker,
			idempotencyKey: `${runId}:pull-merge`,
			mergeMethod: "squash",
			pullNumber: pull.number,
			sha: prHeadSha,
		});
		if (merged?.merged !== true || !merged.sha)
			throw new Error("pull request merge did not succeed");
		pullMerged = true;
		const mergedCheck = await execute(
			"github.check_pull_request_merged",
			{ ...target, pullNumber: pull.number },
			true,
		);
		if (mergedCheck?.merged !== true)
			throw new Error("pull request merge was not confirmed");
	} catch (error) {
		failure = error;
	} finally {
		const cleanupFailures = [];
		if (failure && pullNumber && !pullMerged) {
			try {
				const current = await execute(
					"github.get_pull_request",
					{ ...target, pullNumber },
					true,
				);
				if (
					current?.state === "open" &&
					current.body === marker &&
					current.title === marker &&
					current.base?.ref === branches[2] &&
					current.head?.ref === branches[3] &&
					current.head?.sha === expectedPrHeadSha
				)
					await execute("github.update_pull_request", {
						...target,
						idempotencyKey: `${runId}:pull-close`,
						pullNumber,
						state: "closed",
					});
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		for (const branch of [...created].reverse()) {
			try {
				await execute("github.delete_ref", {
					...target,
					idempotencyKey: `${runId}:${branch}:delete`,
					ref: `heads/${branch}`,
				});
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (cleanupFailures.length)
			cleanupFailure = new Error(
				`${failure instanceof Error ? `${failure.message}; ` : ""}cleanup failed`,
			);
	}
	if (cleanupFailure) throw cleanupFailure;
	if (failure) throw failure;
	return {
		actionVersionIds: githubMergeActionIds.map((id) => `${id}@v7`),
		calls,
		cleanup: "SUCCEEDED",
		runId,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const runId = process.argv[2];
	runGitHubMergeConformance({ environment: process.env, fetch, runId })
		.then((evidence) =>
			process.stdout.write(
				`${JSON.stringify({ ...evidence, outcome: "SUCCEEDED", suite: "merge" })}\n`,
			),
		)
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify({ error: error instanceof Error ? error.message : "Merge conformance failed", outcome: "FAILED", runId, suite: "merge" })}\n`,
			);
			process.exitCode = 1;
		});
}
