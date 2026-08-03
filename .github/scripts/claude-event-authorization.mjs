import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TRUSTED_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);

function isTrustedMention(value) {
  return (
    TRUSTED_ASSOCIATIONS.has(value?.author_association) &&
    value?.body?.includes("@claude") === true
  );
}

export function authorizeClaudeEvent(
  eventName,
  event,
  { verifiedIssueAuthorAssociation } = {},
) {
  if (eventName === "issues") {
    if (event.action === "opened") {
      return (
        TRUSTED_ASSOCIATIONS.has(event.issue?.author_association) ||
        TRUSTED_ASSOCIATIONS.has(verifiedIssueAuthorAssociation)
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

export async function fetchIssueAuthorAssociation({
  repository,
  issueNumber,
  token,
  request = fetch,
}) {
  if (!repository) throw new Error("GitHub repository is required");
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("GitHub Issue number is invalid");
  }
  if (!token) throw new Error("GitHub token is required");

  const response = await request(
    `https://api.github.com/repos/${repository}/issues/${issueNumber}`,
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
    throw new Error(`GitHub Issue lookup failed: ${response.status}`);
  }

  const payload = await response.json();
  if (typeof payload.author_association !== "string") {
    throw new Error("GitHub Issue lookup returned no author association");
  }
  return payload.author_association;
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
  let verifiedIssueAuthorAssociation;
  if (
    eventName === "issues" &&
    event.action === "opened" &&
    !authorizeClaudeEvent(eventName, event)
  ) {
    verifiedIssueAuthorAssociation = await fetchIssueAuthorAssociation({
      repository: requiredEnvironment("GITHUB_REPOSITORY"),
      issueNumber: event.issue?.number,
      token: requiredEnvironment("GITHUB_TOKEN"),
    });
  }
  const allowed = authorizeClaudeEvent(eventName, event, {
    verifiedIssueAuthorAssociation,
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
