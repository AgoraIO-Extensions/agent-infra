import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

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
  { verifiedRepositoryPermission } = {},
) {
  if (eventName === "issues") {
    if (event.action === "opened") {
      return (
        TRUSTED_ASSOCIATIONS.has(event.issue?.author_association) ||
        TRUSTED_REPOSITORY_PERMISSIONS.has(verifiedRepositoryPermission)
      );
    }
    return event.action === "labeled" && event.label?.name === "claude";
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return isTrustedMention(event.comment);
  }
  if (eventName === "pull_request_review") {
    return isTrustedMention(event.review);
  }
  return false;
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
  if (typeof payload.permission !== "string") {
    throw new Error("GitHub repository permission lookup returned no permission");
  }
  return payload.permission;
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
  if (
    eventName === "issues" &&
    event.action === "opened" &&
    !authorizeClaudeEvent(eventName, event)
  ) {
    verifiedRepositoryPermission = await fetchRepositoryPermission({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      username: event.issue?.user?.login,
      token: requiredEnvironment("GITHUB_TOKEN"),
    });
  }
  const allowed = authorizeClaudeEvent(eventName, event, {
    verifiedRepositoryPermission,
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
