import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HUMAN_LABEL = "ready-for-human";
const CLOSE_KEYWORD = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gim;

function labelNames(labels = []) {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

export function extractPrimaryIssueNumbers(body = "") {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(CLOSE_KEYWORD)].map((match) => Number(match[1]));
}

export function evaluateIssueGate({ issueNumbers, issue, headRef }) {
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
  if (issue.state !== "open") {
    return { ok: false, description: `Primary Issue #${number} is not open` };
  }
  if (labelNames(issue.labels).includes("wontfix")) {
    return { ok: false, description: `Primary Issue #${number} is marked wontfix` };
  }

  const workerBranch = /^codex\/issue-(\d+)$/.exec(headRef ?? "");
  if ((headRef ?? "").startsWith("codex/issue-") && !workerBranch) {
    return { ok: false, description: "Worker branch name is invalid" };
  }
  if (workerBranch) {
    if (Number(workerBranch[1]) !== number) {
      return {
        ok: false,
        description: `Worker branch does not match Primary Issue #${number}`,
      };
    }
    if (!labelNames(issue.labels).includes("ready-for-agent")) {
      return {
        ok: false,
        description: `Worker Issue #${number} is not ready for Agent`,
      };
    }
    return {
      ok: true,
      description: `Worker Issue #${number} is ready for Agent`,
    };
  }
  return { ok: true, description: `Primary Issue #${number} is open` };
}

export function evaluateHumanValidationGate(labels) {
  const pending = labelNames(labels).includes(HUMAN_LABEL);
  return pending
    ? { ok: false, description: "Human validation is still required" }
    : { ok: true, description: "No pending human validation" };
}

export function shouldReapplyHumanValidation({ action, labels, events }) {
  if (action !== "synchronize" || labelNames(labels).includes(HUMAN_LABEL)) {
    return false;
  }
  return events.some(
    (event) => event.event === "labeled" && event.label?.name === HUMAN_LABEL,
  );
}

export function buildStatusPayload({ state, context, description, targetUrl }) {
  return {
    state,
    context,
    description: description.slice(0, 140),
    target_url: targetUrl,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path}: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function paginate(path) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubRequest(`${path}${separator}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub API pagination limit exceeded for ${path}`);
}

async function setStatus(repository, sha, payload) {
  await githubRequest(`/repos/${repository}/statuses/${sha}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function setPendingStatuses(repository, pr) {
  await Promise.all(
    ["Issue Gate", "Human Validation Gate"].map((context) =>
      setStatus(
        repository,
        pr.head.sha,
        buildStatusPayload({
          state: "pending",
          context,
          description: "Re-evaluating PR metadata",
          targetUrl: pr.html_url,
        }),
      ),
    ),
  );
}

async function evaluatePullRequest(repository, number, action) {
  const pr = await githubRequest(`/repos/${repository}/pulls/${number}`);
  await setPendingStatuses(repository, pr);
  let labels = pr.labels;

  if (action === "synchronize" && !labelNames(labels).includes(HUMAN_LABEL)) {
    const events = await paginate(`/repos/${repository}/issues/${number}/events`);
    if (shouldReapplyHumanValidation({ action, labels, events })) {
      await githubRequest(`/repos/${repository}/issues/${number}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: [HUMAN_LABEL] }),
      });
      labels = [...labels, { name: HUMAN_LABEL }];
    }
  }

  const issueNumbers = extractPrimaryIssueNumbers(pr.body ?? "");
  const issue =
    issueNumbers.length === 1
      ? await githubRequest(`/repos/${repository}/issues/${issueNumbers[0]}`)
      : undefined;
  const targetUrl = pr.html_url;
  const issueResult = evaluateIssueGate({
    issueNumbers,
    issue,
    headRef: pr.head.ref,
  });
  const humanResult = evaluateHumanValidationGate(labels);

  await Promise.all([
    setStatus(
      repository,
      pr.head.sha,
      buildStatusPayload({
        state: issueResult.ok ? "success" : "failure",
        context: "Issue Gate",
        description: issueResult.description,
        targetUrl,
      }),
    ),
    setStatus(
      repository,
      pr.head.sha,
      buildStatusPayload({
        state: humanResult.ok ? "success" : "failure",
        context: "Human Validation Gate",
        description: humanResult.description,
        targetUrl,
      }),
    ),
  ]);
}

async function main() {
  const event = JSON.parse(await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");

  if (eventName === "pull_request_target") {
    await evaluatePullRequest(repository, event.pull_request.number, event.action);
    return;
  }

  if (eventName === "issues") {
    const pulls = await paginate(`/repos/${repository}/pulls?state=open`);
    const affected = pulls.filter((pr) =>
      extractPrimaryIssueNumbers(pr.body ?? "").includes(event.issue.number),
    );
    await Promise.all(
      affected.map(async (pr) => {
        await setPendingStatuses(repository, pr);
        await githubRequest(`/repos/${repository}/dispatches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "pr-gates",
            client_payload: { pr_number: pr.number },
          }),
        });
      }),
    );
    return;
  }

  if (eventName === "repository_dispatch" && event.action === "pr-gates") {
    await evaluatePullRequest(repository, Number(event.client_payload.pr_number), "issue-updated");
    return;
  }

  throw new Error(`Unsupported event: ${eventName}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
