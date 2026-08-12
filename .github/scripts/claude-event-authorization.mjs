import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  buildBlockerReviewAck,
  hasTrustedBlockerReviewAck,
  isTrustedBlockerReviewComment,
  parseBlockerProposalRecord,
} from "./blocker-contract.mjs";

const TRUSTED_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);
const TRUSTED_REPOSITORY_PERMISSIONS = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
]);

function isTrustedMention(value) {
  return (
    TRUSTED_ASSOCIATIONS.has(value?.author_association) &&
    value?.body?.includes("@claude") === true
  );
}

export function authorizeClaudeEvent(
  eventName,
  event,
  { verifiedRepositoryPermission, verifiedBlockerReview = false } = {},
) {
  if (eventName === "repository_dispatch") {
    return event.action === "claude-blocker-review" && verifiedBlockerReview;
  }
  if (eventName === "issues") {
    if (event.action === "opened") {
      return (
        TRUSTED_ASSOCIATIONS.has(event.issue?.author_association) ||
        TRUSTED_REPOSITORY_PERMISSIONS.has(verifiedRepositoryPermission)
      );
    }
    return (
      event.action === "labeled" &&
      event.label?.name === "claude" &&
      (TRUSTED_ASSOCIATIONS.has(event.issue?.author_association) ||
        TRUSTED_REPOSITORY_PERMISSIONS.has(verifiedRepositoryPermission))
    );
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return isTrustedMention(event.comment);
  }
  if (eventName === "pull_request_review") {
    return isTrustedMention(event.review);
  }
  return false;
}

async function githubJson(apiPath, { token, method = "GET", body } = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub blocker review lookup failed: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function githubPaginate(apiPath, { token, request = githubJson } = {}) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const batch = await request(
      `${apiPath}${separator}per_page=100&page=${page}`,
      { token },
    );
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error("GitHub blocker review pagination limit exceeded");
}

export async function authorizeBlockerReviewDispatch({
  repository,
  issueNumber,
  token,
  request = githubJson,
  paginate = githubPaginate,
}) {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Blocker review Issue is invalid");
  }
  const issue = await request(`/repos/${repository}/issues/${issueNumber}`, { token });
  const comments = await paginate(
    `/repos/${repository}/issues/${issueNumber}/comments`,
    { token, request },
  );
  const record = parseBlockerProposalRecord(issue, { comments });
  if (
    !record ||
    !comments.some((comment) => isTrustedBlockerReviewComment(comment)) ||
    hasTrustedBlockerReviewAck(comments, issueNumber, record)
  ) {
    return false;
  }
  await request(`/repos/${repository}/issues/${issueNumber}/comments`, {
    token,
    method: "POST",
    body: JSON.stringify({ body: buildBlockerReviewAck(issueNumber, record) }),
  });
  return true;
}

export async function fetchRepositoryPermission({
  repository,
  username,
  token,
  request = fetch,
}) {
  if (!repository) throw new Error("GitHub repository is required");
  if (typeof username !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(username)) {
    throw new Error("GitHub username is invalid");
  }
  if (!token) throw new Error("GitHub token is required");

  const response = await request(
    `https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(username)}/permission`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub repository permission lookup failed: ${response.status}`);
  }

  const payload = await response.json();
  if (typeof payload.role_name !== "string") {
    throw new Error("GitHub repository permission lookup returned no role");
  }
  return payload.role_name;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const event = JSON.parse(
    await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
  );
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");
  let verifiedRepositoryPermission;
  let verifiedBlockerReview = false;
  if (
    eventName === "issues" &&
    (event.action === "opened" || event.action === "labeled") &&
    !authorizeClaudeEvent(eventName, event)
  ) {
    verifiedRepositoryPermission = await fetchRepositoryPermission({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      username: event.issue?.user?.login,
      token: requiredEnvironment("GITHUB_TOKEN"),
    });
  }
  if (
    eventName === "repository_dispatch" &&
    event.action === "claude-blocker-review"
  ) {
    verifiedBlockerReview = await authorizeBlockerReviewDispatch({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      issueNumber: event.client_payload?.issue_number,
      token: requiredEnvironment("GITHUB_TOKEN"),
    });
  }
  const allowed = authorizeClaudeEvent(eventName, event, {
    verifiedRepositoryPermission,
    verifiedBlockerReview,
  });
  await fs.appendFile(requiredEnvironment("GITHUB_OUTPUT"), `allowed=${allowed}\n`);
  console.log(allowed ? "Claude event authorized" : "Claude event not authorized");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
