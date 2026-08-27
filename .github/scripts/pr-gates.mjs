import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  GATE_PUBLISHER_APP_ID,
  gateExternalId,
  selectCurrentGateCheck,
} from "./check-run-contract.mjs";
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

export function parseGateCommand(body = "") {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 8 * 1024) return null;
  const match = body
    .trim()
    .match(
      /^\/(human-validation|claude-review-waiver) ([0-9a-f]{40})\r?\n([^\u0000]{1,4000})$/,
    );
  if (!match) return null;
  const reason = match[3].trim();
  if (!reason) return null;
  return { type: match[1], headSha: match[2], reason };
}

export function buildGateRecords({ comments = [], currentHead, memberships = new Map() }) {
  const records = { confirmations: [], waivers: [] };
  for (const comment of comments) {
    const command = parseGateCommand(comment.body);
    const login = comment.user?.login;
    if (!command || command.headSha !== currentHead || !login) continue;
    const record = {
      actor: { login, type: comment.user?.type },
      headSha: command.headSha,
      membership: memberships.get(login),
      reason: command.reason,
      recordedAt: comment.updated_at ?? comment.created_at,
      url: comment.html_url,
    };
    if (command.type === "human-validation") records.confirmations.push(record);
    if (command.type === "claude-review-waiver") records.waivers.push(record);
  }
  return records;
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
  confirmations = [],
}) {
  const required = validationWasRequired || labelNames(labels).includes(HUMAN_LABEL);
  if (!required) {
    return {
      ok: true,
      removeLabel: false,
      description: "Human validation is not required",
    };
  }
  const confirmation = confirmations.find(
    (candidate) =>
      candidate.headSha === currentHead &&
      boundedCheckValue(candidate.reason, 4_000) &&
      isActiveTeamMember(candidate),
  );
  if (!confirmation) {
    return {
      ok: false,
      removeLabel: false,
      description: "Current-head Team validation confirmation is required",
    };
  }
  return {
    ok: true,
    removeLabel: labelNames(labels).includes(HUMAN_LABEL),
    description: `Human validation confirmed by ${confirmation.actor.login} for current head`,
  };
}

export function evaluateClaudeReviewGate({
  currentHead,
  review,
  waivers = [],
  hasPublishedBlockingFinding = false,
  hasUnresolvedThread = false,
  publishedBlockingFindingCount = 0,
}) {
  if (hasPublishedBlockingFinding) {
    return {
      ok: false,
      waived: false,
      reasonCode: "blocking_finding",
      description: "P0/P1 finding cannot be waived",
    };
  }
  if (hasUnresolvedThread) {
    return {
      ok: false,
      waived: false,
      reasonCode: "unresolved_thread",
      description: "Blocking Review thread is unresolved",
    };
  }
  if (
    !review ||
    review.headSha !== currentHead ||
    review.appId !== GATE_PUBLISHER_APP_ID ||
    review.status !== "completed"
  ) {
    return {
      ok: false,
      waived: false,
      description: "Current-head Claude Review has not completed",
    };
  }
  const hasRecordedBlockingFindings =
    review.reasonCode === "blocking_finding" ||
    review.blockingFindingCount !== undefined;
  if (
    hasRecordedBlockingFindings &&
    (!Number.isSafeInteger(review.blockingFindingCount) ||
      review.blockingFindingCount < 1 ||
      publishedBlockingFindingCount !== review.blockingFindingCount)
  ) {
    return {
      ok: false,
      waived: false,
      reasonCode: "blocking_finding",
      description: "Blocking Review finding evidence is incomplete",
    };
  }
  const reviewSucceededBeforeThreadState =
    (review.conclusion === "success" &&
      ["success", "disabled"].includes(review.reasonCode)) ||
    (review.conclusion === "failure" &&
      ["blocking_finding", "unresolved_thread"].includes(review.reasonCode));
  if (reviewSucceededBeforeThreadState) {
    return {
      ok: true,
      waived: false,
      description: "Claude Review passed for current head",
    };
  }
  const waivableInfrastructureFailure =
    review.failureKind === "infrastructure_failure" &&
    ((review.conclusion === "failure" &&
      review.reasonCode === "infrastructure_failure") ||
      (review.conclusion === "success" &&
        review.reasonCode === "waived_infrastructure_failure"));
  if (!waivableInfrastructureFailure) {
    return {
      ok: false,
      waived: false,
      description: "Claude Review failure is not waivable",
    };
  }
  const waiver = waivers.find(
    (candidate) =>
      candidate.headSha === currentHead &&
      boundedCheckValue(candidate.reason, 4_000) &&
      isActiveTeamMember(candidate),
  );
  if (!waiver) {
    return {
      ok: false,
      waived: false,
      description: "Current-head Team infrastructure waiver is required",
    };
  }
  return {
    ok: true,
    waived: true,
    description: `Claude Review infrastructure failure waived by ${waiver.actor.login} for current head`,
  };
}

export function buildReviewState({
  checkRuns = [],
  threads = [],
  currentHead,
  prNumber,
}) {
  const check = selectCurrentGateCheck(checkRuns, {
    name: "Claude Review Gate",
    headSha: currentHead,
    prNumber,
  });
  const reasonCode = check?.output?.summary?.match(
    /(?:^|\n)reason_code: (success|disabled|infrastructure_failure|invalid_output|waived_infrastructure_failure|blocking_finding|unresolved_thread)(?:\n|$)/,
  )?.[1];
  const marker = `<!-- agent-infra-claude-review:${currentHead}:`;
  const blockingFindingCountText = check?.output?.summary?.match(
    /(?:^|\n)blocking_finding_count: ([1-9][0-9]*)(?:\n|$)/,
  )?.[1];
  const blockingFindingCount = blockingFindingCountText
    ? Number(blockingFindingCountText)
    : null;
  const publishedBlockingFindingThreads = threads.filter((thread) =>
    (thread.comments?.nodes ?? []).some(
      (comment) =>
        /^github-actions(?:\[bot\])?$/.test(comment.author?.login ?? "") &&
        /^\*\*P[01]:/.test(comment.body ?? "") &&
        comment.body?.includes(marker),
    ),
  );
  return {
    review: check
      ? {
          appId: check.app.id,
          checkRunId: check.id,
          conclusion: check.conclusion,
          failureKind: ["infrastructure_failure", "waived_infrastructure_failure"].includes(
            reasonCode,
          )
            ? "infrastructure_failure"
            : reasonCode === "invalid_output"
              ? "invalid_output"
              : null,
          headSha: check.head_sha,
          reasonCode: reasonCode ?? null,
          status: check.status,
          ...(blockingFindingCountText
            ? { blockingFindingCount }
            : {}),
        }
      : undefined,
    hasPublishedBlockingFinding: publishedBlockingFindingThreads.some(
      (thread) => !thread.isResolved,
    ),
    hasUnresolvedThread: threads.some((thread) => !thread.isResolved),
    ...(blockingFindingCountText
      ? { publishedBlockingFindingCount: publishedBlockingFindingThreads.length }
      : {}),
  };
}

export function claudeReviewGateUpdate({ result, review }) {
  if (result?.waived) {
    return {
      conclusion: "success",
      description: result.description,
      reasonCode: "waived_infrastructure_failure",
    };
  }
  if (!result?.ok && review?.reasonCode === "waived_infrastructure_failure") {
    return {
      conclusion: "failure",
      description: result.description,
      reasonCode: "infrastructure_failure",
    };
  }
  const threadFailureReason = ["blocking_finding", "unresolved_thread"].includes(
    result?.reasonCode,
  )
    ? result.reasonCode
    : null;
  if (
    !result?.ok &&
    threadFailureReason &&
    ["success", "disabled", "blocking_finding", "unresolved_thread"].includes(
      review?.reasonCode,
    )
  ) {
    return {
      conclusion: "failure",
      description: result.description,
      reasonCode: threadFailureReason,
      ...(Number.isSafeInteger(review?.blockingFindingCount)
        ? { blockingFindingCount: review.blockingFindingCount }
        : {}),
    };
  }
  if (
    result?.ok &&
    ["blocking_finding", "unresolved_thread"].includes(review?.reasonCode)
  ) {
    return {
      conclusion: "success",
      description: result.description,
      reasonCode: "success",
      ...(Number.isSafeInteger(review?.blockingFindingCount)
        ? { blockingFindingCount: review.blockingFindingCount }
        : {}),
    };
  }
  return null;
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

export async function githubRequest(
  path,
  { allowNotFound = false, tokenEnvironment = "GITHUB_TOKEN", ...options } = {},
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
  if (allowNotFound && response.status === 404) return null;
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

async function githubGraphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${response.status}`);
  }
  return payload.data;
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
  reasonCode,
  blockingFindingCount,
) {
  const blockingFindingCountLine =
    Number.isSafeInteger(blockingFindingCount) && blockingFindingCount > 0
      ? `\nblocking_finding_count: ${blockingFindingCount}`
      : "";
  await gateCheckRequest(`/repos/${repository}/check-runs/${check.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      conclusion,
      output: {
        title: `${check.name}: ${conclusion}`,
        summary: reasonCode
          ? `reason_code: ${reasonCode}${blockingFindingCountLine}\n\n${description}`
          : description,
      },
    }),
  });
}

async function readGateRecords(repository, prNumber, currentHead) {
  const comments = await paginate(`/repos/${repository}/issues/${prNumber}/comments`);
  const logins = new Set();
  for (const comment of comments) {
    const command = parseGateCommand(comment.body);
    if (command?.headSha === currentHead && comment.user?.login) {
      logins.add(comment.user.login);
    }
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
  return buildGateRecords({ comments, currentHead, memberships });
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

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            isResolved
            comments(first: 100) {
              nodes {
                author { login }
                body
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

async function readReviewState(repository, prNumber, currentHead) {
  const encodedName = encodeURIComponent("Claude Review Gate");
  const checks = await githubRequest(
    `/repos/${repository}/commits/${currentHead}/check-runs?check_name=${encodedName}&filter=latest&per_page=100`,
  );
  const [owner, name] = repository.split("/");
  const threads = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await githubGraphql(REVIEW_THREADS_QUERY, {
      owner,
      name,
      number: prNumber,
      after,
    });
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error("Pull Request Review threads are unavailable");
    threads.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) {
      return buildReviewState({
        checkRuns: checks.check_runs,
        threads,
        currentHead,
        prNumber,
      });
    }
    after = connection.pageInfo.endCursor;
  }
  throw new Error("Review thread pagination limit exceeded");
}

function validationWasRequired(labels, events) {
  return (
    labelNames(labels).includes(HUMAN_LABEL) ||
    events.some((event) => event.event === "labeled" && event.label?.name === HUMAN_LABEL)
  );
}

export function auditDescription(result, records, type) {
  if (!result.ok) return result.description;
  const candidates = type === "human-validation" ? records.confirmations : records.waivers;
  const expectedDescription = (login) =>
    type === "human-validation"
      ? `Human validation confirmed by ${login} for current head`
      : `Claude Review infrastructure failure waived by ${login} for current head`;
  const record = candidates.find(
    (candidate) =>
      candidate.headSha && result.description === expectedDescription(candidate.actor.login),
  );
  if (!record) return result.description;
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

async function evaluatePullRequestWithChecks(repository, number, action, pr, checks) {
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
  const records = await readGateRecords(repository, number, pr.head.sha);
  const humanResult = evaluateHumanValidationGate({
    labels,
    validationWasRequired: validationWasRequired(labels, events),
    currentHead: pr.head.sha,
    confirmations: records.confirmations,
  });
  if (humanResult.ok && humanResult.removeLabel) {
    await githubRequest(
      `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(HUMAN_LABEL)}`,
      { method: "DELETE", allowNotFound: true },
    );
    labels = labels.filter((label) => label.name !== HUMAN_LABEL);
  } else if (
    !humanResult.ok &&
    validationWasRequired(labels, events) &&
    !labelNames(labels).includes(HUMAN_LABEL)
  ) {
    await githubRequest(`/repos/${repository}/issues/${number}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [HUMAN_LABEL] }),
    });
    labels = [...labels, { name: HUMAN_LABEL }];
  }
  const reviewState = await readReviewState(repository, number, pr.head.sha);
  const claudeResult = evaluateClaudeReviewGate({
    currentHead: pr.head.sha,
    review: reviewState.review,
    waivers: records.waivers,
    hasPublishedBlockingFinding: reviewState.hasPublishedBlockingFinding,
    hasUnresolvedThread: reviewState.hasUnresolvedThread,
    publishedBlockingFindingCount: reviewState.publishedBlockingFindingCount,
  });

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
      auditDescription(humanResult, records, "human-validation"),
    ),
  ]);
  const reviewUpdate = claudeReviewGateUpdate({
    result: claudeResult,
    review: reviewState.review,
  });
  if (reviewUpdate && reviewState.review?.checkRunId) {
    await completeCheckRun(
      repository,
      { id: reviewState.review.checkRunId, name: "Claude Review Gate" },
      reviewUpdate.conclusion,
      reviewUpdate.conclusion === "success"
        ? auditDescription(claudeResult, records, "claude-review-waiver")
        : reviewUpdate.description,
      reviewUpdate.reasonCode,
      reviewUpdate.blockingFindingCount,
    );
  }
}

async function evaluatePullRequest(repository, number, action) {
  const pr = await githubRequest(`/repos/${repository}/pulls/${number}`);
  const checks = await setPendingChecks(repository, pr);
  try {
    await evaluatePullRequestWithChecks(repository, number, action, pr, checks);
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
    await evaluatePullRequest(repository, event.pull_request.number, event.action);
    return;
  }

  if (eventName === "issue_comment" && event.issue?.pull_request) {
    await evaluatePullRequest(repository, event.issue.number, "comment-updated");
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
