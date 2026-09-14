type GitHubReadScenarioBase = {
	actionVersionId: `github.${string}@v7`;
	execution: "LIVE" | "SKIPPED_MISSING_SECOND_ACTOR";
	fixture: "ISSUE_PR" | "RELEASE_WORKFLOW" | "REPOSITORY_REF" | "USER_ACTIVITY";
	input: Readonly<Record<string, unknown>>;
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
const repositoryInput = {
	owner: "AgoraConnectionE2EORG",
	repo: "connector-conformance",
} as const;
const fixture = {
	assetId: 563149878,
	commentId: 5662497553,
	initialCommit: "7c63d061e74eaccb99dcccdc9b633511197c3406",
	issueNumber: 1,
	mainCommit: "410b111ccf673ab03ecb7239391442e226ad48fd",
	milestoneNumber: 1,
	pullCommit: "82285418de307b681dd8842e24c1af705a88345d",
	pullNumber: 2,
	releaseId: 388309497,
	releaseTag: "connection-e2e-fixture-v1",
	repositoryId: 1369705971,
	runId: 34833158492,
	workflowId: 357727076,
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
	"list_repository_collaborators",
	"get_repository_permission_for_user",
	"get_ref",
	"list_matching_refs",
	"list_commit_comments",
	"check_repository_starred",
	"list_repository_stargazers",
	"list_repository_watchers",
	"list_repository_events",
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
	"search_users",
	"get_user",
	"list_user_repositories",
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
					input: scenarioInput(name),
					target: accountTarget,
				}
			: boundary === "ORGANIZATION"
				? {
						actionVersionId: `github.${name}@v7`,
						boundary,
						execution,
						fixture,
						input: scenarioInput(name),
						target: organizationTarget,
					}
				: {
						actionVersionId: `github.${name}@v7`,
						boundary,
						execution,
						fixture,
						input: scenarioInput(name),
						target: repositoryTarget,
					},
	);
}

function scenarioInput(name: string): Readonly<Record<string, unknown>> {
	const input: Record<string, unknown> = { ...repositoryInput };
	if (
		[
			"get_current_user",
			"list_my_repositories",
			"list_my_starred_repositories",
			"list_public_events",
		].includes(name)
	)
		return {};
	if (name === "list_organization_repositories")
		return { org: "AgoraConnectionE2EORG" };
	if (
		[
			"get_user",
			"list_user_public_events",
			"list_user_received_public_events",
			"list_authenticated_user_events",
			"list_authenticated_user_received_events",
			"list_user_repositories",
		].includes(name)
	)
		return { username: "AGORAconnectionE2E" };
	if (name === "search_users") return { query: "user:AGORAconnectionE2E" };
	if (name === "search_repositories")
		return { query: "repo:AgoraConnectionE2EORG/connector-conformance" };
	if (name === "search_issues_and_pull_requests")
		return {
			query:
				"repo:AgoraConnectionE2EORG/connector-conformance connection-e2e:fixture",
		};
	if (name === "search_commits")
		return {
			query: "repo:AgoraConnectionE2EORG/connector-conformance fixture",
		};
	if (name === "search_code")
		return {
			query: "repo:AgoraConnectionE2EORG/connector-conformance connection-e2e",
		};
	if (name === "search_labels")
		return { query: "connection-e2e", repositoryId: fixture.repositoryId };
	if (name === "search_topics") return { query: "connection-e2e-fixture" };
	if (name === "get_branch") input.branch = "main";
	if (
		["get_commit", "get_commit_statuses", "list_check_runs_for_ref"].includes(
			name,
		)
	)
		input.ref = fixture.mainCommit;
	if (name === "compare_commits")
		input.basehead = `${fixture.initialCommit}...${fixture.mainCommit}`;
	if (
		[
			"get_issue",
			"list_issue_comments",
			"list_issue_events",
			"list_issue_labels",
			"list_issue_timeline_events",
		].includes(name)
	)
		input.issueNumber = fixture.issueNumber;
	if (
		[
			"get_pull_request",
			"check_pull_request_merged",
			"list_pull_request_commits",
			"list_pull_request_files",
			"list_pull_request_requested_reviewers",
			"list_pull_request_review_comments",
			"list_pull_request_reviews",
		].includes(name)
	)
		input.pullNumber = fixture.pullNumber;
	if (name === "list_pull_requests_associated_with_commit")
		input.commitSha = fixture.pullCommit;
	if (name === "list_commit_comments") input.commitSha = fixture.mainCommit;
	if (name === "get_issue_comment") input.commentId = fixture.commentId;
	if (name === "get_label") input.name = "connection-e2e-fixture";
	if (name === "get_repository_permission_for_user")
		input.username = "AGORAconnectionE2E";
	if (name === "get_milestone") input.milestoneNumber = fixture.milestoneNumber;
	if (
		[
			"get_workflow_run",
			"list_workflow_run_artifacts",
			"list_workflow_run_jobs",
		].includes(name)
	)
		input.runId = fixture.runId;
	if (name === "get_workflow") input.workflowId = fixture.workflowId;
	if (["get_release", "list_release_assets"].includes(name))
		input.releaseId = fixture.releaseId;
	if (name === "get_release_by_tag") input.tag = fixture.releaseTag;
	if (name === "get_release_asset") input.assetId = fixture.assetId;
	if (name === "get_file_contents") input.path = "fixtures/read-target.txt";
	if (name === "get_ref") input.ref = "heads/main";
	if (name === "list_matching_refs") input.ref = "heads/";
	return input;
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
