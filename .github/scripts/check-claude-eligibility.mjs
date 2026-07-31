import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  githubRequest,
  hasWritePermission,
  isBot,
  paginate,
  requireEnv,
  validateRepository,
  writeOutputs,
} from "./github-api.mjs";

const REVIEW_REQUEST_WORKFLOW = "Claude Review Request";
const REVIEW_REQUEST_PATH = ".github/workflows/claude-review-request.yml";
const REVIEW_REQUEST_JOB = "Request Claude Review";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_SOURCE_JOBS = 1_000;

function reviewIneligible(reason) {
  return {
    eligible: false,
    reason,
    prNumber: 0,
    headSha: "",
    actor: "",
  };
}

function assistantIneligible(reason) {
  return {
    eligible: false,
    reason,
    entityType: "",
    entityNumber: 0,
    headSha: "",
    actor: "",
    request: "",
  };
}

function validateInputs({ event, repository, token, apiUrl }) {
  validateRepository(repository);
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("a GitHub token is required");
  }
  if (typeof apiUrl !== "string" || !/^https:\/\/[^\s]+$/.test(apiUrl)) {
    throw new Error("GitHub API URL must use HTTPS");
  }
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("GitHub event must be an object");
  }
}

function positiveIdentifier(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

async function fetchPermission({ repository, actor, token, apiUrl, fetchImpl }) {
  const { data } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
    fetchImpl,
  });
  return data?.permission;
}

async function fetchPullRequest({ repository, number, token, apiUrl, fetchImpl }) {
  positiveIdentifier(number, "PR number");
  const { data } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/pulls/${number}`,
    fetchImpl,
  });
  return data;
}

function validateCurrentPullRequest(pullRequest, repository, expectedHeadSha) {
  if (pullRequest?.state !== "open") {
    return "closed-pr";
  }
  if (pullRequest?.draft !== false) {
    return "draft-pr";
  }
  if (pullRequest?.head?.repo?.full_name !== repository) {
    return "fork-pr";
  }
  const currentHead = pullRequest?.head?.sha;
  if (!SHA_PATTERN.test(currentHead ?? "")) {
    throw new Error("GitHub PR response does not contain a valid head SHA");
  }
  if (expectedHeadSha && currentHead !== expectedHeadSha) {
    return "stale-head";
  }
  return "";
}

async function listWorkflowJobs({
  repository,
  runId,
  token,
  apiUrl,
  fetchImpl,
}) {
  const jobs = [];
  let totalCount;
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await githubRequest({
      apiUrl,
      token,
      path: `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100&page=${page}`,
      fetchImpl,
    });
    if (
      !Number.isInteger(data?.total_count) ||
      data.total_count < 0 ||
      data.total_count > MAX_SOURCE_JOBS ||
      !Array.isArray(data?.jobs) ||
      data.jobs.length > 100
    ) {
      throw new Error("GitHub workflow jobs response is invalid or too large");
    }
    totalCount ??= data.total_count;
    if (data.total_count !== totalCount) {
      throw new Error("GitHub workflow jobs total changed during pagination");
    }
    jobs.push(...data.jobs);
    if (jobs.length >= totalCount) {
      if (jobs.length !== totalCount) {
        throw new Error("GitHub workflow jobs response exceeded total_count");
      }
      return jobs;
    }
    if (data.jobs.length < 100) {
      throw new Error("GitHub workflow jobs response ended before total_count");
    }
  }
  throw new Error("GitHub workflow jobs response exceeded 10 pages");
}

export async function resolveReviewRequest({
  event,
  repository,
  token,
  apiUrl,
  fetchImpl = fetch,
}) {
  validateInputs({ event, repository, token, apiUrl });
  if (event.action !== "completed") {
    return reviewIneligible("workflow-run-not-completed");
  }

  const runId = positiveIdentifier(event.workflow_run?.id, "workflow run ID");
  const { data: run } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/actions/runs/${runId}`,
    fetchImpl,
  });
  if (
    run?.name !== REVIEW_REQUEST_WORKFLOW ||
    run?.path !== REVIEW_REQUEST_PATH
  ) {
    return reviewIneligible("unexpected-source-workflow");
  }
  if (run?.event !== "pull_request") {
    return reviewIneligible("unexpected-source-event");
  }
  if (run?.conclusion !== "success") {
    return reviewIneligible("source-run-failed");
  }
  if (run?.repository?.full_name !== repository) {
    return reviewIneligible("source-repository-mismatch");
  }
  if (!Array.isArray(run?.pull_requests) || run.pull_requests.length !== 1) {
    return reviewIneligible("missing-source-pr");
  }

  const runActor = run.triggering_actor ?? run.actor;
  if (isBot(runActor) || runActor?.type !== "User") {
    return reviewIneligible("bot");
  }
  if (!SHA_PATTERN.test(run?.head_sha ?? "")) {
    throw new Error("workflow run API response does not contain a valid head SHA");
  }

  const jobs = await listWorkflowJobs({
    repository,
    runId,
    token,
    apiUrl,
    fetchImpl,
  });
  const requestJobs = jobs.filter((job) => job?.name === REVIEW_REQUEST_JOB);
  if (
    requestJobs.length !== 1 ||
    requestJobs[0]?.conclusion !== "success"
  ) {
    return reviewIneligible("source-request-not-successful");
  }

  const prNumber = run.pull_requests[0]?.number;
  const pullRequest = await fetchPullRequest({
    repository,
    number: prNumber,
    token,
    apiUrl,
    fetchImpl,
  });
  const prReason = validateCurrentPullRequest(
    pullRequest,
    repository,
    run.head_sha,
  );
  if (prReason) {
    return reviewIneligible(prReason);
  }

  const actor = runActor?.login;
  if (typeof actor !== "string" || actor.length === 0) {
    throw new Error("workflow run API response does not contain a valid actor");
  }
  const permission = await fetchPermission({
    repository,
    actor,
    token,
    apiUrl,
    fetchImpl,
  });
  if (!hasWritePermission(permission)) {
    return reviewIneligible("insufficient-permission");
  }

  return {
    eligible: true,
    reason: "eligible",
    prNumber,
    headSha: run.head_sha,
    actor,
  };
}

function assistantIdentifier(eventName, event) {
  if (eventName === "issue_comment" && event.action === "created") {
    return {
      kind: "issue_comment",
      entityNumber: positiveIdentifier(event.issue?.number, "Issue number"),
      resourceId: positiveIdentifier(event.comment?.id, "Issue comment ID"),
    };
  }
  if (
    eventName === "pull_request_review_comment" &&
    event.action === "created"
  ) {
    return {
      kind: "review_comment",
      entityNumber: positiveIdentifier(event.pull_request?.number, "PR number"),
      resourceId: positiveIdentifier(event.comment?.id, "Review comment ID"),
    };
  }
  if (eventName === "pull_request_review" && event.action === "submitted") {
    return {
      kind: "review",
      entityNumber: positiveIdentifier(event.pull_request?.number, "PR number"),
      resourceId: positiveIdentifier(event.review?.id, "Review ID"),
    };
  }
  if (
    eventName === "issues" &&
    event.action === "labeled" &&
    event.label?.name === "claude"
  ) {
    return {
      kind: "issue_label",
      entityNumber: positiveIdentifier(event.issue?.number, "Issue number"),
      resourceId: 0,
    };
  }
  return null;
}

async function resolveAssistantResource({
  identifier,
  repository,
  token,
  apiUrl,
  fetchImpl,
}) {
  if (identifier.kind === "issue_comment") {
    const [{ data: comment }, { data: issue }] = await Promise.all([
      githubRequest({
        apiUrl,
        token,
        path: `/repos/${repository}/issues/comments/${identifier.resourceId}`,
        fetchImpl,
      }),
      githubRequest({
        apiUrl,
        token,
        path: `/repos/${repository}/issues/${identifier.entityNumber}`,
        fetchImpl,
      }),
    ]);
    return {
      entityType: issue?.pull_request ? "pull_request" : "issue",
      entityNumber: identifier.entityNumber,
      request: comment?.body,
      actor: comment?.user,
    };
  }
  if (identifier.kind === "review_comment") {
    const { data: comment } = await githubRequest({
      apiUrl,
      token,
      path: `/repos/${repository}/pulls/comments/${identifier.resourceId}`,
      fetchImpl,
    });
    if (
      typeof comment?.pull_request_url !== "string" ||
      !comment.pull_request_url.endsWith(`/pulls/${identifier.entityNumber}`)
    ) {
      throw new Error("Review comment does not belong to the requested PR");
    }
    return {
      entityType: "pull_request",
      entityNumber: identifier.entityNumber,
      request: comment.body,
      actor: comment.user,
    };
  }
  if (identifier.kind === "review") {
    const { data: review } = await githubRequest({
      apiUrl,
      token,
      path: `/repos/${repository}/pulls/${identifier.entityNumber}/reviews/${identifier.resourceId}`,
      fetchImpl,
    });
    return {
      entityType: "pull_request",
      entityNumber: identifier.entityNumber,
      request: review?.body,
      actor: review?.user,
    };
  }

  const { data: issue } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/${identifier.entityNumber}`,
    fetchImpl,
  });
  if (
    issue?.pull_request ||
    !Array.isArray(issue?.labels) ||
    !issue.labels.some((label) => label?.name === "claude")
  ) {
    return null;
  }
  const timeline = await paginate({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/${identifier.entityNumber}/timeline`,
    maxItems: 100,
    fetchImpl,
  });
  const labelEvents = timeline
    .filter(
      (item) => item?.event === "labeled" && item?.label?.name === "claude",
    )
    .sort((left, right) => (left.id ?? 0) - (right.id ?? 0));
  const latest = labelEvents.at(-1);
  if (!latest) {
    return null;
  }
  return {
    entityType: "issue",
    entityNumber: identifier.entityNumber,
    request: `Analyze Issue #${identifier.entityNumber} after the claude label was applied.`,
    actor: latest.actor,
    triggeredByLabel: true,
  };
}

export async function resolveAssistantRequest({
  eventName,
  event,
  repository,
  token,
  apiUrl,
  fetchImpl = fetch,
}) {
  validateInputs({ event, repository, token, apiUrl });
  const identifier = assistantIdentifier(eventName, event);
  if (!identifier) {
    return assistantIneligible("trigger-missing");
  }
  const resource = await resolveAssistantResource({
    identifier,
    repository,
    token,
    apiUrl,
    fetchImpl,
  });
  if (!resource || typeof resource.request !== "string") {
    return assistantIneligible("trigger-missing");
  }
  if (!resource.triggeredByLabel && !resource.request.includes("@claude")) {
    return assistantIneligible("trigger-missing");
  }
  if (isBot(resource.actor) || resource.actor?.type !== "User") {
    return assistantIneligible("bot");
  }

  let headSha = "";
  if (resource.entityType === "pull_request") {
    const pullRequest = await fetchPullRequest({
      repository,
      number: resource.entityNumber,
      token,
      apiUrl,
      fetchImpl,
    });
    const prReason = validateCurrentPullRequest(pullRequest, repository, "");
    if (prReason) {
      return assistantIneligible(prReason);
    }
    headSha = pullRequest.head.sha;
  }

  const actor = resource.actor?.login;
  if (typeof actor !== "string" || actor.length === 0) {
    throw new Error("Assistant API resource does not contain a valid actor");
  }
  const permission = await fetchPermission({
    repository,
    actor,
    token,
    apiUrl,
    fetchImpl,
  });
  if (!hasWritePermission(permission)) {
    return assistantIneligible("insufficient-permission");
  }

  return {
    eligible: true,
    reason: "eligible",
    entityType: resource.entityType,
    entityNumber: resource.entityNumber,
    headSha,
    actor,
    request: resource.request,
  };
}

async function main() {
  try {
    const env = process.env;
    const event = JSON.parse(
      await readFile(requireEnv(env, "GITHUB_EVENT_PATH"), "utf8"),
    );
    const eventName = requireEnv(env, "GITHUB_EVENT_NAME");
    const common = {
      event,
      repository: requireEnv(env, "GITHUB_REPOSITORY"),
      token: requireEnv(env, "GITHUB_TOKEN"),
      apiUrl: requireEnv(env, "GITHUB_API_URL"),
    };
    const result =
      eventName === "workflow_run"
        ? await resolveReviewRequest(common)
        : await resolveAssistantRequest({ ...common, eventName });

    await writeOutputs(requireEnv(env, "GITHUB_OUTPUT"), {
      eligible: result.eligible,
      reason: result.reason,
      pr_number: result.prNumber ?? "",
      entity_type: result.entityType ?? "",
      entity_number: result.entityNumber ?? "",
      head_sha: result.headSha,
      actor: result.actor,
    });
    console.log(`Claude request eligibility: ${result.reason}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Claude request eligibility failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
