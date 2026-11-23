import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PRIMARY_ISSUE_KEYWORD = /^\s*(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)|refs)\s+#(\d+)\b/gim;
const PROVENANCE_BLOCK = /<!--\s*agent-provenance:start\s*-->\s*([\s\S]*?)\s*<!--\s*agent-provenance:end\s*-->/g;
const CLAIM_BLOCK = /<!--\s*agent-claim:start\s*-->\s*([\s\S]*?)\s*<!--\s*agent-claim:end\s*-->/g;
const CLAIM_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function labelNames(labels = []) {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((label) => typeof label === "string");
}

function parseKeyValueBlock(body, pattern) {
  const blocks = [...String(body ?? "").matchAll(pattern)];
  if (blocks.length !== 1) return null;
  const values = {};
  for (const line of blocks[0][1].split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z-]*):\s*([^\r\n]+?)\s*$/.exec(line);
    if (match) {
      if (match[1] in values) return null;
      values[match[1]] = match[2];
    }
  }
  return values;
}

export function extractAgentSessionId(body) {
  const values = parseKeyValueBlock(body, PROVENANCE_BLOCK);
  const session = values?.["Agent-Session-ID"];
  return typeof session === "string" && session.length > 0 ? session : null;
}

function parseClaimComment(comment) {
  if (
    !comment ||
    !CLAIM_ASSOCIATIONS.has(comment.author_association) ||
    comment.updated_at !== comment.created_at
  ) return null;
  const values = parseKeyValueBlock(comment.body, CLAIM_BLOCK);
  if (
    !values ||
    Object.keys(values).sort().join(",") !== "Claimed-By-Session,Handoff-From"
  ) return null;
  const claimed = values?.["Claimed-By-Session"];
  const from = values?.["Handoff-From"];
  if (!claimed || !from) return null;
  return { claimed, from };
}

export function resolveIssueClaim(issue, comments = []) {
  let current = extractAgentSessionId(issue?.body);
  const ordered = [...comments].sort((a, b) => {
    const left = Date.parse(a.created_at ?? "");
    const right = Date.parse(b.created_at ?? "");
    return left - right;
  });
  for (const comment of ordered) {
    const claim = parseClaimComment(comment);
    if (!claim) continue;
    if (claim.from === (current ?? "none")) current = claim.claimed;
  }
  return current;
}

export function extractPrimaryIssueNumbers(body = "") {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(PRIMARY_ISSUE_KEYWORD)].map((match) => Number(match[1]));
}

export function evaluateIssueGate({
  issueNumbers,
  issue,
  pullRequestCreatedAt,
  pullRequestBody,
  pullRequestLabels = [],
  issueComments = [],
}) {
  if (issueNumbers.length !== 1) {
    return {
      ok: false,
      description:
        issueNumbers.length === 0
          ? "PR must contain exactly one Closes #<issue> or Refs #<issue> reference"
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

  if (labelNames(pullRequestLabels).some((label) => label.startsWith("agent:"))) {
    const pullSession = extractAgentSessionId(pullRequestBody);
    const issueSession = resolveIssueClaim(issue, issueComments);
    if (pullSession !== issueSession) {
      return {
        ok: false,
        description:
          `Agent PR session does not match Issue #${number} claim (PR session ${pullSession ?? "none"}, Issue claim ${issueSession ?? "none"}); add a valid handoff comment with Handoff-From to transfer the claim`,
      };
    }
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

async function readIssueComments(repository, issueNumber, request) {
  const comments = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch)) throw new Error("GitHub comments API returned an invalid response");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
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
  const comments =
    issue && labelNames(pr.labels).some((label) => label.startsWith("agent:"))
      ? await readIssueComments(repository, issueNumbers[0], request)
      : [];
  return evaluateIssueGate({
    issueNumbers,
    issue,
    pullRequestCreatedAt: pr.created_at,
    pullRequestBody: pr.body,
    pullRequestLabels: pr.labels,
    issueComments: comments,
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
