import { pathToFileURL } from "node:url";
import { appendFile, readFile } from "node:fs/promises";

import {
  GITHUB_ACTIONS_APP_ID,
  gateExternalId,
  selectCurrentGateCheck,
} from "./check-run-contract.mjs";
import {
  gateCheckRequest,
  requireCurrentReviewTarget,
  selectReviewGateCheck,
} from "./claude-review.mjs";

export const COVERAGE_CHECK_NAME = "Automated Review Coverage";
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const REVIEW_IDENTITY = "<!-- pr-agent:review:full -->";
const REVIEW_HEADER =
  /^## PR Reviewer Guide \[head ([a-f0-9]{40}); run ([1-9][0-9]*)\/([1-9][0-9]*)\] 🔍$/;
const COVERAGE_FOOTER =
  "⚠️ **Review coverage:** The following files were not included in this review because of the token budget:";

const FULL_DIFF_PATTERN =
  /^Tokens: [0-9]+, total tokens under limit: [0-9]+, returning full diff\.$/;
const PRUNED_DIFF_PATTERN =
  /^Tokens: [0-9]+, total tokens over limit: [0-9]+, pruning diff\.$/;
const JOB_LOG_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function result(
  provider,
  headSha,
  conclusion,
  reasonCode,
  omittedFileCount = conclusion === "success" ? 0 : null,
) {
  return { conclusion, headSha, omittedFileCount, provider, reasonCode };
}

function runFailure(provider, headSha, runResult) {
  if (runResult === "failure") {
    return result(provider, headSha, "failure", "review-run-failed");
  }
  if (runResult === "cancelled") {
    return result(provider, headSha, "failure", "review-run-cancelled");
  }
  if (runResult !== "success") {
    return result(provider, headSha, "failure", "review-output-missing");
  }
  return null;
}

function jobLogRecords(log) {
  const records = [];
  for (const line of log.split(/\r?\n/)) {
    const separator = line.indexOf(" ");
    if (
      separator < 0 ||
      !JOB_LOG_TIMESTAMP_PATTERN.test(line.slice(0, separator))
    ) {
      continue;
    }
    try {
      const record = JSON.parse(line.slice(separator + 1))?.record;
      if (typeof record?.message === "string") records.push(record);
    } catch {
      continue;
    }
  }
  return records;
}

function evaluatePrAgent({
  expectedHead,
  runResult,
  analysisJobConclusion,
  analysisLog,
  reviewContext,
  reviewComments,
  analysisJob,
}) {
  const failed = runFailure("pr-agent", expectedHead, runResult);
  if (failed) return failed;
  if (!analysisLog) {
    return result("pr-agent", expectedHead, "failure", "review-output-missing");
  }
  if (analysisJobConclusion !== "success") {
    return result("pr-agent", expectedHead, "failure", "review-output-invalid");
  }
  if (
    typeof analysisLog !== "string" ||
    Buffer.byteLength(analysisLog, "utf8") > MAX_EVIDENCE_BYTES
  ) {
    return result("pr-agent", expectedHead, "failure", "review-output-invalid");
  }

  const records = jobLogRecords(analysisLog);
  const messages = records
    .filter(
      (record) =>
        record.name === "pr_agent.algo.pr_processing" &&
        record.function === "get_pr_diff",
    )
    .map((record) => record.message);
  const completeMatches = messages.filter((message) =>
    FULL_DIFF_PATTERN.test(message),
  );
  const prunedMatches = messages.filter((message) =>
    PRUNED_DIFF_PATTERN.test(message),
  );
  // Even a later full-diff decision cannot erase earlier pruning/filtering.
  if (
    prunedMatches.length ||
    records.some(
      (record) =>
        record.name === "pr_agent.git_providers.github_provider" &&
        record.message.startsWith("Filtered out "),
    )
  ) {
    return result(
      "pr-agent",
      expectedHead,
      "failure",
      "review-coverage-incomplete",
      null,
    );
  }
  const reject = (reason = "review-output-invalid") =>
    result("pr-agent", expectedHead, "failure", reason);
  if (completeMatches.length !== 1) return reject();
  if (
    records.some(
      (record) =>
        record.name === "pr_agent.tools.pr_reviewer" &&
        record.message === "Failed to parse review data",
    )
  )
    return reject();

  const outputs = records.filter(
    (record) =>
      record.name === "pr_agent.tools.pr_reviewer" &&
      record.function === "run" &&
      record.message === "PR output",
  );
  if (!outputs.length) return reject("review-output-missing");
  const output = outputs[0].extra?.artifact;
  if (outputs.length !== 1 || typeof output !== "string" || !output.trim())
    return reject();
  const marker = output.split("\n", 1)[0].match(REVIEW_HEADER);
  if (!marker || !output.startsWith(`${marker[0]}\n\n`)) return reject();
  if (marker[1] !== expectedHead) return reject("review-output-stale");
  if (
    !reviewContext ||
    marker[2] !== String(reviewContext.runId) ||
    marker[3] !== String(reviewContext.runAttempt)
  )
    return reject();
  if (output.includes(COVERAGE_FOOTER)) {
    return result(
      "pr-agent",
      expectedHead,
      "failure",
      "review-coverage-incomplete",
      null,
    );
  }

  if (!Array.isArray(reviewComments)) return reject("review-output-missing");
  const candidates = reviewComments.filter(
    (comment) =>
      typeof comment?.body === "string" &&
      comment.body.split("\n").slice(0, 5).includes(REVIEW_IDENTITY),
  );
  if (!candidates.length) return reject("review-output-missing");
  const current = candidates.filter((comment) =>
    comment.body.startsWith(`${marker[0]}\n\n${REVIEW_IDENTITY}\n\n`),
  );
  if (current.length !== 1) {
    if (
      current.length === 0 &&
      candidates.every((comment) => {
        const head = comment.body.split("\n", 1)[0].match(REVIEW_HEADER)?.[1];
        return head && head !== expectedHead;
      })
    )
      return reject("review-output-stale");
    return reject();
  }
  const comment = current[0];
  const { repository, prNumber } = reviewContext;
  const updatedAt = Date.parse(comment.updated_at);
  const startedAt = Date.parse(analysisJob?.started_at);
  const completedAt = Date.parse(analysisJob?.completed_at);
  if (
    comment.user?.id !== 41_898_282 ||
    comment.user?.login !== "github-actions[bot]" ||
    comment.user?.type !== "Bot" ||
    comment.performed_via_github_app?.id !== GITHUB_ACTIONS_APP_ID ||
    comment.issue_url !==
      `https://api.github.com/repos/${repository}/issues/${prNumber}` ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    ![updatedAt, startedAt, completedAt].every(Number.isFinite) ||
    updatedAt < startedAt ||
    updatedAt > completedAt
  )
    return reject();

  // Compare bytes with the immutable Analysis artifact, allowing only the two
  // deterministic persistent-comment wrappers from the official provider.
  const remainder = output.slice(marker[0].length + 2);
  if (!remainder.trim()) return reject();
  const prefix = `${marker[0]}\n\n${REVIEW_IDENTITY}\n\n`;
  const updateHeader = `#### (Review updated until commit https://github.com/${repository}/commit/${expectedHead})\n\n\n`;
  if (
    comment.body !== prefix + remainder &&
    comment.body !== prefix + updateHeader + remainder
  )
    return reject();
  return result("pr-agent", expectedHead, "success", "complete");
}

function evaluateClaude({ expectedHead, runResult, claudeReview, prNumber }) {
  const failed = runFailure("claude", expectedHead, runResult);
  if (failed) return failed;
  if (!claudeReview) {
    return result("claude", expectedHead, "failure", "review-output-missing");
  }

  if (claudeReview.head_sha !== expectedHead) {
    return result("claude", expectedHead, "failure", "review-output-stale");
  }
  if (
    claudeReview.status !== "completed" ||
    !selectReviewGateCheck([claudeReview], expectedHead, prNumber)
  ) {
    return result("claude", expectedHead, "failure", "review-output-invalid");
  }
  const reason = uniqueSummaryValue(
    claudeReview.output?.summary,
    "reason_code: ",
  );
  const completePair =
    (reason === "success" && claudeReview.conclusion === "success") ||
    (reason === "blocking_finding" && claudeReview.conclusion === "failure");
  if (completePair) {
    return result("claude", expectedHead, "success", "complete");
  }
  if (["success", "blocking_finding"].includes(reason)) {
    return result("claude", expectedHead, "failure", "review-output-invalid");
  }
  if (reason === "invalid_output") {
    return result("claude", expectedHead, "failure", "review-output-invalid");
  }
  if (reason === "infrastructure_failure") {
    return result("claude", expectedHead, "failure", "review-run-failed");
  }
  return result("claude", expectedHead, "failure", "review-output-invalid");
}

export function evaluateReviewCoverage(input) {
  if (input?.selectedProvider !== input?.provider) {
    return result(
      input?.provider,
      input?.expectedHead,
      "failure",
      "provider-mismatch",
    );
  }
  if (input?.provider === "pr-agent") return evaluatePrAgent(input);
  if (input?.provider === "claude") return evaluateClaude(input);
  return result(
    String(input?.provider ?? "unknown"),
    input?.expectedHead,
    "failure",
    "provider-mismatch",
  );
}

export function buildCoverageCheckOutput(coverage) {
  const complete = coverage.conclusion === "success";
  const omittedFileCount = Number.isSafeInteger(coverage.omittedFileCount)
    ? coverage.omittedFileCount
    : "unknown";
  return {
    title: `Automated Review Coverage: ${coverage.conclusion}`,
    summary: [
      `provider: ${coverage.provider}`,
      `head_sha: ${coverage.headSha}`,
      `reason_code: ${coverage.reasonCode}`,
      `omitted_file_count: ${omittedFileCount}`,
      "",
      complete
        ? "Coverage Gate accepted complete current-head Review evidence."
        : "Coverage Gate rejected current-head Review evidence.",
    ].join("\n"),
  };
}

export function selectCoverageCheck(checkRuns, expectedHead, prNumber) {
  return selectCurrentGateCheck(checkRuns, {
    name: COVERAGE_CHECK_NAME,
    headSha: expectedHead,
    prNumber,
  });
}

function uniqueSummaryValue(summary, prefix) {
  const values = String(summary ?? "")
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  return values.length === 1 ? values[0] : null;
}

export function coverageCheckFacts(check, expectedHead) {
  if (
    check?.status !== "completed" ||
    !["success", "failure"].includes(check?.conclusion)
  ) {
    return null;
  }
  const summary = check.output?.summary;
  const provider = uniqueSummaryValue(summary, "provider: ");
  const headSha = uniqueSummaryValue(summary, "head_sha: ");
  const reasonCode = uniqueSummaryValue(summary, "reason_code: ");
  if (
    !["claude", "pr-agent"].includes(provider) ||
    headSha !== expectedHead ||
    !/^[a-z0-9_-]+$/.test(reasonCode ?? "")
  ) {
    return null;
  }
  return { conclusion: check.conclusion, provider, reasonCode };
}

export function buildCoverageJobSummary(coverage, prNumber) {
  const omittedFileCount = Number.isSafeInteger(coverage.omittedFileCount)
    ? coverage.omittedFileCount
    : "unknown";
  return [
    "## Automated Review Coverage",
    "",
    `- Pull request: \`#${prNumber}\``,
    `- Provider: \`${coverage.provider}\``,
    `- Head SHA: \`${coverage.headSha}\``,
    `- Conclusion: \`${coverage.conclusion}\``,
    `- Reason: \`${coverage.reasonCode}\``,
    `- Omitted files: \`${omittedFileCount}\``,
    `- Next owner: \`${coverage.conclusion === "success" ? "none" : "repository-maintainer"}\``,
    "",
  ].join("\n");
}

export async function publishCoverageCheck({
  repository,
  prNumber,
  expectedHead,
  targetUrl,
  coverage,
  request,
  checkRequest = gateCheckRequest,
}) {
  await requireCurrentReviewTarget({
    repository,
    prNumber,
    expectedHead,
    request,
  });

  const encodedName = encodeURIComponent(COVERAGE_CHECK_NAME);
  const response = await request(
    `/repos/${repository}/commits/${expectedHead}/check-runs?check_name=${encodedName}&filter=latest&per_page=100`,
  );
  let check = selectCoverageCheck(
    response.check_runs ?? [],
    expectedHead,
    prNumber,
  );
  if (!check) {
    check = await checkRequest(`/repos/${repository}/check-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: COVERAGE_CHECK_NAME,
        head_sha: expectedHead,
        status: "in_progress",
        details_url: targetUrl,
        external_id: gateExternalId({
          name: COVERAGE_CHECK_NAME,
          headSha: expectedHead,
          prNumber,
        }),
        output: {
          title: "Automated Review Coverage: in_progress",
          summary:
            "Waiting for current-head Automated Review coverage evidence.",
        },
      }),
    });
  }

  await requireCurrentReviewTarget({
    repository,
    prNumber,
    expectedHead,
    request,
  });
  await checkRequest(`/repos/${repository}/check-runs/${check.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      conclusion: coverage.conclusion,
      details_url: targetUrl,
      output: buildCoverageCheckOutput(coverage),
    }),
  });
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
    throw new Error(
      `GitHub API ${options.method ?? "GET"} ${path}: ${response.status}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

export async function readBoundedTextResponse(
  response,
  maxBytes = MAX_EVIDENCE_BYTES,
) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("GitHub job log exceeds the evidence size limit");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

async function githubTextRequest(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API GET ${path}: ${response.status}`);
  }
  return readBoundedTextResponse(response);
}

export async function collectEvidence({
  repository,
  prNumber,
  expectedHead,
  provider,
  runId,
  runAttempt,
  request = githubRequest,
  textRequest = githubTextRequest,
}) {
  if (provider === "pr-agent") {
    const run = await request(
      `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
    );
    if (
      run.id !== runId ||
      run.run_attempt !== runAttempt ||
      run.repository?.full_name !== repository ||
      run.path !== ".github/workflows/pr-agent-review.yml" ||
      run.event !== "pull_request_target"
    )
      return {};
    if (["failure", "cancelled"].includes(run.conclusion)) {
      return { runResult: run.conclusion };
    }
    const response = await request(
      `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    );
    const jobs = (response.jobs ?? []).filter(
      (job) => job.name === "PR-Agent Analysis",
    );
    if (
      jobs.length !== 1 ||
      jobs[0].run_id !== runId ||
      jobs[0].status !== "completed"
    )
      return {};
    const reviewComments = [];
    for (let page = 1; ; page += 1) {
      if (page > 10)
        throw new Error("Review comment inventory exceeds evidence limit");
      const comments = await request(
        `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(comments))
        throw new Error("Invalid Review comment inventory");
      reviewComments.push(...comments);
      if (comments.length < 100) break;
    }
    return {
      reviewContext: { repository, prNumber, runId, runAttempt },
      reviewComments,
      analysisJob: jobs[0],
      analysisJobConclusion: jobs[0].conclusion,
      analysisLog: await textRequest(
        `/repos/${repository}/actions/jobs/${jobs[0].id}/logs`,
      ),
    };
  }
  if (provider === "claude") {
    const encodedName = encodeURIComponent("Claude Review Gate");
    const response = await request(
      `/repos/${repository}/commits/${expectedHead}/check-runs?check_name=${encodedName}&filter=all&per_page=100`,
    );
    return {
      claudeReview: selectReviewGateCheck(
        response.check_runs ?? [],
        expectedHead,
        prNumber,
      ),
    };
  }
  return {};
}

export async function collectReviewEvidence(runResult, collector) {
  if (runResult !== "success") return {};
  try {
    return await collector();
  } catch {
    return {};
  }
}

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnvironment("PR_NUMBER"));
  const provider = requiredEnvironment("REVIEW_PROVIDER");
  const selectedProvider =
    process.env.SELECTED_REVIEW_PROVIDER === "claude" ? "claude" : "pr-agent";
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const expectedHead =
    process.env.EXPECTED_HEAD_SHA ?? event.pull_request?.head?.sha;
  if (!expectedHead) throw new Error("Current Review head is required");
  const runResult = requiredEnvironment("REVIEW_RUN_RESULT");
  const evidence = await collectReviewEvidence(runResult, () =>
    collectEvidence({
      repository,
      prNumber,
      expectedHead,
      provider,
      runId: Number(requiredEnvironment("GITHUB_RUN_ID")),
      runAttempt: Number(requiredEnvironment("GITHUB_RUN_ATTEMPT")),
    }),
  );
  const coverage = evaluateReviewCoverage({
    provider,
    selectedProvider,
    prNumber,
    expectedHead,
    runResult,
    ...evidence,
  });
  const targetUrl = `https://github.com/${repository}/actions/runs/${requiredEnvironment("GITHUB_RUN_ID")}`;
  await publishCoverageCheck({
    repository,
    prNumber,
    expectedHead,
    targetUrl,
    coverage,
    request: githubRequest,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      buildCoverageJobSummary(coverage, prNumber),
      "utf8",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
