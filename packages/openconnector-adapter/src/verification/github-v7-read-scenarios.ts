type GitHubReadScenarioBase = {
	actionVersionId: `github.${string}@v7`;
	execution: "LIVE" | "SKIPPED_MISSING_SECOND_ACTOR";
	fixture: "ISSUE_PR" | "RELEASE_WORKFLOW" | "REPOSITORY_REF" | "USER_ACTIVITY";
};

export type GitHubReadScenario = GitHubReadScenarioBase &
	(
		| { boundary: "ACCOUNT"; target: typeof accountTarget }
		| { boundary: "ORGANIZATION"; target: typeof organizationTarget }
		| { boundary: "REPOSITORY"; target: typeof repositoryTarget }
	);

const accountTarget = { externalAccount: "328682695" } as const;
const repositoryTarget = {
	externalAccount: "328682695",
	repositoryId: "1369705971",
} as const;
const organizationTarget = {
	externalAccount: "328682695",
	organizationId: "329053903",
} as const;

const repositoryRef = [
	"list_branches",
	"get_branch",
	"get_repository",
	"list_commits",
	"get_commit",
	"compare_commits",
	"get_commit_statuses",
	"list_check_runs_for_ref",
	"list_directory_contents",
	"get_file_contents",
	"search_repositories",
	"search_commits",
	"search_code",
	"search_labels",
	"search_topics",
	"list_repository_forks",
	"list_repository_tags",
	"list_repository_languages",
	"list_repository_contributors",
	"list_repository_topics",
	"get_repository_readme",
	"list_user_repositories",
	"list_repository_collaborators",
	"get_repository_permission_for_user",
	"get_ref",
	"list_matching_refs",
	"list_commit_comments",
	"check_repository_starred",
	"list_repository_stargazers",
	"list_repository_watchers",
] as const;

const issuePr = [
	"list_repository_issues",
	"get_issue",
	"list_repository_labels",
	"list_issue_labels",
	"list_issue_comments",
	"search_issues_and_pull_requests",
	"list_pull_requests",
	"list_pull_requests_associated_with_commit",
	"list_pull_request_files",
	"list_pull_request_commits",
	"list_pull_request_requested_reviewers",
	"list_pull_request_reviews",
	"list_pull_request_review_comments",
	"get_pull_request",
	"check_pull_request_merged",
	"list_issue_timeline_events",
	"list_issue_events",
	"list_repository_issue_events",
	"list_milestones",
	"get_milestone",
	"get_issue_comment",
	"get_label",
	"list_assignees",
] as const;

const releaseWorkflow = [
	"list_repository_workflows",
	"list_workflow_runs",
	"get_workflow_run",
	"list_workflow_run_jobs",
	"list_releases",
	"get_release",
	"get_latest_release",
	"get_release_by_tag",
	"list_release_assets",
	"get_workflow",
	"list_workflow_run_artifacts",
	"get_release_asset",
] as const;

const userActivity = [
	"get_current_user",
	"list_my_repositories",
	"list_public_events",
	"list_user_public_events",
	"list_user_received_public_events",
	"list_authenticated_user_events",
	"list_authenticated_user_received_events",
	"list_repository_events",
	"search_users",
	"get_user",
	"list_my_starred_repositories",
] as const;

function scenarios(
	names: readonly string[],
	fixture: GitHubReadScenario["fixture"],
	boundary: GitHubReadScenario["boundary"] = "REPOSITORY",
	execution: GitHubReadScenario["execution"] = "LIVE",
): GitHubReadScenario[] {
	return names.map((name) =>
		boundary === "ACCOUNT"
			? {
					actionVersionId: `github.${name}@v7`,
					boundary,
					execution,
					fixture,
					target: accountTarget,
				}
			: boundary === "ORGANIZATION"
				? {
						actionVersionId: `github.${name}@v7`,
						boundary,
						execution,
						fixture,
						target: organizationTarget,
					}
				: {
						actionVersionId: `github.${name}@v7`,
						boundary,
						execution,
						fixture,
						target: repositoryTarget,
					},
	);
}

export const githubV7ReadScenarios = [
	...scenarios(repositoryRef, "REPOSITORY_REF"),
	...scenarios(
		["list_organization_repositories"],
		"REPOSITORY_REF",
		"ORGANIZATION",
	),
	...scenarios(issuePr, "ISSUE_PR"),
	...scenarios(
		["get_pull_request_review"],
		"ISSUE_PR",
		"REPOSITORY",
		"SKIPPED_MISSING_SECOND_ACTOR",
	),
	...scenarios(releaseWorkflow, "RELEASE_WORKFLOW"),
	...scenarios(userActivity, "USER_ACTIVITY", "ACCOUNT"),
] as const satisfies readonly GitHubReadScenario[];
