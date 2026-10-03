import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ENROLLMENT_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);
const ENABLE_AUTO_MERGE_MUTATION = `
  mutation EnablePullRequestAutoMerge($pullRequestId: ID!) {
    enablePullRequestAutoMerge(
      input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }
    ) {
      pullRequest {
        number
        autoMergeRequest {
          enabledAt
        }
      }
    }
  }
`;

export function evaluateAutoMergeEligibility({
  action,
  pullRequest,
  repository,
  defaultBranch,
}) {
  if (!ENROLLMENT_ACTIONS.has(action)) {
    return { eligible: false, reason: "unsupported action" };
  }
  if (pullRequest.state !== "open") {
    return { eligible: false, reason: "pull request is not open" };
  }
  if (pullRequest.draft) {
    return { eligible: false, reason: "pull request is draft" };
  }
  if (pullRequest.base?.ref !== defaultBranch) {
    return { eligible: false, reason: "base branch is not the default branch" };
  }
  if (pullRequest.head?.repo?.full_name !== repository) {
    return { eligible: false, reason: "pull request head is outside this repository" };
  }
  if (pullRequest.auto_merge) {
    return { eligible: false, reason: "already enrolled" };
  }
  return { eligible: true, reason: "eligible" };
}

export async function enrollPullRequest({ pullRequest, request }) {
  if (pullRequest.auto_merge) return "already-enrolled";
  if (!pullRequest.node_id) throw new Error("Pull request node_id is required");

  const response = await request("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: ENABLE_AUTO_MERGE_MUTATION,
      variables: { pullRequestId: pullRequest.node_id },
    }),
  });
  if (!response.data?.enablePullRequestAutoMerge?.pullRequest) {
    throw new Error("GitHub did not confirm auto-merge enrollment");
  }
  return "enrolled";
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(path, options = {}) {
  const url =
    path === "/graphql" ? "https://api.github.com/graphql" : `https://api.github.com${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path}: ${response.status}`);
  }
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL: ${payload.errors.map((error) => error.message).join("; ")}`);
  }
  return payload;
}

async function main() {
  const event = JSON.parse(
    await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
  );
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const number = event.pull_request?.number;
  if (!number) throw new Error("Pull request event is required");

  const pullRequest = await githubRequest(`/repos/${repository}/pulls/${number}`);
  const eligibility = evaluateAutoMergeEligibility({
    action: event.action,
    pullRequest,
    repository,
    defaultBranch: event.repository?.default_branch,
  });
  if (!eligibility.eligible) {
    console.log(`Auto-merge not enrolled: ${eligibility.reason}`);
    return;
  }

  const result = await enrollPullRequest({ pullRequest, request: githubRequest });
  console.log(`Auto-merge ${result} for PR #${number}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
