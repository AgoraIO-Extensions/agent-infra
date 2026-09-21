import { pathToFileURL } from "node:url";

import {
	assertRepository,
	assertSingleAccount,
	mcpClient,
} from "./github-review-e2e.mjs";

const actions = ["github.get_current_user", "github.get_repository"];

export async function runGitHubReviewHealth({ environment, fetch }) {
	const token = environment.CONNECTION_E2E_REVIEWER_TOKEN?.trim();
	if (!token) throw new Error("CONNECTION_E2E_REVIEWER_TOKEN is required");
	const client = mcpClient(fetch, token);
	await assertSingleAccount(client, "329435106");

	for (const actionId of actions) {
		const guide = await client.call("get_action_guide", { actionId }, true);
		if (
			guide?.action?.actionVersionId !== `${actionId}@v9` ||
			guide.action.effect !== "READ"
		) {
			throw new Error(`${actionId} has an unapproved ActionVersion`);
		}
	}

	const user = await client.execute("github.get_current_user", {}, true);
	if (
		user.actionVersionId !== "github.get_current_user@v9" ||
		String(user.result?.id) !== "329435106"
	) {
		throw new Error("reviewer identity does not match");
	}
	const repository = await client.execute(
		"github.get_repository",
		{ owner: "AgoraConnectionE2EORG", repo: "connector-conformance" },
		true,
	);
	if (repository.actionVersionId !== "github.get_repository@v9") {
		throw new Error(
			"github.get_repository executed an unapproved ActionVersion",
		);
	}
	assertRepository(repository.result);

	return {
		actionVersionIds: actions.map((action) => `${action}@v9`),
		account: user.result.login,
		repository: repository.result.full_name,
		status: "SUCCEEDED",
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runGitHubReviewHealth({ environment: process.env, fetch })
		.then((evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`))
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify({ error: error instanceof Error ? error.message : "Reviewer health probe failed", status: "FAILED" })}\n`,
			);
			process.exitCode = 1;
		});
}
