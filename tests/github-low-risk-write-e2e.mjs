import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const endpoint = "https://agent-connector.gz3.agoralab.co/mcp";
const repository = {
	owner: "AgoraConnectionE2EORG",
	repo: "connector-conformance",
};
const target = {
	externalAccount: "328682695",
	organizationId: "329053903",
	repositoryId: "1369705971",
};
const initialCommit = "7c63d061e74eaccb99dcccdc9b633511197c3406";
const mainCommit = "410b111ccf673ab03ecb7239391442e226ad48fd";
const writeActions = [
	"create_ref",
	"update_ref",
	"rename_branch",
	"delete_ref",
	"create_label",
	"update_label",
	"delete_label",
	"add_issue_labels",
	"set_issue_labels",
	"remove_issue_label",
	"clear_issue_labels",
	"add_issue_assignees",
	"remove_issue_assignees",
	"lock_issue",
	"unlock_issue",
	"create_or_update_file",
	"delete_file",
	"replace_repository_topics",
	"star_repository",
	"unstar_repository",
	"create_milestone",
	"update_milestone",
	"delete_milestone",
	"generate_release_notes",
	"create_release",
	"update_release",
	"delete_release",
];

export async function runGitHubLowRiskWriteConformance({
	environment,
	fetch,
	runId,
}) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true")
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (!/^[A-Za-z0-9._-]+$/.test(runId ?? ""))
		throw new Error("runId is invalid");
	let requestId = 0;
	const call = async (name, args) => {
		requestId += 1;
		const response = await fetch(endpoint, {
			body: JSON.stringify({
				id: requestId,
				jsonrpc: "2.0",
				method: "tools/call",
				params: { arguments: args, name },
			}),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok)
			throw new Error(`Connection returned HTTP ${response.status}`);
		const payload = await response.json();
		if (payload.error)
			throw new McpError(payload.error.code, payload.error.data);
		return payload.result?.structuredContent;
	};
	const connections = await call("list_connections", { service: "github" });
	const active = connections?.connections?.filter(
		(item) => item.providerId === "github" && item.status === "ACTIVE",
	);
	if (
		active?.length !== 1 ||
		active[0]?.externalAccount !== target.externalAccount
	)
		throw new Error("approved GitHub account does not match");
	const preflight = await call("execute_action", {
		actionId: "github.get_repository",
		input: repository,
	});
	if (
		preflight?.status !== "SUCCEEDED" ||
		preflight.result?.id !== Number(target.repositoryId) ||
		preflight.result?.owner?.id !== Number(target.organizationId)
	)
		throw new Error("repository boundary does not match");
	for (const name of writeActions) {
		const actionId = `github.${name}`;
		const guide = await call("get_action_guide", { actionId });
		if (
			guide?.action?.actionVersionId !== `${actionId}@v8` ||
			guide.action.effect !== "WRITE"
		)
			throw new Error(`${actionId} contract does not match`);
	}
	const marker = `connection-e2e:${runId}`;
	const branch = `connection-e2e-${runId}`.toLowerCase();
	const renamedBranch = `${branch}-renamed`;
	const label = marker;
	const renamedLabel = `${marker}-updated`;
	const calls = [];
	let uncertain = false;
	const execute = async (actionId, input, step, record = true) => {
		const args = { ...input, idempotencyKey: `${runId}:${step}` };
		let result;
		try {
			result = await call("execute_action", { actionId, input: args });
		} catch (error) {
			uncertain = true;
			throw error;
		}
		if (result?.status !== "SUCCEEDED" || !result.callId) {
			uncertain = true;
			throw new Error(`${actionId} did not succeed`);
		}
		if (record)
			calls.push({
				actionVersionId: `${actionId}@v8`,
				callId: result.callId,
				inputHash: hash(args),
				status: result.status,
				target,
			});
		return result.result;
	};
	let currentRef;
	let currentLabel;
	let issueLabelsChanged = false;
	let issueAssigneesChanged = false;
	let issueLocked = false;
	let originalIssueLabels = [];
	let originalAssignees = [];
	const issueNumber = 1;
	let fileSha;
	let milestoneNumber;
	let releaseId;
	let releaseTag;
	let originalTopics;
	let originalStar;
	let topicsChanged = false;
	let starChanged = false;
	const filePath = `connection-e2e/${runId}.txt`;
	let cleanup = "SUCCEEDED";
	try {
		await execute(
			"github.create_ref",
			{ ...repository, ref: `refs/heads/${branch}`, sha: initialCommit },
			"ref-create",
		);
		currentRef = `heads/${branch}`;
		await execute(
			"github.update_ref",
			{ ...repository, ref: currentRef, sha: mainCommit },
			"ref-update",
		);
		const renamed = await execute(
			"github.rename_branch",
			{ ...repository, branch, newName: renamedBranch },
			"ref-rename",
		);
		if (renamed?.name !== renamedBranch)
			throw new Error("renamed branch does not match");
		currentRef = `heads/${renamedBranch}`;
		await execute(
			"github.delete_ref",
			{ ...repository, ref: currentRef },
			"ref-delete",
		);
		currentRef = undefined;
		await expect404(call, "github.get_ref", {
			...repository,
			ref: `heads/${renamedBranch}`,
		});

		const created = await execute(
			"github.create_label",
			{
				...repository,
				color: "1f883d",
				description: `${marker} label`,
				name: label,
			},
			"label-create",
		);
		currentLabel = label;
		if (created?.name !== label)
			throw new Error("created label does not match");
		const updated = await execute(
			"github.update_label",
			{ ...repository, color: "0969da", name: label, newName: renamedLabel },
			"label-update",
		);
		currentLabel = renamedLabel;
		if (updated?.name !== renamedLabel)
			throw new Error("updated label does not match");
		const issueInput = { ...repository, issueNumber };
		const originalIssue = await read(call, "github.get_issue", issueInput);
		originalIssueLabels = Array.isArray(originalIssue?.labels)
			? originalIssue.labels
					.map((value) => (typeof value === "string" ? value : value?.name))
					.filter(Boolean)
			: [];
		originalAssignees = Array.isArray(originalIssue?.assignees)
			? originalIssue.assignees.map((value) => value?.login).filter(Boolean)
			: [];
		let result = await execute(
			"github.add_issue_labels",
			{ ...issueInput, labels: [renamedLabel] },
			"issue-label-add",
		);
		issueLabelsChanged = true;
		assertIncludes(result?.labels, renamedLabel, "added issue labels");
		result = await execute(
			"github.remove_issue_label",
			{ ...issueInput, label: renamedLabel },
			"issue-label-remove",
		);
		assertNames(result?.labels, originalIssueLabels, "removed issue labels");
		result = await execute(
			"github.set_issue_labels",
			{ ...issueInput, labels: [renamedLabel] },
			"issue-label-set",
		);
		assertNames(result?.labels, [renamedLabel], "set issue labels");
		result = await execute(
			"github.clear_issue_labels",
			issueInput,
			"issue-label-clear",
		);
		if (result?.ok !== true)
			throw new Error("cleared issue labels do not match");
		await execute(
			"github.set_issue_labels",
			{ ...issueInput, labels: originalIssueLabels },
			"issue-label-restore",
			false,
		);
		issueLabelsChanged = false;
		result = await execute(
			"github.add_issue_assignees",
			{ ...issueInput, assignees: ["AGORAconnectionE2E"] },
			"issue-assignee-add",
		);
		issueAssigneesChanged = true;
		assertIncludes(
			result?.assignees,
			"AGORAconnectionE2E",
			"added issue assignees",
			"login",
		);
		result = await execute(
			"github.remove_issue_assignees",
			{ ...issueInput, assignees: ["AGORAconnectionE2E"] },
			"issue-assignee-remove",
		);
		assertNames(
			result?.assignees,
			originalAssignees,
			"removed issue assignees",
			"login",
		);
		if (originalAssignees.length > 0)
			await execute(
				"github.add_issue_assignees",
				{ ...issueInput, assignees: originalAssignees },
				"issue-assignee-restore",
				false,
			);
		issueAssigneesChanged = false;
		result = await execute(
			"github.lock_issue",
			{ ...issueInput, lockReason: "resolved" },
			"issue-lock",
		);
		issueLocked = true;
		if (result?.locked !== true)
			throw new Error("locked issue state does not match");
		result = await execute("github.unlock_issue", issueInput, "issue-unlock");
		if (result?.locked !== false)
			throw new Error("unlocked issue state does not match");
		issueLocked = false;

		result = await execute(
			"github.create_or_update_file",
			{
				...repository,
				content: marker,
				message: `${marker} create file`,
				path: filePath,
			},
			"file-create",
		);
		fileSha = result?.content?.sha;
		if (!fileSha)
			fileSha = (
				await read(call, "github.get_file_contents", {
					...repository,
					path: filePath,
				})
			)?.sha;
		if (!fileSha || result.content?.path !== filePath)
			throw new Error("created file does not match");
		await execute(
			"github.delete_file",
			{
				...repository,
				message: `${marker} delete file`,
				path: filePath,
				sha: fileSha,
			},
			"file-delete",
		);
		fileSha = undefined;
		await expect404(call, "github.get_file_contents", {
			...repository,
			path: filePath,
		});

		originalTopics = await read(
			call,
			"github.list_repository_topics",
			repository,
		);
		const topic = branch.slice(0, 50);
		result = await execute(
			"github.replace_repository_topics",
			{ ...repository, names: [topic] },
			"topics-replace",
		);
		topicsChanged = true;
		assertNames(
			result?.names?.map((name) => ({ name })),
			[topic],
			"replaced topics",
		);
		await execute(
			"github.replace_repository_topics",
			{ ...repository, names: originalTopics?.names ?? [] },
			"topics-restore",
			false,
		);
		topicsChanged = false;

		originalStar =
			(await read(call, "github.check_repository_starred", repository))
				?.starred === true;
		if (originalStar) {
			await execute("github.unstar_repository", repository, "star-remove");
			starChanged = true;
			await execute("github.star_repository", repository, "star-restore");
		} else {
			await execute("github.star_repository", repository, "star-add");
			starChanged = true;
			await execute("github.unstar_repository", repository, "star-restore");
		}
		starChanged = false;

		result = await execute(
			"github.create_milestone",
			{ ...repository, description: marker, title: `${marker} milestone` },
			"milestone-create",
		);
		milestoneNumber = result?.number;
		if (!Number.isSafeInteger(milestoneNumber)) {
			const milestones = await read(call, "github.list_milestones", repository);
			milestoneNumber = milestones?.milestones?.find(
				(value) => value?.title === `${marker} milestone`,
			)?.number;
		}
		if (
			!Number.isSafeInteger(milestoneNumber) ||
			result.title !== `${marker} milestone`
		)
			throw new Error("created milestone does not match");
		result = await execute(
			"github.update_milestone",
			{
				...repository,
				description: `${marker} updated`,
				milestoneNumber,
				title: `${marker} milestone updated`,
			},
			"milestone-update",
		);
		if (
			result?.number !== milestoneNumber ||
			result.title !== `${marker} milestone updated`
		)
			throw new Error("updated milestone does not match");
		await execute(
			"github.delete_milestone",
			{ ...repository, milestoneNumber },
			"milestone-delete",
		);
		milestoneNumber = undefined;

		releaseTag = `${branch}-release`;
		result = await execute(
			"github.generate_release_notes",
			{ ...repository, tagName: releaseTag, targetCommitish: "main" },
			"release-notes",
		);
		if (typeof result?.name !== "string" || typeof result.body !== "string")
			throw new Error("generated release notes do not match");
		result = await execute(
			"github.create_release",
			{
				...repository,
				body: marker,
				name: `${marker} release`,
				tagName: releaseTag,
				targetCommitish: "main",
			},
			"release-create",
		);
		releaseId = result?.id;
		if (!Number.isSafeInteger(releaseId))
			releaseId = (
				await read(call, "github.get_release_by_tag", {
					...repository,
					tag: releaseTag,
				})
			)?.id;
		if (!Number.isSafeInteger(releaseId) || result.tag_name !== releaseTag)
			throw new Error("created release does not match");
		result = await execute(
			"github.update_release",
			{
				...repository,
				body: `${marker} updated`,
				name: `${marker} release updated`,
				releaseId,
			},
			"release-update",
		);
		if (result?.id !== releaseId || result.name !== `${marker} release updated`)
			throw new Error("updated release does not match");
		await execute(
			"github.delete_release",
			{ ...repository, releaseId },
			"release-delete",
		);
		releaseId = undefined;
		await execute(
			"github.delete_ref",
			{ ...repository, ref: `tags/${releaseTag}` },
			"release-tag-delete",
			false,
		);
		releaseTag = undefined;
		await execute(
			"github.delete_label",
			{ ...repository, name: currentLabel },
			"label-delete",
		);
		currentLabel = undefined;
		await expect404(call, "github.get_label", {
			...repository,
			name: renamedLabel,
		});
	} finally {
		const attempt = async (operation) => {
			if (uncertain) return;
			try {
				await operation();
			} catch {
				cleanup = "FAILED";
			}
		};
		if (!uncertain) {
			if (releaseId)
				await attempt(async () => {
					await execute(
						"github.delete_release",
						{ ...repository, releaseId },
						"cleanup-release",
						false,
					);
					releaseId = undefined;
				});
			if (releaseTag)
				await attempt(async () => {
					await execute(
						"github.delete_ref",
						{ ...repository, ref: `tags/${releaseTag}` },
						"cleanup-release-tag",
						false,
					);
					releaseTag = undefined;
				});
			if (milestoneNumber)
				await attempt(async () => {
					await execute(
						"github.delete_milestone",
						{ ...repository, milestoneNumber },
						"cleanup-milestone",
						false,
					);
					milestoneNumber = undefined;
				});
			if (fileSha)
				await attempt(async () => {
					await execute(
						"github.delete_file",
						{
							...repository,
							message: `${marker} cleanup file`,
							path: filePath,
							sha: fileSha,
						},
						"cleanup-file",
						false,
					);
					fileSha = undefined;
				});
			if (issueLocked)
				await attempt(async () => {
					await execute(
						"github.unlock_issue",
						{ ...repository, issueNumber },
						"cleanup-issue-unlock",
						false,
					);
					issueLocked = false;
				});
			if (issueAssigneesChanged)
				await attempt(async () => {
					await execute(
						"github.remove_issue_assignees",
						{ ...repository, issueNumber, assignees: ["AGORAconnectionE2E"] },
						"cleanup-issue-assignees",
						false,
					);
					if (originalAssignees.length > 0)
						await execute(
							"github.add_issue_assignees",
							{ ...repository, issueNumber, assignees: originalAssignees },
							"cleanup-issue-assignees-restore",
							false,
						);
					issueAssigneesChanged = false;
				});
			if (issueLabelsChanged)
				await attempt(async () => {
					await execute(
						"github.set_issue_labels",
						{ ...repository, issueNumber, labels: originalIssueLabels },
						"cleanup-issue-labels",
						false,
					);
					issueLabelsChanged = false;
				});
			if (currentLabel)
				await attempt(async () => {
					await execute(
						"github.delete_label",
						{ ...repository, name: currentLabel },
						"cleanup-label",
						false,
					);
					currentLabel = undefined;
				});
			if (currentRef)
				await attempt(async () => {
					await execute(
						"github.delete_ref",
						{ ...repository, ref: currentRef },
						"cleanup-ref",
						false,
					);
					currentRef = undefined;
				});
			if (topicsChanged)
				await attempt(async () => {
					await execute(
						"github.replace_repository_topics",
						{ ...repository, names: originalTopics?.names ?? [] },
						"cleanup-topics",
						false,
					);
					topicsChanged = false;
				});
			if (starChanged)
				await attempt(async () => {
					await execute(
						originalStar
							? "github.star_repository"
							: "github.unstar_repository",
						repository,
						"cleanup-star",
						false,
					);
					starChanged = false;
				});
		}
		if (
			currentLabel ||
			currentRef ||
			issueLocked ||
			issueAssigneesChanged ||
			issueLabelsChanged ||
			fileSha ||
			milestoneNumber ||
			releaseId ||
			releaseTag ||
			topicsChanged ||
			starChanged ||
			uncertain
		)
			cleanup = "FAILED";
	}
	if (cleanup !== "SUCCEEDED") throw new Error("GitHub write cleanup failed");
	return { calls, cleanup, runId };
}

async function read(call, actionId, input) {
	const result = await call("execute_action", { actionId, input });
	if (result?.status !== "SUCCEEDED")
		throw new Error(`${actionId} did not succeed`);
	return result.result;
}

function assertNames(values, expected, name, field = "name") {
	const actual = Array.isArray(values)
		? values.map((value) => value?.[field]).sort()
		: undefined;
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
		throw new Error(`${name} do not match`);
}

function assertIncludes(values, expected, name, field = "name") {
	if (
		!Array.isArray(values) ||
		!values.some((value) => value?.[field] === expected)
	)
		throw new Error(`${name} do not match`);
}

async function expect404(call, actionId, input) {
	try {
		await call("execute_action", { actionId, input });
	} catch (error) {
		if (
			error instanceof McpError &&
			error.code === -32001 &&
			error.data?.providerHttpStatus === 404
		)
			return;
		throw error;
	}
	throw new Error(`${actionId} remained readable after cleanup`);
}

function hash(input) {
	return createHash("sha256")
		.update(JSON.stringify(Object.fromEntries(Object.entries(input).sort())))
		.digest("hex");
}

class McpError extends Error {
	constructor(code, data) {
		super(`Connection MCP error ${code}`);
		this.code = code;
		this.data = data;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const runId = process.argv[2]?.trim() || randomUUID();
	try {
		console.log(
			JSON.stringify(
				await runGitHubLowRiskWriteConformance({
					environment: process.env,
					fetch: globalThis.fetch,
					runId,
				}),
			),
		);
	} catch (error) {
		console.error(
			JSON.stringify({
				error:
					error instanceof Error ? error.message : "GitHub write E2E failed",
				outcome: "FAILED",
				runId,
			}),
		);
		process.exitCode = 1;
	}
}
