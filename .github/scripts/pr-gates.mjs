import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const HUMAN_LABEL = "ready-for-human";
const OWNERS_TEAM_SLUG = "agent-infra-owners";
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
  if (issue.state !== "open") {
    return { ok: false, description: `Primary Issue #${number} is not open` };
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

  return { ok: true, description: `Primary Issue #${number} is open` };
}

function latestHumanValidationEvent(events = []) {
  return events.findLast(
    (event) =>
      ["labeled", "unlabeled"].includes(event.event) &&
      event.label?.name === HUMAN_LABEL,
  );
}

function currentHumanValidationEvent(events, event, currentHead) {
  if (event?.action !== "unlabeled" || event.label?.name !== HUMAN_LABEL) {
    return latestHumanValidationEvent(events);
  }
  if (event.pull_request?.head?.sha !== currentHead) return null;
  return {
    event: "unlabeled",
    label: event.label,
    actor: event.sender,
    created_at: event.pull_request.updated_at,
    url: event.pull_request.html_url,
  };
}

export function buildGateRecords({
  events = [],
  event,
  currentHead,
  memberships = new Map(),
}) {
  const validationEvent = currentHumanValidationEvent(events, event, currentHead);
  const login = validationEvent?.actor?.login;
  const validation =
    validationEvent?.event === "unlabeled" && login
      ? {
          actor: { login, type: validationEvent.actor?.type },
          headSha: currentHead,
          membership: memberships.get(login),
          reason: "ready-for-human removed",
          recordedAt: validationEvent.created_at,
          url: validationEvent.url,
        }
      : null;
  return { validation };
}

function isActiveTeamMember(record) {
  return (
    record?.actor?.type === "User" &&
    !record.actor.login?.endsWith("[bot]") &&
    record.membership?.state === "active" &&
    ["member", "maintainer"].includes(record.membership.role) &&
    validAuditTimestamp(record.recordedAt) &&
    boundedCheckValue(record.url, 2_048)
  );
}

function validAuditTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function evaluateHumanValidationGate({
  labels = [],
  validationWasRequired = false,
  currentHead,
  validation,
}) {
  const required = validationWasRequired || labelNames(labels).includes(HUMAN_LABEL);
  if (!required) {
    return {
      ok: true,
      description: "Human validation is not required",
    };
  }
  if (
    labelNames(labels).includes(HUMAN_LABEL) ||
    validation?.headSha !== currentHead ||
    !boundedCheckValue(validation?.reason, 4_000) ||
    !isActiveTeamMember(validation)
  ) {
    return {
      ok: false,
      description: "Current-head Team validation confirmation is required",
    };
  }
  return {
    ok: true,
    description: `Human validation confirmed by ${validation.actor.login} for current head`,
  };
}

export function shouldReapplyHumanValidation({ action, labels, events }) {
  if (action !== "synchronize" || labelNames(labels).includes(HUMAN_LABEL)) {
    return false;
  }
  return events.some(
    (event) => event.event === "labeled" && event.label?.name === HUMAN_LABEL,
  );
}

function boundedCheckValue(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
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
  if (!["issue", "human"].includes(mode)) throw new Error("Expected issue or human gate");
  const number = event.pull_request?.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("PR event is required");
  const pullPath = `/repos/${repository}/pulls/${number}`;
  const pr = await request(pullPath);
  if (!/^[0-9a-f]{40}$/.test(pr.head?.sha ?? "") || pr.head.sha !== event.pull_request.head?.sha) {
    return { ok: false, description: "PR head changed; rerun the current PR checks" };
  }
  if (mode === "issue") {
    const issueNumbers = extractPrimaryIssueNumbers(pr.body ?? "");
    const issue = issueNumbers.length === 1
      ? await request(`/repos/${repository}/issues/${issueNumbers[0]}`, { allowNotFound: true })
      : null;
    return evaluateIssueGate({ issueNumbers, issue, pullRequestCreatedAt: pr.created_at });
  }

  const events = [];
  for (let page = 1; ; page += 1) {
    if (page > 20) throw new Error("PR event pagination limit exceeded");
    const batch = await request(`/repos/${repository}/issues/${number}/events?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("PR events are unavailable");
    events.push(...batch);
    if (batch.length < 100) break;
  }
  const required = labelNames(pr.labels).includes(HUMAN_LABEL) ||
    events.some((entry) => entry.event === "labeled" && entry.label?.name === HUMAN_LABEL) ||
    (event.action === "unlabeled" && event.label?.name === HUMAN_LABEL);
  let result;
  if (shouldReapplyHumanValidation({ action: event.action, labels: pr.labels, events })) {
    result = { ok: false, description: "New commit requires human validation again" };
  } else {
    const validationEvent = currentHumanValidationEvent(events, event, pr.head.sha);
    const actor = validationEvent?.actor;
    const memberships = new Map();
    if (required && !labelNames(pr.labels).includes(HUMAN_LABEL) &&
        validationEvent?.event === "unlabeled" && actor?.type === "User" && actor.login) {
      const [owner] = repository.split("/");
      memberships.set(actor.login, await request(
        `/orgs/${encodeURIComponent(owner)}/teams/${OWNERS_TEAM_SLUG}/memberships/${encodeURIComponent(actor.login)}`,
        { tokenEnvironment: "TEAM_MEMBERSHIP_TOKEN", allowNotFound: true },
      ));
    }
    const { validation } = buildGateRecords({ events, event, currentHead: pr.head.sha, memberships });
    result = evaluateHumanValidationGate({
      labels: pr.labels, validationWasRequired: required, currentHead: pr.head.sha, validation,
    });
  }
  if (!result.ok && required && !labelNames(pr.labels).includes(HUMAN_LABEL)) {
    const current = await request(pullPath);
    if (current.head?.sha !== pr.head.sha) throw new Error("PR head changed before label update");
    await request(`/repos/${repository}/issues/${number}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [HUMAN_LABEL] }),
    });
  }
  return result;
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
