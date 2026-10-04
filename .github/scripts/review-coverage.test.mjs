import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageCheckOutput,
  buildCoverageJobSummary,
  collectReviewEvidence,
  evaluateReviewCoverage,
  publishCoverageCheck,
  selectCoverageCheck,
} from "./review-coverage.mjs";

const head = "a".repeat(40);
test("skips failed runs and preserves safe evidence collection failures", async () => {
  let calls = 0;
  const failingCollector = async () => {
    calls += 1;
    throw new Error("logs unavailable; signed_url=SECRET");
  };

  assert.deepEqual(await collectReviewEvidence("failure", failingCollector), {});
  assert.equal(calls, 0);
  assert.deepEqual(await collectReviewEvidence("success", failingCollector), {
    collectionFailures: [{ stage: "unknown", failure: "unknown" }],
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    await collectReviewEvidence("success", async () => ({
      claudeReview: { conclusion: "success" },
    })),
    { claudeReview: { conclusion: "success" } },
  );
});

test("maps reviewer control outcomes to stable reasons", () => {
  for (const [runResult, reasonCode] of [
    ["failure", "review-run-failed"],
    ["cancelled", "review-run-cancelled"],
    ["skipped", "review-output-missing"],
  ]) {
    assert.equal(
      evaluateReviewCoverage({
        provider: "claude",
        expectedHead: head,
        runResult,
      }).reasonCode,
      reasonCode,
    );
  }

  assert.equal(
    evaluateReviewCoverage({
      provider: "other",
      expectedHead: head,
      runResult: "success",
    }).reasonCode,
    "provider-mismatch",
  );
});

test("maps trusted Claude Review Gate evidence to coverage only", () => {
  for (const [conclusion, summary, expected] of [
    ["success", "reason_code: success", "complete"],
    ["failure", "reason_code: blocking_finding", "complete"],
    ["failure", "reason_code: invalid_output", "review-output-invalid"],
    ["failure", "reason_code: infrastructure_failure", "review-run-failed"],
  ]) {
    assert.equal(
      evaluateReviewCoverage({
        provider: "claude",
        expectedHead: head,
        runResult: "success",
        claudeReview: { conclusion, output: { summary } },
      }).reasonCode,
      expected,
    );
  }

  for (const claudeReview of [
    { conclusion: "failure", output: { summary: "reason_code: success" } },
    {
      conclusion: "success",
      output: { summary: "reason_code: blocking_finding" },
    },
  ]) {
    assert.equal(
      evaluateReviewCoverage({
        provider: "claude",
        expectedHead: head,
        runResult: "success",
        claudeReview,
      }).reasonCode,
      "review-output-invalid",
    );
  }
});

test("renders bounded Claude Coverage output", () => {
  assert.deepEqual(
    buildCoverageCheckOutput({
      conclusion: "failure",
      headSha: head,
      omittedFileCount: 5,
      provider: "claude",
      reasonCode: "review-output-invalid",
    }),
    {
      title: "Automated Review Coverage: failure",
      summary: [
        "provider: claude",
        `head_sha: ${head}`,
        "reason_code: review-output-invalid",
        "omitted_file_count: 5",
        "",
        "Coverage Gate rejected current-head Review evidence.",
      ].join("\n"),
    },
  );
});

test("selects only the dedicated App current-head Coverage Check", () => {
  const expectedExternalId = `agent-infra:pr:42:automated-review-coverage:${head}`;
  assert.equal(
    selectCoverageCheck(
      [
        {
          id: 1,
          name: "Automated Review Coverage",
          head_sha: head,
          app: { id: 4_503_079 },
          external_id: expectedExternalId,
        },
        {
          id: 2,
          name: "Automated Review Coverage",
          head_sha: head,
          app: { id: 999 },
          external_id: expectedExternalId,
        },
      ],
      head,
      42,
    ).id,
    1,
  );
});

test("publishes the Claude Coverage through a current-head dedicated App path", async () => {
  const requests = [];
  const checkRequests = [];
  let targetReads = 0;
  const coverage = evaluateReviewCoverage({
    provider: "claude",
    expectedHead: head,
    runResult: "success",
    claudeReview: { conclusion: "success", output: { summary: "reason_code: success" } },
  });

  await publishCoverageCheck({
    repository: "example/repo",
    prNumber: 42,
    expectedHead: head,
    targetUrl: "https://github.com/example/repo/actions/runs/1",
    coverage,
    request: async (path) => {
      requests.push(path);
      if (path === "/repos/example/repo/pulls/42") {
        targetReads += 1;
        return { state: "open", head: { sha: head, repo: { full_name: "example/repo" } } };
      }
      return { check_runs: [] };
    },
    checkRequest: async (path, options) => {
      checkRequests.push({ path, body: JSON.parse(options.body) });
      return { id: 99 };
    },
  });

  assert.equal(targetReads, 2);
  assert.match(requests[1], /check-runs\?check_name=Automated%20Review%20Coverage/);
  assert.deepEqual(checkRequests[0], {
    path: "/repos/example/repo/check-runs",
    body: {
      name: "Automated Review Coverage",
      head_sha: head,
      status: "in_progress",
      details_url: "https://github.com/example/repo/actions/runs/1",
      external_id: `agent-infra:pr:42:automated-review-coverage:${head}`,
      output: {
        title: "Automated Review Coverage: in_progress",
        summary: "Waiting for current-head Automated Review coverage evidence.",
      },
    },
  });
  assert.equal(checkRequests[1].path, "/repos/example/repo/check-runs/99");
  assert.equal(
    checkRequests[1].body.details_url,
    "https://github.com/example/repo/actions/runs/1",
  );
  assert.equal(checkRequests[1].body.conclusion, "success");
  assert.equal(checkRequests[1].body.status, "completed");
});

test("renders a bounded Job Summary from coverage facts", () => {
  assert.equal(
    buildCoverageJobSummary(
      {
        conclusion: "failure",
        headSha: head,
        omittedFileCount: 2,
        provider: "claude",
        reasonCode: "review-output-invalid",
      },
      42,
    ),
    [
      "## Automated Review Coverage",
      "",
      "- Pull request: `#42`",
      "- Provider: `claude`",
      `- Head SHA: \`${head}\``,
      "- Conclusion: `failure`",
      "- Reason: `review-output-invalid`",
      "- Omitted files: `2`",
      "- Next owner: `repository-maintainer`",
      "",
    ].join("\n"),
  );
});
