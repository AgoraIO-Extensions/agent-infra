import { pathToFileURL } from "node:url";
import { appendFile, readFile } from "node:fs/promises";

import {
  gateExternalId,
  selectCurrentGateCheck,
} from "./check-run-contract.mjs";
import {
  gateCheckRequest,
  requireCurrentReviewTarget,
  selectReviewGateCheck,
} from "./claude-review.mjs";

export const COVERAGE_CHECK_NAME = "Automated Review Coverage";

const REVIEW_HEADING = "## PR Reviewer Guide 🔍";
const COVERAGE_FOOTER = "⚠️ **Review coverage:**";
const REVIEW_HEAD_PATTERN =
  /Review updated until commit https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([0-9a-f]{40})/;

function result(provider, headSha, conclusion, reasonCode, omittedFileCount = 0) {
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

function trustedPrAgentComment(comment) {
  return (
    comment?.user?.login === "github-actions[bot]" &&
    comment?.user?.type === "Bot" &&
    typeof comment.body === "string" &&
    comment.body.includes(REVIEW_HEADING)
  );
}

function timestamp(comment) {
  return Date.parse(comment.updated_at ?? comment.created_at ?? "");
}

function parseOmittedFileCount(body) {
  const footer = body.slice(body.indexOf(COVERAGE_FOOTER));
  const listed = footer
    .split("\n")
    .filter((line) => /^- `[^`]+`$/.test(line.trim())).length;
  const additional = Number(footer.match(/\.\.\. and ([0-9]+) more/)?.[1] ?? 0);
  return Math.min(listed + additional, 10_000);
}

function evaluatePrAgent({
  expectedHead,
  runResult,
  runStartedAt,
  comments = [],
}) {
  const failed = runFailure("pr-agent", expectedHead, runResult);
  if (failed) return failed;

  const trusted = comments.filter(trustedPrAgentComment);
  if (trusted.length === 0) {
    return result("pr-agent", expectedHead, "failure", "review-output-missing");
  }

  const started = Date.parse(runStartedAt ?? "");
  if (!Number.isFinite(started)) {
    return result("pr-agent", expectedHead, "failure", "review-output-invalid");
  }
  const recent = trusted
    .filter((comment) => timestamp(comment) >= started)
    .sort((left, right) => timestamp(right) - timestamp(left))[0];
  if (!recent) {
    return result("pr-agent", expectedHead, "failure", "review-output-stale");
  }
  if (Buffer.byteLength(recent.body, "utf8") > 256 * 1024) {
    return result("pr-agent", expectedHead, "failure", "review-output-invalid");
  }

  const markedHead = recent.body.match(REVIEW_HEAD_PATTERN)?.[1];
  if (markedHead && markedHead !== expectedHead) {
    return result("pr-agent", expectedHead, "failure", "review-output-stale");
  }
  if (recent.body.includes(COVERAGE_FOOTER)) {
    return result(
      "pr-agent",
      expectedHead,
      "failure",
      "review-coverage-incomplete",
      parseOmittedFileCount(recent.body),
    );
  }
  return result("pr-agent", expectedHead, "success", "complete");
}

function reasonCode(summary) {
  return String(summary ?? "").match(/^reason_code: ([a-z0-9_-]+)$/m)?.[1];
}

function evaluateClaude({ expectedHead, runResult, claudeReview }) {
  const failed = runFailure("claude", expectedHead, runResult);
  if (failed) return failed;
  if (!claudeReview) {
    return result("claude", expectedHead, "failure", "review-output-missing");
  }

  const reason = reasonCode(claudeReview.output?.summary);
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
  return {
    title: `Automated Review Coverage: ${coverage.conclusion} (shadow)`,
    summary: [
      `provider: ${coverage.provider}`,
      `head_sha: ${coverage.headSha}`,
      `reason_code: ${coverage.reasonCode}`,
      `omitted_file_count: ${coverage.omittedFileCount}`,
      "",
      complete
        ? "Shadow coverage evaluation found complete current-head Review evidence."
        : "Shadow coverage evaluation found incomplete current-head Review evidence.",
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

export function buildCoverageJobSummary(coverage, prNumber) {
  return [
    "## Automated Review Coverage (shadow)",
    "",
    `- Pull request: \`#${prNumber}\``,
    `- Provider: \`${coverage.provider}\``,
    `- Head SHA: \`${coverage.headSha}\``,
    `- Conclusion: \`${coverage.conclusion}\``,
    `- Reason: \`${coverage.reasonCode}\``,
    `- Omitted files: \`${coverage.omittedFileCount}\``,
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
  let check = selectCoverageCheck(response.check_runs ?? [], expectedHead, prNumber);
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
          title: "Automated Review Coverage: in_progress (shadow)",
          summary: "Waiting for current-head Automated Review coverage evidence.",
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

async function collectEvidence({ repository, prNumber, expectedHead, provider }) {
  if (provider === "pr-agent") {
    const [comments, run] = await Promise.all([
      paginate(`/repos/${repository}/issues/${prNumber}/comments`),
      githubRequest(
        `/repos/${repository}/actions/runs/${requiredEnvironment("GITHUB_RUN_ID")}`,
      ),
    ]);
    return { comments, runStartedAt: run.run_started_at };
  }
  if (provider === "claude") {
    const encodedName = encodeURIComponent("Claude Review Gate");
    const response = await githubRequest(
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

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnvironment("PR_NUMBER"));
  const provider = requiredEnvironment("REVIEW_PROVIDER");
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const expectedHead =
    process.env.EXPECTED_HEAD_SHA ?? event.pull_request?.head?.sha;
  if (!expectedHead) throw new Error("Current Review head is required");
  const runResult = requiredEnvironment("REVIEW_RUN_RESULT");
  const evidence = await collectEvidence({
    repository,
    prNumber,
    expectedHead,
    provider,
  });
  const coverage = evaluateReviewCoverage({
    provider,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
