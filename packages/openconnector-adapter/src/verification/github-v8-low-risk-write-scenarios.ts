export type GitHubLowRiskWriteScenario = {
	actionVersionId: `github.${string}@v8`;
	cleanup: "DELETE" | "RESTORE";
	marker: "connection-e2e:<runId>";
	resource:
		| "FILE"
		| "ISSUE_METADATA"
		| "LABEL"
		| "MILESTONE"
		| "REF"
		| "RELEASE"
		| "STAR"
		| "TOPICS";
	target: typeof target;
};

const target = {
	externalAccount: "328682695",
	organizationId: "329053903",
	repositoryId: "1369705971",
} as const;

function scenarios(
	names: readonly string[],
	resource: GitHubLowRiskWriteScenario["resource"],
	cleanup: GitHubLowRiskWriteScenario["cleanup"] = "DELETE",
): GitHubLowRiskWriteScenario[] {
	return names.map((name) => ({
		actionVersionId: `github.${name}@v8`,
		cleanup,
		marker: "connection-e2e:<runId>",
		resource,
		target,
	}));
}

export const githubV8LowRiskWriteScenarios = [
	...scenarios(
		["create_ref", "update_ref", "rename_branch", "delete_ref"],
		"REF",
	),
	...scenarios(["create_label", "update_label", "delete_label"], "LABEL"),
	...scenarios(
		[
			"add_issue_labels",
			"set_issue_labels",
			"remove_issue_label",
			"clear_issue_labels",
			"add_issue_assignees",
			"remove_issue_assignees",
			"lock_issue",
			"unlock_issue",
		],
		"ISSUE_METADATA",
	),
	...scenarios(["create_or_update_file", "delete_file"], "FILE"),
	...scenarios(["replace_repository_topics"], "TOPICS", "RESTORE"),
	...scenarios(["star_repository", "unstar_repository"], "STAR", "RESTORE"),
	...scenarios(
		["create_milestone", "update_milestone", "delete_milestone"],
		"MILESTONE",
	),
	...scenarios(
		[
			"generate_release_notes",
			"create_release",
			"update_release",
			"delete_release",
		],
		"RELEASE",
	),
] as const satisfies readonly GitHubLowRiskWriteScenario[];
