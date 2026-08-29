import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { latestBlockerStateRecord } from "./blocker-contract.mjs";
import { extractPrimaryIssueNumbers } from "./pr-gates.mjs";
import {
  coverageCheckFacts,
  selectCoverageCheck,
} from "./review-coverage.mjs";
import { validateAuthorizationRecord } from "./worker-contract.mjs";
import { validateWorkerAttemptRecord } from "./worker-resilience.mjs";

const TRUSTED_OPERATIONS = new Set([
  "auto-merge",
  "blocker-reconcile",
  "claude-issue-review",
  "claude-pr-review",
  "codex-worker",
  "ci",
  "pr-agent-review",
  "pr-gates",
  "workflow-outcome",
]);

const WORKFLOW_OPERATIONS = new Map([
  ["Auto-merge Enrollment", "auto-merge"],
  ["Blocker Reconciler", "blocker-reconcile"],
  ["Claude Issue Review", "claude-issue-review"],
  ["Claude PR Review", "claude-pr-review"],
  ["Codex Worker", "codex-worker"],
  ["CI", "ci"],
  ["PR-Agent Review", "pr-agent-review"],
  ["PR Gates", "pr-gates"],
]);
const WORKFLOW_NAMES_BY_PATH = new Map([
  [".github/workflows/auto-merge.yml", "Auto-merge Enrollment"],
  [".github/workflows/blocker-reconciler.yml", "Blocker Reconciler"],
  [".github/workflows/claude-issue-review.yml", "Claude Issue Review"],
  [".github/workflows/claude-pr-review.yml", "Claude PR Review"],
  [".github/workflows/codex-worker.yml", "Codex Worker"],
  [".github/workflows/ci.yml", "CI"],
  [".github/workflows/pr-agent-review.yml", "PR-Agent Review"],
  [".github/workflows/pr-gates.yml", "PR Gates"],
]);
const POST_MERGE_MARKER = "agent-infra-post-merge-failure";
const GITHUB_ACTIONS_APP_ID = 15_368;
const GATE_PUBLISHER_APP_ID = 4_503_079;
const POST_MERGE_FAILURE_CONCLUSIONS = new Set([
  "failure",
  "startup_failure",
  "timed_out",
]);
const REVIEW_PROVIDER_BY_WORKFLOW = new Map([
  ["Claude PR Review", "claude"],
  ["PR-Agent Review", "pr-agent"],
]);

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function repositoryName(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value ?? "")) {
    throw new Error("GitHub repository is invalid");
  }
  return value;
}

function sourceRunMetadata(value) {
  positiveInteger(value?.id, "Source run id");
  const workflowName = WORKFLOW_NAMES_BY_PATH.get(value?.path);
  if (!workflowName) {
    throw new Error("Source workflow is not trusted");
  }
  if (!/^[a-z_]+$/.test(value?.event ?? "")) {
    throw new Error("Source event is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(value?.head_sha ?? "")) {
    throw new Error("Source head SHA is invalid");
  }
  positiveInteger(value?.run_attempt, "Source run attempt");
  for (const [field, name] of [
    [value?.run_started_at, "Source run start"],
    [value?.updated_at, "Source run completion"],
  ]) {
    if (typeof field !== "string" || !Number.isFinite(Date.parse(field))) {
      throw new Error(`${name} is invalid`);
    }
  }
  if (
    ![
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "startup_failure",
      "success",
      "timed_out",
    ].includes(value?.conclusion)
  ) {
    throw new Error("Source conclusion is invalid");
  }
  return { ...value, workflowName };
}

function targetUrl(repository, targetType, targetNumber) {
  if (targetType === "pr") {
    return `https://github.com/${repository}/pull/${targetNumber}`;
  }
  if (["issue", "target"].includes(targetType)) {
    return `https://github.com/${repository}/issues/${targetNumber}`;
  }
  return `https://github.com/${repository}`;
}

function validatedTarget(target, fallback) {
  const value = target ?? fallback;
  if (
    !["issue", "main", "pr", "reconcile", "repository", "target"].includes(
      value?.type,
    ) ||
    (["issue", "pr", "target"].includes(value.type) &&
      (!Number.isSafeInteger(value.number) || value.number < 1)) ||
    (!["issue", "pr", "target"].includes(value.type) && value.number !== null)
  ) {
    throw new Error("Workflow outcome target is invalid");
  }
  return value;
}

function outcome(code, nextOwner, notify) {
  return { code, nextOwner, notify, terminal: true };
}

function stateExistedWhenRunCompleted(sourceRun, state) {
  if (!state?.recordedAt || !sourceRun.updated_at) return Boolean(state);
  const recordedAt = Date.parse(state.recordedAt);
  const completedAt = Date.parse(sourceRun.updated_at);
  return (
    Number.isFinite(recordedAt) &&
    Number.isFinite(completedAt) &&
    recordedAt <= completedAt
  );
}

export function classifyOutcome({ sourceRun, parsedRunName, context = {} }) {
  if (context.workflowNotRun) {
    return outcome("workflow_not_run", "none", false);
  }
  if (context.postMergeFailure) {
    return outcome("post_merge_failure", "issue-owner", true);
  }
  if (context.reviewCoverage) {
    return outcome("review_coverage_failed", "repository-maintainer", true);
  }
  const attempt = stateExistedWhenRunCompleted(
    sourceRun,
    context.workerAttempt,
  )
    ? context.workerAttempt
    : null;
  if (sourceRun.workflowName === "Codex Worker" && attempt?.outcome === "recoverable") {
    if (attempt.attempt >= 3) {
      return outcome("worker_budget_exhausted", "issue-owner", true);
    }
    return outcome("worker_retry_pending", "automation", false);
  }
  if (sourceRun.workflowName === "Codex Worker" && attempt?.outcome === "non_retryable") {
    return outcome("worker_final_failure", "issue-owner", true);
  }
  if (sourceRun.workflowName === "Codex Worker" && attempt?.outcome === "completed") {
    if (attempt.terminationReason === "human_handoff") {
      return outcome("human_handoff", "issue-owner", true);
    }
    if (attempt.terminationReason === "blocker_proposed") {
      return outcome("blocker_waiting_authorization", "issue-owner", true);
    }
  }
  if (["cancelled", "neutral", "skipped", "stale"].includes(sourceRun.conclusion)) {
    return outcome("workflow_not_run", "none", false);
  }
  if (sourceRun.conclusion !== "success") {
    if (
      sourceRun.workflowName === "CI" &&
      parsedRunName.targetType === "pr" &&
      sourceRun.run_attempt === 1 &&
      context.ciRecoveryEligible
    ) {
      return outcome("ci_failure_pending_recovery", "automation", false);
    }
    return outcome("workflow_terminal_failure", "repository-maintainer", true);
  }

  if (
    sourceRun.workflowName === "Blocker Reconciler" &&
    context.blockerState?.state === "triage" &&
    ["blocker-not-planned", "invalid-blocker-state"].includes(
      context.blockerState.reason,
    )
  ) {
    return outcome("dependency_triage", "issue-owner", true);
  }
  if (
    sourceRun.workflowName === "Blocker Reconciler" &&
    context.blockerState?.state === "frontier" &&
    context.blockerState.reason === "blockers-completed"
  ) {
    return outcome("blocker_resumed", "automation", true);
  }
  if (sourceRun.workflowName === "PR Gates" && context.waiverUsed) {
    return outcome("waiver_used", "repository-maintainer", true);
  }
  if (context.humanValidationPending) {
    return outcome("human_validation_required", "reviewer", true);
  }
  if (context.pullRequestMerged) {
    return outcome("pr_completed", "issue-owner", true);
  }
  if (context.issueCompleted) {
    return outcome("issue_completed", "issue-owner", true);
  }

  return outcome("workflow_completed", "none", false);
}

export function parseSourceRunName(value) {
  if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) {
    throw new Error("Source run-name is not a trusted run-name");
  }
  const parts = value.split(" | ");
  if (parts.length !== 3) {
    throw new Error("Source run-name is not a trusted run-name");
  }
  const [target, operation, action] = parts;
  if (
    !TRUSTED_OPERATIONS.has(operation) ||
    !(/^[a-z][a-z0-9_-]*$/.test(action) || /^source [1-9]\d*$/.test(action))
  ) {
    throw new Error("Source run-name is not a trusted run-name");
  }

  const numberedTarget = /^(PR|Issue|Target) #([1-9]\d*)$/.exec(target);
  if (numberedTarget) {
    return {
      action,
      operation,
      targetNumber: Number(numberedTarget[2]),
      targetType: numberedTarget[1].toLowerCase(),
    };
  }
  if (!["main", "reconcile", "repository"].includes(target)) {
    throw new Error("Source run-name is not a trusted run-name");
  }
  return {
    action,
    operation,
    targetNumber: null,
    targetType: target,
  };
}

function validateSourceRunBinding(sourceRun, parsedRunName) {
  if (WORKFLOW_OPERATIONS.get(sourceRun.workflowName) !== parsedRunName.operation) {
    throw new Error("Source run operation does not match trusted workflow");
  }
  if (!["pull_request", "pull_request_target"].includes(sourceRun.event)) {
    return true;
  }
  const pullRequests = sourceRun.pull_requests;
  if (Array.isArray(pullRequests) && pullRequests.length !== 1) {
    return false;
  }
  if (
    parsedRunName.targetType !== "pr" ||
    !Array.isArray(pullRequests) ||
    pullRequests.length !== 1 ||
    pullRequests[0]?.number !== parsedRunName.targetNumber ||
    !/^[0-9a-f]{40}$/.test(pullRequests[0]?.head?.sha ?? "")
  ) {
    throw new Error(
      "Source pull request target does not match workflow_run metadata",
    );
  }
  return true;
}

export function buildOutcomeRecord({ repository, sourceRun, context = {} }) {
  repositoryName(repository);
  const normalizedSourceRun = sourceRunMetadata(sourceRun);
  const parsed = parseSourceRunName(normalizedSourceRun.display_title);
  const selectedTarget = validatedTarget(context.target, {
    type: parsed.targetType,
    number: parsed.targetNumber,
  });
  const target = {
    ...selectedTarget,
    url: targetUrl(repository, selectedTarget.type, selectedTarget.number),
  };
  const classified = classifyOutcome({
    sourceRun: normalizedSourceRun,
    parsedRunName: parsed,
    context,
  });
  const checkHeadSha = context.checkHeadSha ?? normalizedSourceRun.head_sha;
  if (!/^[0-9a-f]{40}$/.test(checkHeadSha)) {
    throw new Error("Workflow outcome Check Run head SHA is invalid");
  }
  const semanticEventId = context.eventIds?.[classified.code];
  if (
    semanticEventId !== undefined &&
    !/^[A-Za-z0-9._:-]{1,240}$/.test(semanticEventId)
  ) {
    throw new Error("Workflow outcome event id is invalid");
  }
  const reviewCoverage = context.reviewCoverage;
  if (
    reviewCoverage &&
    (!REVIEW_PROVIDER_BY_WORKFLOW.has(normalizedSourceRun.workflowName) ||
      REVIEW_PROVIDER_BY_WORKFLOW.get(normalizedSourceRun.workflowName) !==
        reviewCoverage.provider ||
      !/^[a-z0-9_-]+$/.test(reviewCoverage.reasonCode ?? ""))
  ) {
    throw new Error("Workflow outcome Review Coverage is invalid");
  }
  return {
    version: 1,
    eventId: semanticEventId ?? `workflow-run-${normalizedSourceRun.id}`,
    repository,
    checkHeadSha,
    sourceRun: {
      id: normalizedSourceRun.id,
      workflow: normalizedSourceRun.workflowName,
      event: normalizedSourceRun.event,
      action: context.sourceAction ?? parsed.action,
      headSha: normalizedSourceRun.head_sha,
      conclusion: normalizedSourceRun.conclusion,
      url: `https://github.com/${repository}/actions/runs/${normalizedSourceRun.id}`,
    },
    target,
    cycle: Number.isSafeInteger(context.cycle) ? context.cycle : null,
    attempt: Number.isSafeInteger(context.attempt) ? context.attempt : null,
    ...(reviewCoverage
      ? {
          reviewCoverage: {
            provider: reviewCoverage.provider,
            reasonCode: reviewCoverage.reasonCode,
          },
        }
      : {}),
    outcome: classified,
  };
}

function markdownLink(label, url) {
  return `[${label}](${url})`;
}

export function renderJobSummary(record) {
  const targetLabel = record.target.number
    ? `#${record.target.number}`
    : record.target.type;
  return [
    "## Workflow outcome audit",
    "",
    `- Repository: ${markdownLink(record.repository, `https://github.com/${record.repository}`)}`,
    `- Target: ${markdownLink(targetLabel, record.target.url)}`,
    `- Source run: ${markdownLink(record.sourceRun.id, record.sourceRun.url)}`,
    `- Workflow: ${record.sourceRun.workflow}`,
    `- Event/action: \`${record.sourceRun.event}\` / \`${record.sourceRun.action}\``,
    `- Head SHA: \`${record.checkHeadSha}\``,
    `- Cycle: ${record.cycle ?? "N/A"}`,
    `- Attempt: ${record.attempt ?? "N/A"}`,
    `- Terminal outcome: \`${record.outcome.code}\` (${record.sourceRun.conclusion})`,
    ...(record.reviewCoverage
      ? [
          `- Review provider: \`${record.reviewCoverage.provider}\``,
          `- Coverage reason: \`${record.reviewCoverage.reasonCode}\``,
        ]
      : []),
    `- Next owner: \`${record.outcome.nextOwner}\``,
  ].join("\n");
}

export function renderWeComMessage(record) {
  const target = record.target.number
    ? `${record.target.type.toUpperCase()} #${record.target.number}`
    : record.target.type;
  return [
    "**Agent Infra workflow outcome**",
    `> Repository: [${record.repository}](https://github.com/${record.repository})`,
    `> Target: [${target}](${record.target.url})`,
    `> State: ${record.outcome.code}`,
    ...(record.reviewCoverage
      ? [
          `> Provider: ${record.reviewCoverage.provider}`,
          `> Reason: ${record.reviewCoverage.reasonCode}`,
        ]
      : [`> Reason: ${record.sourceRun.conclusion}`]),
    `> Run: [${record.sourceRun.id}](${record.sourceRun.url})`,
    `> Next owner: ${record.outcome.nextOwner}`,
  ].join("\n");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function sendWeComNotification({
  webhookUrl,
  record,
  fetchImpl = fetch,
  maxAttempts = 3,
  retryDelayMs = 250,
  timeoutMs = 5_000,
}) {
  if (!webhookUrl) {
    return {
      configured: false,
      delivered: false,
      attempts: [],
      warning: "webhook_not_configured",
    };
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    return {
      configured: true,
      delivered: false,
      attempts: [],
      warning: "webhook_invalid",
    };
  }
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    return {
      configured: true,
      delivered: false,
      attempts: [],
      warning: "webhook_invalid",
    };
  }

  const attempts = [];
  const boundedAttempts = Math.min(Math.max(Number(maxAttempts) || 1, 1), 3);
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: { content: renderWeComMessage(record) },
        }),
        signal: controller.signal,
      });
      let businessCode = null;
      try {
        const body = await response.json();
        businessCode = Number.isSafeInteger(body?.errcode) ? body.errcode : null;
      } catch {
        // Response text is intentionally discarded.
      }
      const delivered = response.ok && businessCode === 0;
      attempts.push({
        attempt,
        businessCode,
        httpStatus: response.status,
        status: delivered ? "delivered" : "failed",
      });
      if (delivered) {
        return {
          configured: true,
          delivered: true,
          attempts,
          warning: null,
        };
      }
    } catch (error) {
      attempts.push({
        attempt,
        businessCode: null,
        httpStatus: null,
        status: error?.name === "AbortError" ? "timeout" : "network_error",
      });
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < boundedAttempts && retryDelayMs > 0) {
      await wait(retryDelayMs * attempt);
    }
  }
  return {
    configured: true,
    delivered: false,
    attempts,
    warning: "delivery_failed",
  };
}

function labelsOf(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

function isTrustedAppendOnlyAudit(comment) {
  return Boolean(
    Number.isSafeInteger(comment?.id) &&
      comment.user?.login === "github-actions[bot]" &&
      comment.user.type === "Bot" &&
      comment.performed_via_github_app?.id === GITHUB_ACTIONS_APP_ID &&
      comment.created_at === comment.updated_at,
  );
}

function latestWorkerAttempt(comments) {
  const marker = /^<!-- agent-infra-worker-attempt:([A-Za-z0-9_-]{1,32768}) -->/;
  const records = [];
  for (const comment of comments ?? []) {
    const match = marker.exec(comment.body ?? "");
    if (!match || !isTrustedAppendOnlyAudit(comment)) continue;
    let record;
    try {
      record = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("Worker outcome attempt marker is invalid");
    }
    validateWorkerAttemptRecord(record);
    records.push({ ...record, commentId: comment.id });
  }
  return records.sort((left, right) => left.commentId - right.commentId).at(-1) ?? null;
}

function latestAuthorization(comments) {
  const marker =
    /^<!-- agent-infra-worker-authorization:([A-Za-z0-9_-]{1,32768}) -->/;
  const records = [];
  for (const comment of comments ?? []) {
    const match = marker.exec(comment.body ?? "");
    if (!match || !isTrustedAppendOnlyAudit(comment)) continue;
    let record;
    try {
      record = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("Worker outcome authorization marker is invalid");
    }
    validateAuthorizationRecord(record);
    records.push({ ...record, commentId: comment.id });
  }
  return records.sort((left, right) => left.commentId - right.commentId).at(-1) ?? null;
}

function postMergeRecord({ repository, sourceRun, issueNumber, pullRequestNumber }) {
  return {
    version: 1,
    repository,
    issueNumber,
    pullRequestNumber,
    runId: sourceRun.id,
    headSha: sourceRun.head_sha,
  };
}

function encodeMarker(name, value) {
  return `<!-- ${name}:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")} -->`;
}

function parsePostMergeRecord(comment) {
  if (
    comment?.user?.login !== "github-actions[bot]" ||
    comment.user.type !== "Bot" ||
    comment.performed_via_github_app?.id !== GITHUB_ACTIONS_APP_ID ||
    comment.created_at !== comment.updated_at
  ) {
    return null;
  }
  const match = new RegExp(
    `^<!-- ${POST_MERGE_MARKER}:([A-Za-z0-9_-]{1,4096}) -->`,
  ).exec(comment.body ?? "");
  if (!match) return null;
  try {
    const record = JSON.parse(
      Buffer.from(match[1], "base64url").toString("utf8"),
    );
    if (
      record?.version !== 1 ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository ?? "") ||
      !Number.isSafeInteger(record.issueNumber) ||
      record.issueNumber < 1 ||
      !Number.isSafeInteger(record.pullRequestNumber) ||
      record.pullRequestNumber < 1 ||
      !Number.isSafeInteger(record.runId) ||
      record.runId < 1 ||
      !/^[0-9a-f]{40}$/.test(record.headSha ?? "")
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function samePostMergeEvent(left, right) {
  return Boolean(
    left &&
      left.repository === right.repository &&
      left.issueNumber === right.issueNumber &&
      left.pullRequestNumber === right.pullRequestNumber &&
      left.runId === right.runId &&
      left.headSha === right.headSha,
  );
}

function renderPostMergeAudit(record) {
  return [
    encodeMarker(POST_MERGE_MARKER, record),
    "## Post-merge failure audit",
    "",
    `- Pull request: [#${record.pullRequestNumber}](https://github.com/${record.repository}/pull/${record.pullRequestNumber})`,
    `- Primary Issue: [#${record.issueNumber}](https://github.com/${record.repository}/issues/${record.issueNumber})`,
    `- Failing head: \`${record.headSha}\``,
    `- Failing run: [${record.runId}](https://github.com/${record.repository}/actions/runs/${record.runId})`,
    "- Outcome: `post_merge_failure`",
    "- Next owner: `issue-owner`",
    "- Automatic revert: `disabled`",
  ].join("\n");
}

export async function triagePostMergeFailure({
  repository,
  sourceRun,
  token,
  request,
  paginate,
  defaultBranch,
}) {
  repositoryName(repository);
  sourceRunMetadata(sourceRun);
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (
    sourceRun.event !== "push" ||
    sourceRun.head_branch !== defaultBranch ||
    !POST_MERGE_FAILURE_CONCLUSIONS.has(sourceRun.conclusion) ||
    !defaultBranch
  ) {
    throw new Error("Post-merge triage requires a failed default-branch push");
  }
  const pulls = await request(
    `/repos/${repository}/commits/${sourceRun.head_sha}/pulls`,
    { token },
  );
  const pullRequest = [...(pulls ?? [])]
    .filter(
      (candidate) =>
        candidate?.merged_at &&
        candidate.base?.ref === defaultBranch &&
        candidate.merge_commit_sha === sourceRun.head_sha,
    )
    .sort((left, right) => Date.parse(right.merged_at) - Date.parse(left.merged_at))[0];
  if (!pullRequest) {
    return null;
  }
  const primaryIssues = extractPrimaryIssueNumbers(pullRequest.body ?? "");
  if (primaryIssues.length !== 1) {
    return null;
  }
  const issueNumber = primaryIssues[0];
  const issuePath = `/repos/${repository}/issues/${issueNumber}`;
  let issue = await request(issuePath, { token, allowNotFound: true });
  if (issue?.pull_request || issue?.number !== issueNumber) {
    return null;
  }
  const paginateRequest = paginate ??
    (request === githubRequest
      ? githubPaginate
      : (apiPath, options) => request(apiPath, options));
  const comments = await paginateRequest(`${issuePath}/comments`, {
    token,
    request,
  });
  const record = postMergeRecord({
    repository,
    sourceRun,
    issueNumber,
    pullRequestNumber: pullRequest.number,
  });
  const replay = (comments ?? []).some((comment) =>
    samePostMergeEvent(parsePostMergeRecord(comment), record),
  );

  if (!replay && issue.state !== "open") {
    issue = await request(issuePath, {
      token,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "open" }),
    });
  }
  if (!replay && !labelsOf(issue).includes("needs-triage")) {
    await request(`${issuePath}/labels`, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["needs-triage"] }),
    });
  }
  if (!replay) {
    await request(`${issuePath}/comments`, {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: renderPostMergeAudit(record) }),
    });
  }
  return {
    issueNumber,
    pullRequestNumber: pullRequest.number,
    replay,
  };
}

function existedBy(completedAt, timestamp) {
  if (!completedAt || !timestamp) return true;
  const completed = Date.parse(completedAt);
  const recorded = Date.parse(timestamp);
  return Number.isFinite(completed) && Number.isFinite(recorded) && recorded <= completed;
}

async function loadIssueContext({
  repository,
  issueNumber,
  sourceRun,
  token,
  request,
  paginate,
  allowMissing = false,
}) {
  const issuePath = `/repos/${repository}/issues/${issueNumber}`;
  const issue = await request(issuePath, { token, allowNotFound: allowMissing });
  if (issue?.pull_request || issue?.number !== issueNumber) {
    if (allowMissing) return null;
    throw new Error("Workflow outcome target Issue is invalid");
  }
  const comments = await paginate(`${issuePath}/comments`, { token, request });
  const eligibleComments = (comments ?? []).filter((comment) =>
    existedBy(sourceRun?.updated_at, comment.created_at),
  );
  const eventComments = eligibleComments.filter((comment) => {
    if (!sourceRun?.run_started_at || !comment.created_at) return true;
    const started = Date.parse(sourceRun.run_started_at);
    const recorded = Date.parse(comment.created_at);
    return Number.isFinite(started) && Number.isFinite(recorded) && recorded >= started;
  });
  const workerAttempt = latestWorkerAttempt(eventComments);
  const authorization = latestAuthorization(eligibleComments);
  const blockerState = latestBlockerStateRecord(eventComments, issueNumber);
  const workerEventId = workerAttempt
    ? `worker-attempt-${workerAttempt.workerRunId}-${workerAttempt.attempt}-${workerAttempt.outcome}`
    : null;
  const blockerEventId = blockerState
    ? `blocker-state-${blockerState.signature}`
    : null;
  const issueClosedAt = Date.parse(issue.closed_at ?? "");
  const issueCompletedEventId = Number.isFinite(issueClosedAt)
    ? `issue-completed-${issueNumber}-${issueClosedAt}`
    : null;
  return {
    issue,
    comments,
    issueCompleted: false,
    workerAttempt,
    blockerState,
    cycle: workerAttempt?.cycle ?? authorization?.cycle ?? null,
    attempt: workerAttempt?.attempt ?? null,
    eventIds: {
      ...(workerEventId
        ? {
            blocker_waiting_authorization: workerEventId,
            human_handoff: workerEventId,
            human_validation_required: workerEventId,
            worker_budget_exhausted: workerEventId,
            worker_final_failure: workerEventId,
          }
        : {}),
      ...(blockerEventId
        ? {
            blocker_resumed: blockerEventId,
            dependency_triage: blockerEventId,
          }
        : {}),
      ...(issueCompletedEventId
        ? { issue_completed: issueCompletedEventId }
        : {}),
    },
  };
}

async function loadPullRequestContext({
  repository,
  pullRequestNumber,
  sourceRun,
  parsedRunName,
  defaultBranch,
  token,
  request,
  paginate,
}) {
  const pullRequest = await request(
    `/repos/${repository}/pulls/${pullRequestNumber}`,
    { token },
  );
  if (pullRequest?.number !== pullRequestNumber) {
    throw new Error("Workflow outcome target pull request is invalid");
  }
  const headSha = pullRequest.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(headSha ?? "")) {
    throw new Error("Workflow outcome pull request head is invalid");
  }
  if (
    ["pull_request", "pull_request_target"].includes(sourceRun.event) &&
    sourceRun.pull_requests[0].head.sha !== headSha
  ) {
    return {
      checkHeadSha: sourceRun.pull_requests[0].head.sha,
      target: { type: "pr", number: pullRequestNumber },
      workflowNotRun: true,
    };
  }
  const primaryNumbers = extractPrimaryIssueNumbers(pullRequest.body ?? "");
  let issueContext = {};
  if (primaryNumbers.length === 1) {
    issueContext = (await loadIssueContext({
      repository,
      issueNumber: primaryNumbers[0],
      sourceRun,
      token,
      request,
      paginate,
      allowMissing: true,
    })) ?? {};
  }
  const trustedChecks = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await request(
      `/repos/${repository}/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`,
      { token },
    );
    if (!Array.isArray(response?.check_runs)) {
      throw new Error("Pull request Check Run response is invalid");
    }
    trustedChecks.push(
      ...response.check_runs.filter(
        (check) =>
          Number.isSafeInteger(check?.id) &&
          check.id > 0 &&
          check?.app?.id === GATE_PUBLISHER_APP_ID &&
          check.head_sha === headSha,
      ),
    );
    if (
      response.check_runs.length < 100 ||
      (Number.isSafeInteger(response.total_count) &&
        response.total_count >= 0 &&
        page * 100 >= response.total_count)
    ) {
      break;
    }
    if (page === 20) {
      throw new Error("Pull request Check Run pagination limit exceeded");
    }
  }
  const latestTrustedCheck = (name) =>
    trustedChecks
      .filter((check) => check.name === name)
      .sort((left, right) => right.id - left.id)[0];
  const humanCheck = latestTrustedCheck("Human Validation Gate");
  const claudeCheck = latestTrustedCheck("Claude Review Gate");
  const sourceProvider = REVIEW_PROVIDER_BY_WORKFLOW.get(sourceRun.workflowName);
  const coverageCheck = sourceProvider
    ? selectCoverageCheck(trustedChecks, headSha, pullRequestNumber)
    : null;
  const coverageFacts = coverageCheck
    ? coverageCheckFacts(coverageCheck, headSha)
    : null;
  const reviewCoverage =
    coverageCheck?.conclusion === "failure" &&
    coverageFacts?.provider === sourceProvider
      ? { ...coverageFacts, checkId: coverageCheck.id }
      : null;
  const pullRequestMerged = Boolean(
    parsedRunName.action === "closed" && pullRequest.merged_at,
  );
  const eventIds = {
    ...(issueContext.eventIds ?? {}),
    ...(pullRequestMerged
      ? { pr_completed: `pr-completed-${pullRequestNumber}-${headSha}` }
      : {}),
    ...(humanCheck?.id
      ? { human_validation_required: `human-validation-check-${humanCheck.id}` }
      : {}),
    ...(claudeCheck?.id
      ? { waiver_used: `claude-waiver-check-${claudeCheck.id}` }
      : {}),
    ...(reviewCoverage
      ? {
          review_coverage_failed: `review-coverage-check-${reviewCoverage.checkId}`,
        }
      : {}),
  };
  return {
    ...issueContext,
    pullRequest,
    checkHeadSha: headSha,
    ciRecoveryEligible: Boolean(
      sourceRun.workflowName === "CI" &&
        /^codex\/issue-[1-9]\d*-cycle-[1-9]\d*$/.test(pullRequest.head?.ref ?? "") &&
        pullRequest.state === "open" &&
        !pullRequest.draft &&
        pullRequest.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase() &&
        pullRequest.head?.sha === sourceRun.head_sha &&
        pullRequest.base?.ref === defaultBranch
    ),
    pullRequestMerged,
    humanValidationPending: Boolean(
      labelsOf(issueContext.issue).includes("ready-for-human") &&
        humanCheck?.conclusion !== "success",
    ),
    waiverUsed: Boolean(
      claudeCheck?.output?.summary?.includes(
        "reason_code: waived_infrastructure_failure",
      ),
    ),
    reviewCoverage,
    eventIds,
  };
}

async function loadOutcomeContext({
  repository,
  sourceRun,
  parsedRunName,
  defaultBranch,
  token,
  request,
  paginate,
}) {
  if (parsedRunName.targetType === "issue") {
    const context = await loadIssueContext({
      repository,
      issueNumber: parsedRunName.targetNumber,
      sourceRun,
      token,
      request,
      paginate,
    });
    return {
      ...context,
      issueCompleted: Boolean(
        parsedRunName.action === "closed" && context.issue.state === "closed",
      ),
      humanValidationPending: Boolean(
        sourceRun.workflowName === "Codex Worker" &&
          context.workerAttempt?.outcome === "completed" &&
          context.workerAttempt.terminationReason === "authorized" &&
          labelsOf(context.issue).includes("ready-for-human"),
      ),
    };
  }
  if (parsedRunName.targetType === "pr") {
    return loadPullRequestContext({
      repository,
      pullRequestNumber: parsedRunName.targetNumber,
      sourceRun,
      parsedRunName,
      defaultBranch,
      token,
      request,
      paginate,
    });
  }
  return {};
}

function outcomeExternalId(record) {
  return `agent-infra:workflow-outcome:${record.eventId}:${record.outcome.code}`;
}

function matchingOutcomeChecks(response, record, externalId) {
  return (response?.check_runs ?? [])
    .filter(
      (check) =>
        Number.isSafeInteger(check?.id) &&
        check.id > 0 &&
        check?.app?.id === GITHUB_ACTIONS_APP_ID &&
        check.head_sha === record.checkHeadSha &&
        check.external_id === externalId,
    )
    .sort((left, right) => left.id - right.id);
}

async function loadMatchingOutcomeChecks({
  repository,
  record,
  externalId,
  token,
  request,
}) {
  const matches = [];
  for (let page = 1; page <= 20; page += 1) {
    const path = `/repos/${repository}/commits/${record.checkHeadSha}/check-runs?check_name=Workflow%20Outcome&filter=all&per_page=100&page=${page}`;
    const response = await request(path, { token });
    if (!Array.isArray(response?.check_runs)) {
      throw new Error("Workflow outcome Check Run response is invalid");
    }
    matches.push(...matchingOutcomeChecks(response, record, externalId));
    if (
      response.check_runs.length < 100 ||
      (Number.isSafeInteger(response.total_count) &&
        response.total_count >= 0 &&
        page * 100 >= response.total_count)
    ) {
      return matches.sort((left, right) => left.id - right.id);
    }
  }
  throw new Error("Workflow outcome Check Run pagination limit exceeded");
}

async function claimOutcomeCheck({ repository, record, token, request }) {
  const externalId = outcomeExternalId(record);
  const existing = (
    await loadMatchingOutcomeChecks({
      repository,
      record,
      externalId,
      token,
      request,
    })
  )[0];
  if (existing) {
    return {
      checkId: existing.id,
      incompleteClaim: existing.status !== "completed",
      replay: existing.status === "completed",
    };
  }
  const created = await request(`/repos/${repository}/check-runs`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Workflow Outcome",
      head_sha: record.checkHeadSha,
      details_url: record.sourceRun.url,
      external_id: externalId,
      status: "in_progress",
      output: {
        title: `Workflow outcome: ${record.outcome.code}`,
        summary: renderJobSummary(record),
      },
    }),
  });
  positiveInteger(created?.id, "Workflow outcome Check Run id");
  const candidates = new Map([[created.id, created]]);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await wait(50);
    const confirmation = await loadMatchingOutcomeChecks({
      repository,
      record,
      externalId,
      token,
      request,
    });
    for (const check of confirmation) {
      candidates.set(check.id, check);
    }
  }
  const canonicalClaim = [...candidates.values()].sort(
    (left, right) => left.id - right.id,
  )[0];
  if (canonicalClaim.id !== created.id) {
    return {
      checkId: created.id,
      duplicateClaim: true,
      incompleteClaim: false,
      replay: false,
    };
  }
  return { checkId: created.id, incompleteClaim: false, replay: false };
}

function notificationSummary(notification) {
  const status = notification.warning ??
    (notification.delivered ? "delivered" : "not_required");
  const attempts = notification.attempts?.length ?? 0;
  return [
    "",
    "## Notification delivery",
    "",
    `- Notification: \`${status}\``,
    `- Attempts: ${attempts}`,
  ].join("\n");
}

async function completeOutcomeCheck({
  repository,
  checkId,
  record,
  notification,
  token,
  request,
}) {
  await request(`/repos/${repository}/check-runs/${checkId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      conclusion: notification.delivered ? "success" : "neutral",
      output: {
        title: `Workflow outcome: ${record.outcome.code}`,
        summary: `${renderJobSummary(record)}${notificationSummary(notification)}`,
      },
    }),
  });
}

export async function githubRequest(
  apiPath,
  { token, method = "GET", headers = {}, body, allowNotFound = false } = {},
) {
  if (!apiPath.startsWith("/")) throw new Error("GitHub API path is invalid");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
    body,
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function githubPaginate(
  apiPath,
  { token, request = githubRequest } = {},
) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const batch = await request(
      `${apiPath}${separator}per_page=100&page=${page}`,
      { token },
    );
    if (!Array.isArray(batch)) {
      throw new Error("GitHub paginated response is invalid");
    }
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub API pagination limit exceeded for ${apiPath}`);
}

async function appendJobSummary(value) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) throw new Error("GITHUB_STEP_SUMMARY is required");
  await fs.appendFile(summaryPath, `${value}\n`, "utf8");
}

export async function processWorkflowOutcome({
  event,
  token,
  webhookUrl,
  request = githubRequest,
  paginate,
  sendNotification = sendWeComNotification,
  writeSummary = appendJobSummary,
}) {
  if (event?.action !== "completed" || !event.workflow_run) {
    throw new Error("Workflow Outcome requires a completed workflow_run event");
  }
  const repository = repositoryName(event.repository?.full_name);
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const sourceRun = sourceRunMetadata(event.workflow_run);
  const parsedRunName = parseSourceRunName(sourceRun.display_title);
  const sourceRunBound = validateSourceRunBinding(sourceRun, parsedRunName);
  const paginateRequest = paginate ??
    (request === githubRequest
      ? githubPaginate
      : (apiPath, options) => request(apiPath, options));
  let context;
  if (!sourceRunBound) {
    context = {
      sourceAction: "unbound",
      target: { type: "repository", number: null },
      workflowNotRun: true,
    };
  } else if (
    sourceRun.workflowName === "CI" &&
    parsedRunName.targetType === "main" &&
    POST_MERGE_FAILURE_CONCLUSIONS.has(sourceRun.conclusion)
  ) {
    const triage = await triagePostMergeFailure({
      repository,
      sourceRun,
      token,
      request,
      paginate: paginateRequest,
      defaultBranch: event.repository.default_branch,
    });
    if (triage) {
      const issueContext = await loadIssueContext({
        repository,
        issueNumber: triage.issueNumber,
        sourceRun,
        token,
        request,
        paginate: paginateRequest,
      });
      context = {
        ...issueContext,
        postMergeFailure: true,
        target: { type: "issue", number: triage.issueNumber },
        eventIds: {
          ...(issueContext.eventIds ?? {}),
          post_merge_failure: `post-merge-run-${sourceRun.id}`,
        },
      };
    } else {
      context = {};
    }
  } else {
    context = await loadOutcomeContext({
      repository,
      sourceRun,
      parsedRunName,
      defaultBranch: event.repository.default_branch,
      token,
      request,
      paginate: paginateRequest,
    });
  }
  const record = buildOutcomeRecord({ repository, sourceRun, context });
  let replay = false;
  let notification = {
    configured: Boolean(webhookUrl),
    delivered: false,
    attempts: [],
    warning: "not_required",
  };
  let checkId = null;
  if (record.outcome.notify) {
    const claim = await claimOutcomeCheck({ repository, record, token, request });
    checkId = claim.checkId;
    if (claim.duplicateClaim) {
      replay = true;
      notification = {
        configured: Boolean(webhookUrl),
        delivered: false,
        attempts: [],
        warning: "deduplicated",
      };
      await completeOutcomeCheck({
        repository,
        checkId,
        record,
        notification,
        token,
        request,
      });
    } else if (claim.incompleteClaim) {
      throw new Error(
        `Notification claim ${claim.checkId} is incomplete and requires recovery`,
      );
    } else if (claim.replay) {
      replay = true;
      notification = {
        configured: Boolean(webhookUrl),
        delivered: false,
        attempts: [],
        warning: "deduplicated",
      };
    } else {
      notification = await sendNotification({ webhookUrl, record });
      await completeOutcomeCheck({
        repository,
        checkId,
        record,
        notification,
        token,
        request,
      });
    }
  }
  const summary = `${renderJobSummary(record)}${notificationSummary(notification)}`;
  await writeSummary(summary);
  return { record, notification, replay, checkId };
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const result = await processWorkflowOutcome({
    event,
    token: process.env.GITHUB_TOKEN,
    webhookUrl: process.env.WECOM_BOT_WEBHOOK_URL,
  });
  console.log(
    `Workflow outcome: ${result.record.outcome.code}; notification=${result.notification.warning ?? "delivered"}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
