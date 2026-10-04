import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { gateExternalId } from "./check-run-contract.mjs";
import {
  blockerStatus,
  hydrateNativeDependencies,
  validatedExecutionIssue,
} from "./blocker-contract.mjs";
import {
  activeAuthorization,
  executionContent,
  latestAuthorizationRecord,
  parseAcceptanceCriteriaEvidence,
  parseAuthorizationRecords,
  WORKER_OWNERS_TEAM_SLUG,
} from "./worker-contract.mjs";

const HUMAN_LABEL = "ready-for-human";
const CLOSE_KEYWORD = /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gim;

function labelNames(labels = []) {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

export function extractPrimaryIssueNumbers(body = "") {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(CLOSE_KEYWORD)].map((match) => Number(match[1]));
}

export function affectedPullRequests({ eventName, issueNumber, pulls = [] }) {
  if (eventName === "schedule") return pulls;
  if (["issues", "issue_comment"].includes(eventName)) {
    return pulls.filter((pr) =>
      extractPrimaryIssueNumbers(pr.body ?? "").includes(issueNumber),
    );
  }
  throw new Error(`Unsupported PR Gate dispatch event: ${eventName}`);
}

export function evaluateIssueGate({
  issueNumbers,
  issue,
  headRef,
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

  const workerBranch = /^codex\/issue-(\d+)-cycle-(\d+)$/.exec(headRef ?? "");
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

export function evaluateIssueReadinessGate({
  repository,
  defaultBranch,
  pullRequest,
  issue,
  blockers = [],
  workerPullRequests = [],
  contract,
  authorizationRecord,
}) {
  const headRef = pullRequest?.head?.ref ?? "";
  if (!headRef.startsWith("codex/issue-")) {
    return {
      ok: true,
      applicable: false,
      description: "not_applicable: human-authored PR",
    };
  }
  const branch = /^codex\/issue-(\d+)-cycle-(\d+)$/.exec(headRef);
  if (!branch) {
    return { ok: false, applicable: true, description: "Worker branch name is invalid" };
  }
  const issueNumber = Number(branch[1]);
  const cycle = Number(branch[2]);
  if (issue?.number !== issueNumber || issue?.state !== "open") {
    return {
      ok: false,
      applicable: true,
      description: `Worker primary Issue #${issueNumber} is not open`,
    };
  }
  const authorization = activeAuthorization({
    issue,
    contract,
    record: authorizationRecord,
  });
  if (!authorization.ok || authorization.cycle !== cycle) {
    return {
      ok: false,
      applicable: true,
      description: `Worker authorization is invalid: ${authorization.reason}`,
    };
  }
  if (blockers.some((blocker) => blockerStatus(blocker) !== "completed")) {
    return {
      ok: false,
      applicable: true,
      description: "Worker Issue has an unfinished blocker",
    };
  }
  if (
    pullRequest.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() ||
    pullRequest.base?.ref !== defaultBranch
  ) {
    return {
      ok: false,
      applicable: true,
      description: "Worker PR ownership is invalid",
    };
  }
  const activePullRequests = workerPullRequests.filter(
    (candidate) => candidate.state === "open" && !candidate.merged_at,
  );
  if (
    activePullRequests.length !== 1 ||
    activePullRequests[0].number !== pullRequest.number ||
    activePullRequests[0].head?.ref !== headRef
  ) {
    return {
      ok: false,
      applicable: true,
      description: "Worker cycle must own exactly one active PR",
    };
  }
  try {
    parseAcceptanceCriteriaEvidence(
      pullRequest.body ?? "",
      contract.acceptanceCriteriaIds,
    );
  } catch (error) {
    return {
      ok: false,
      applicable: true,
      description: error instanceof Error ? error.message : "Worker AC evidence is invalid",
    };
  }
  return {
    ok: true,
    applicable: true,
    description: `Worker Issue #${issueNumber} cycle ${cycle} is ready for review`,
  };
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

export function buildCheckRunPayload({
  name,
  headSha,
  prNumber,
  status,
  conclusion,
  description,
  targetUrl,
}) {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("Check Run head SHA is invalid");
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error("Check Run PR number is invalid");
  }
  if (!boundedCheckValue(name, 100) || !boundedCheckValue(description, 65_535)) {
    throw new Error("Check Run output is invalid");
  }
  if (!["queued", "in_progress", "completed"].includes(status)) {
    throw new Error("Check Run status is invalid");
  }
  if ((status === "completed") !== Boolean(conclusion)) {
    throw new Error("Check Run conclusion does not match status");
  }
  return {
    name,
    head_sha: headSha,
    status,
    ...(conclusion ? { conclusion } : {}),
    details_url: targetUrl,
    external_id: gateExternalId({ name, headSha, prNumber }),
    output: {
      title: `${name}: ${conclusion ?? status}`,
      summary: description,
    },
  };
}

function boundedCheckValue(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(
  path,
  { tokenEnvironment = "GITHUB_TOKEN", ...options } = {},
) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment(tokenEnvironment)}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path}: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function gateCheckRequest(path, options = {}) {
  return githubRequest(path, {
    ...options,
    tokenEnvironment: "GATE_CHECK_TOKEN",
  });
}

async function teamRequest(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("TEAM_MEMBERSHIP_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub Team API GET ${path}: ${response.status}`);
  return response.json();
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

async function createCheckRun(repository, payload) {
  return gateCheckRequest(`/repos/${repository}/check-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function completeCheckRun(
  repository,
  check,
  conclusion,
  description,
) {
  await gateCheckRequest(`/repos/${repository}/check-runs/${check.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      conclusion,
      output: {
        title: `${check.name}: ${conclusion}`,
        summary: description,
      },
    }),
  });
}

async function readGateRecords(repository, currentHead, events, event) {
  const logins = new Set();
  const validationEvent = currentHumanValidationEvent(events, event, currentHead);
  if (validationEvent?.event === "unlabeled" && validationEvent.actor?.login) {
    logins.add(validationEvent.actor.login);
  }
  const [owner] = repository.split("/");
  const memberships = new Map(
    await Promise.all(
      [...logins].map(async (login) => [
        login,
        await teamRequest(
          `/orgs/${encodeURIComponent(owner)}/teams/${WORKER_OWNERS_TEAM_SLUG}/memberships/${encodeURIComponent(login)}`,
        ),
      ]),
    ),
  );
  return buildGateRecords({ events, event, currentHead, memberships });
}

async function readIssueReadinessState(repository, pullRequest, issue) {
  if (!pullRequest.head?.ref?.startsWith("codex/issue-")) return {};
  const [comments, timelineEvents, issues, pullRequests] = await Promise.all([
    paginate(`/repos/${repository}/issues/${issue.number}/comments`),
    paginate(`/repos/${repository}/issues/${issue.number}/events`),
    paginate(`/repos/${repository}/issues?state=all`),
    paginate(`/repos/${repository}/pulls?state=all`),
  ]);
  const targetIndex = issues.findIndex((candidate) => candidate.number === issue.number);
  if (targetIndex >= 0) issues[targetIndex] = { ...issues[targetIndex], ...issue };
  const nativeDependencies = await hydrateNativeDependencies(issues, (candidate) =>
    paginate(
      `/repos/${repository}/issues/${candidate.number}/dependencies/blocked_by`,
    ),
  );
  const graphState = validatedExecutionIssue(issues, issue.number, {
    nativeDependencies,
  });
  const contract = executionContent(issue, {
    blockerNumbers: graphState.blockerNumbers,
  });
  const records = parseAuthorizationRecords(
    comments,
    issue.number,
    timelineEvents,
  );
  const pattern = new RegExp(
    `^codex/issue-${issue.number}-cycle-[1-9][0-9]*$`,
  );
  return {
    contract,
    blockers: graphState.blockers,
    authorizationRecord: latestAuthorizationRecord(records),
    workerPullRequests: pullRequests.filter((candidate) =>
      pattern.test(candidate.head?.ref ?? ""),
    ),
  };
}

function validationWasRequired(labels, events) {
  return (
    labelNames(labels).includes(HUMAN_LABEL) ||
    events.some((event) => event.event === "labeled" && event.label?.name === HUMAN_LABEL)
  );
}

export function auditDescription(result, records) {
  if (!result.ok) return result.description;
  const record = records.validation;
  if (
    !record?.headSha ||
    result.description !== `Human validation confirmed by ${record.actor.login} for current head`
  ) {
    return result.description;
  }
  const reason = record.reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;")
    .replaceAll("@", "@\u200b")
    .slice(0, 4_000);
  return (
    `${result.description}\n\nReason: ${reason}\n\n` +
    `Recorded at: ${record.recordedAt}\n\nEvidence: ${record.url}`
  );
}

export function pendingGateNames() {
  return ["Issue Gate", "Issue Readiness Gate", "Human Validation Gate"];
}

async function setPendingChecks(repository, pr) {
  const names = pendingGateNames();
  const checks = await Promise.all(
    names.map((name) =>
      createCheckRun(
        repository,
        buildCheckRunPayload({
          name,
          headSha: pr.head.sha,
          prNumber: pr.number,
          status: "in_progress",
          description: "Re-evaluating current-head gate",
          targetUrl: pr.html_url,
        }),
      ),
    ),
  );
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

async function evaluatePullRequestWithChecks(repository, number, action, pr, checks, event) {
  requiredEnvironment("TEAM_MEMBERSHIP_TOKEN");
  let labels = pr.labels;
  const events = await paginate(`/repos/${repository}/issues/${number}/events`);
  if (action === "synchronize" && !labelNames(labels).includes(HUMAN_LABEL)) {
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
    pullRequestCreatedAt: pr.created_at,
  });
  let issueReadinessResult;
  try {
    const readinessState = issue
      ? await readIssueReadinessState(repository, pr, issue)
      : {};
    issueReadinessResult = evaluateIssueReadinessGate({
      repository,
      defaultBranch: pr.base.ref,
      pullRequest: pr,
      issue,
      ...readinessState,
    });
  } catch {
    issueReadinessResult = {
      ok: false,
      applicable: pr.head.ref.startsWith("codex/issue-"),
      description: "Issue Readiness evaluation failed closed",
    };
  }
  const records = await readGateRecords(repository, pr.head.sha, events, event);
  const humanValidationRequired =
    validationWasRequired(labels, events) ||
    (event?.action === "unlabeled" && event.label?.name === HUMAN_LABEL);
  const humanResult = evaluateHumanValidationGate({
    labels,
    validationWasRequired: humanValidationRequired,
    currentHead: pr.head.sha,
    validation: records.validation,
  });
  if (
    !humanResult.ok &&
    humanValidationRequired &&
    !labelNames(labels).includes(HUMAN_LABEL)
  ) {
    await githubRequest(`/repos/${repository}/issues/${number}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [HUMAN_LABEL] }),
    });
    labels = [...labels, { name: HUMAN_LABEL }];
  }
  await Promise.all([
    completeCheckRun(
      repository,
      checks["Issue Gate"],
      issueResult.ok ? "success" : "failure",
      issueResult.description,
    ),
    completeCheckRun(
      repository,
      checks["Issue Readiness Gate"],
      issueReadinessResult.ok ? "success" : "failure",
      issueReadinessResult.description,
    ),
    completeCheckRun(
      repository,
      checks["Human Validation Gate"],
      humanResult.ok ? "success" : "failure",
      auditDescription(humanResult, records),
    ),
  ]);
}

async function evaluatePullRequest(repository, number, action, event) {
  const pr = await githubRequest(`/repos/${repository}/pulls/${number}`);
  const checks = await setPendingChecks(repository, pr);
  try {
    await evaluatePullRequestWithChecks(repository, number, action, pr, checks, event);
  } catch (error) {
    await Promise.allSettled(
      pendingGateNames().map((name) =>
        completeCheckRun(
          repository,
          checks[name],
          "failure",
          "PR Gate evaluation failed closed",
        ),
      ),
    );
    throw error;
  }
}

async function main() {
  const event = JSON.parse(await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"));
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");

  if (eventName === "pull_request_target") {
    await evaluatePullRequest(repository, event.pull_request.number, event.action, event);
    return;
  }

  if (eventName === "issue_comment" && event.issue?.pull_request) {
    return;
  }

  if (
    eventName === "issues" ||
    eventName === "schedule" ||
    (eventName === "issue_comment" && !event.issue?.pull_request)
  ) {
    const pulls = await paginate(`/repos/${repository}/pulls?state=open`);
    const affected = affectedPullRequests({
      eventName,
      issueNumber: event.issue?.number,
      pulls,
    });
    await Promise.all(
      affected.map(async (pr) => {
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
    await evaluatePullRequest(
      repository,
      Number(event.client_payload.pr_number),
      "issue-updated",
      event,
    );
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
