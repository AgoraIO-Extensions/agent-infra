import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CLOSE_KEYWORD = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gim;

function labelNames(labels = []) {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

export function extractPrimaryIssueNumbers(body = "") {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(CLOSE_KEYWORD)].map((match) => Number(match[1]));
}

export function evaluateIssueGate({
  issueNumbers,
  issue,
  pullRequestCreatedAt,
}) {
  if (issueNumbers.length !== 1) {
    return {
      ok: false,
      description:
        issueNumbers.length === 0
          ? "PR must contain exactly one Closes #<issue> reference"
          : "PR contains more than one primary Issue",
    };
  }

  const number = issueNumbers[0];
  if (!issue || issue.pull_request || issue.number !== number) {
    return { ok: false, description: `Primary Issue #${number} is invalid` };
  }
  if (labelNames(issue.labels).includes("wontfix")) {
    return { ok: false, description: `Primary Issue #${number} is marked wontfix` };
  }
  if (
    !validAuditTimestamp(issue.created_at) ||
    !validAuditTimestamp(pullRequestCreatedAt) ||
    Date.parse(issue.created_at) >= Date.parse(pullRequestCreatedAt)
  ) {
    return { ok: false, description: `Primary Issue #${number} must predate this PR` };
  }

  return { ok: true, description: `Primary Issue #${number} exists` };
}

function validAuditTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(apiPath, { tokenEnvironment = "GITHUB_TOKEN", allowNotFound = false, ...options } = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment(tokenEnvironment)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${options.method ?? "GET"}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function runGate({ mode, repository, event, request = githubRequest }) {
  if (mode !== "issue") throw new Error("Expected issue gate");
  const number = event.pull_request?.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("PR event is required");
  const pullPath = `/repos/${repository}/pulls/${number}`;
  const pr = await request(pullPath);
  if (!/^[0-9a-f]{40}$/.test(pr.head?.sha ?? "") || pr.head.sha !== event.pull_request.head?.sha) {
    return { ok: false, description: "PR head changed; rerun the current PR checks" };
  }
  const issueNumbers = extractPrimaryIssueNumbers(pr.body ?? "");
  const issue = issueNumbers.length === 1
    ? await request(`/repos/${repository}/issues/${issueNumbers[0]}`, { allowNotFound: true })
    : null;
  return evaluateIssueGate({
    issueNumbers,
    issue,
    pullRequestCreatedAt: pr.created_at,
  });
}

async function main() {
  if (requiredEnvironment("GITHUB_EVENT_NAME") !== "pull_request_target") {
    throw new Error("Only PR events are supported");
  }
  const event = JSON.parse(await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  const result = await runGate({ mode: process.argv[2], repository: requiredEnvironment("GITHUB_REPOSITORY"), event });
  console.log(result.description);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
