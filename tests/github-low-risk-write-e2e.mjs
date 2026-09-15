import { createHash } from "node:crypto";

const endpoint = "https://agent-connector.la3.agoralab.co/mcp";
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
];

export async function runGitHubRefAndLabelConformance({
	environment,
	fetch,
	runId,
}) {
	if (environment.CONNECTION_GITHUB_E2E_ENABLED !== "true")
		throw new Error("CONNECTION_GITHUB_E2E_ENABLED must be true");
	const token = environment.CONNECTION_E2E_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_TOKEN is required");
	if (!runId?.trim()) throw new Error("runId is required");
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
		preflight.result?.id !== Number(target.repositoryId)
	)
		throw new Error("repository boundary does not match");
	for (const name of writeActions) {
		const actionId = `github.${name}`;
		const guide = await call("get_action_guide", { actionId });
		if (
			guide?.action?.actionVersionId !== `${actionId}@v7` ||
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
	const execute = async (actionId, input, step) => {
		const args = { ...input, idempotencyKey: `${runId}:${step}` };
		const result = await call("execute_action", { actionId, input: args });
		if (result?.status !== "SUCCEEDED" || !result.callId)
			throw new Error(`${actionId} did not succeed`);
		calls.push({
			actionVersionId: `${actionId}@v7`,
			callId: result.callId,
			inputHash: hash(args),
			status: result.status,
			target,
		});
		return result.result;
	};
	let currentRef;
	let currentLabel;
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
		if (created?.name !== label)
			throw new Error("created label does not match");
		currentLabel = label;
		const updated = await execute(
			"github.update_label",
			{ ...repository, color: "0969da", name: label, newName: renamedLabel },
			"label-update",
		);
		if (updated?.name !== renamedLabel)
			throw new Error("updated label does not match");
		currentLabel = renamedLabel;
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
		if (currentLabel || currentRef) cleanup = "FAILED";
	}
	if (cleanup !== "SUCCEEDED") throw new Error("GitHub write cleanup failed");
	return { calls, cleanup, runId };
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
