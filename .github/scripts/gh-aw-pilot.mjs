import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { extractPrimaryIssueNumbers } from "./pr-gates.mjs";
import { executionContent, WORKER_OWNERS_TEAM_SLUG } from "./worker-contract.mjs";

const CATEGORY_LABELS = ["bug", "enhancement", "documentation"];
const TARGET_VERSION = "gh-aw-pilot-target-v1";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parsePilotIssueNumber(value) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) {
    throw new Error("Pilot Issue number is invalid");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Pilot Issue number is invalid");
  return number;
}

export function normalizeGitHubApiUrl(value) {
  const url = new URL(String(value ?? ""));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("GitHub API URL is invalid");
  }
  return url.href.replace(/\/$/, "");
}

function labelsOf(value) {
  return (value?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

export function validatePilotSnapshot({
  repository,
  issueNumber,
  issue,
  blockers,
  activePullRequests,
  branchExists,
  actor,
  triggeringActor,
  expectedActor,
  actorAccount,
  membership,
  phase,
  expectedExecutionContentHash,
  expectedTargetHash,
}) {
  if (actor !== expectedActor || triggeringActor !== expectedActor) {
    throw new Error("Pilot operator is not authorized");
  }
  if (actorAccount?.type !== "User" || membership?.state !== "active") {
    throw new Error("Pilot operator Team membership is invalid");
  }
  if (!["member", "maintainer"].includes(membership?.role)) {
    throw new Error("Pilot operator Team role is invalid");
  }
  if (issue?.pull_request || issue?.number !== issueNumber || issue?.state !== "open") {
    throw new Error("Pilot target must be an open Issue");
  }
  const categories = CATEGORY_LABELS.filter((label) => labelsOf(issue).includes(label));
  if (categories.length !== 1) {
    throw new Error("Pilot target must have exactly one source category");
  }
  if (
    blockers.some(
      (blocker) =>
        blocker.state !== "closed" ||
        blocker.state_reason !== "completed" ||
        labelsOf(blocker).includes("wontfix"),
    )
  ) {
    throw new Error("Pilot target has an incomplete native blocker");
  }
  if (activePullRequests.length > 0 || branchExists) {
    throw new Error("Pilot target already has an active implementation");
  }
  const contract = executionContent(issue, {
    blockerNumbers: blockers.map((blocker) => blocker.number).sort((a, b) => a - b),
  });
  const category = categories[0];
  const targetHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: TARGET_VERSION,
        repository,
        issueNumber,
        executionContentHash: contract.hash,
        blockedByHash: contract.blockedByHash,
        category,
      }),
      "utf8",
    )
    .digest("hex");

  if (phase === "authorize") {
    if (contract.hash !== expectedExecutionContentHash) {
      throw new Error("Pilot execution content does not match dispatch authorization");
    }
  } else if (phase === "recheck") {
    if (targetHash !== expectedTargetHash) {
      throw new Error("Pilot target changed after authorization");
    }
  } else {
    throw new Error("Pilot validation phase is invalid");
  }

  return { category, targetHash };
}

async function githubRequest(apiUrl, apiPath, { token, allowNotFound = false } = {}) {
  const response = await fetch(`${apiUrl}${apiPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API request failed with ${response.status}`);
  return response.json();
}

function assertBounded(values, name) {
  if (!Array.isArray(values) || values.length >= 100) {
    throw new Error(`${name} snapshot is invalid or exceeds its limit`);
  }
  return values;
}

export function activePilotPullRequests(
  pullRequests,
  { repository, branch, issueNumber },
) {
  return assertBounded(pullRequests, "Open pull request").filter(
    (pullRequest) =>
      pullRequest.head?.repo?.full_name === repository &&
      (pullRequest.head.ref === branch ||
        extractPrimaryIssueNumbers(pullRequest.body).includes(issueNumber)),
  );
}

async function loadPilotSnapshot({
  repository,
  issueNumber,
  apiUrl,
  token,
  membershipToken,
  triggeringActor,
}) {
  const [owner] = repository.split("/");
  const branch = `gh-aw/pilot-${issueNumber}`;
  const [issue, blockers, pullRequests, branchRef, actorAccount, membership] =
    await Promise.all([
      githubRequest(apiUrl, `/repos/${repository}/issues/${issueNumber}`, { token }),
      githubRequest(
        apiUrl,
        `/repos/${repository}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`,
        { token },
      ),
      githubRequest(apiUrl, `/repos/${repository}/pulls?state=open&per_page=100`, {
        token,
      }),
      githubRequest(
        apiUrl,
        `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
        { token, allowNotFound: true },
      ),
      githubRequest(apiUrl, `/users/${encodeURIComponent(triggeringActor)}`, {
        token,
      }),
      githubRequest(
        apiUrl,
        `/orgs/${owner}/teams/${WORKER_OWNERS_TEAM_SLUG}/memberships/${encodeURIComponent(triggeringActor)}`,
        { token: membershipToken },
      ),
    ]);
  const activePullRequests = activePilotPullRequests(pullRequests, {
    repository,
    branch,
    issueNumber,
  });
  return {
    issue,
    blockers: assertBounded(blockers, "Native blocker"),
    activePullRequests,
    branchExists: branchRef !== null,
    actorAccount,
    membership,
  };
}

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const issueNumber = parsePilotIssueNumber(requiredEnvironment("PILOT_ISSUE_NUMBER"));
  const phase = requiredEnvironment("PILOT_PHASE");
  const actor = requiredEnvironment("GITHUB_ACTOR");
  const triggeringActor = requiredEnvironment("GITHUB_TRIGGERING_ACTOR");
  const snapshot = await loadPilotSnapshot({
    repository,
    issueNumber,
    apiUrl: normalizeGitHubApiUrl(requiredEnvironment("GITHUB_API_URL")),
    token: requiredEnvironment("GITHUB_TOKEN"),
    membershipToken: requiredEnvironment("TEAM_MEMBERSHIP_TOKEN"),
    triggeringActor,
  });
  const result = validatePilotSnapshot({
    repository,
    issueNumber,
    ...snapshot,
    actor,
    triggeringActor,
    expectedActor: requiredEnvironment("PILOT_EXPECTED_ACTOR"),
    phase,
    expectedExecutionContentHash:
      process.env.PILOT_EXPECTED_EXECUTION_CONTENT_HASH,
    expectedTargetHash: process.env.PILOT_EXPECTED_TARGET_HASH,
  });
  if (phase === "authorize") {
    await fs.appendFile(
      requiredEnvironment("GITHUB_OUTPUT"),
      `issue_number=${issueNumber}\ncategory=${result.category}\ntarget_hash=${result.targetHash}\n`,
    );
  }
  console.log(`gh-aw Pilot ${phase} validated for Issue #${issueNumber}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
