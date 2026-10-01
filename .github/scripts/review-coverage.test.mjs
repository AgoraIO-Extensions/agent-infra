import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  buildCoverageCheckOutput,
  buildCoverageJobSummary,
  collectReviewEvidence,
  collectPrAgentEvidence,
  evaluateReviewCoverage,
  publishCoverageCheck,
  readBoundedTextResponse,
  selectCoverageCheck,
} from "./review-coverage.mjs";

const head = "a".repeat(40);
const completeDecision =
  "Tokens: 18682, total tokens under limit: 32000, returning full diff.";
const prunedDecision =
  "Tokens: 135314, total tokens over limit: 32000, pruning diff.";
const logRecord = (message, extra = {}) =>
  `2026-08-29T00:50:50.5849411Z ${JSON.stringify({
    record: { extra, message },
    text: `${message}\n`,
  })}`;
const completeLog = logRecord(completeDecision);
const prunedLog = logRecord(prunedDecision);

test("bounds downloaded review evidence while reading", async () => {
  assert.equal(await readBoundedTextResponse(new Response("test"), 4), "test");
  await assert.rejects(
    readBoundedTextResponse(new Response("large"), 4),
    /exceeds the evidence size limit/,
  );
});

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
      analysisJobConclusion: "success",
    })),
    { analysisJobConclusion: "success" },
  );
});

test("accepts a complete current-head PR-Agent review", () => {
  assert.deepEqual(
    evaluateReviewCoverage({
      provider: "pr-agent",
      expectedHead: head,
      runResult: "success",
      analysisJobConclusion: "success",
      analysisLog: completeLog,
      publicationVerified: true,
    }),
    {
      conclusion: "success",
      headSha: head,
      omittedFileCount: 0,
      provider: "pr-agent",
      reasonCode: "complete",
    },
  );
});

const ticketOmissionMessage = "Clipped related tickets to preserve the prompt token budget";
const nativeTicketOmission = {
  message: ticketOmissionMessage,
  name: "pr_agent.tools.ticket_pr_compliance_check",
  function: "fit_related_tickets_to_prompt_budget",
  level: { name: "INFO" },
  extra: { artifact: { included_tickets: 0, omitted_tickets: 1 } },
};
const recordLine = (record) => `2026-10-01T04:00:00.0000000Z ${JSON.stringify({ record })}`;

test("rejects native whole-ticket omission independently of complete diff and publication", () => {
  assert.deepEqual(evaluateReviewCoverage({
    provider: "pr-agent", expectedHead: head, runResult: "success",
    analysisJobConclusion: "success", publicationVerified: true,
    analysisLog: `${recordLine(nativeTicketOmission)}\n${completeLog}`,
  }), {
    conclusion: "failure", headSha: head, omittedFileCount: null,
    provider: "pr-agent", reasonCode: "review-input-incomplete",
  });
});

test("does not treat ticket omission text in untrusted data as a native input event", () => {
  for (const line of [
    ticketOmissionMessage,
    logRecord(ticketOmissionMessage),
    logRecord("PR diff", { diff: ticketOmissionMessage }),
    recordLine({ ...nativeTicketOmission, name: "other.module" }),
    recordLine({ ...nativeTicketOmission, function: "other_function" }),
    recordLine({ ...nativeTicketOmission, level: { name: "DEBUG" } }),
    recordLine({ ...nativeTicketOmission, message: `${ticketOmissionMessage}\nIssue body` }),
    logRecord("PR description", { description: recordLine(nativeTicketOmission) }),
  ]) {
    assert.equal(evaluateReviewCoverage({
      provider: "pr-agent", expectedHead: head, runResult: "success",
      analysisJobConclusion: "success", publicationVerified: true,
      analysisLog: `${line}\n${completeLog}`,
    }).conclusion, "success");
  }
});

test("fails closed when PR-Agent reports omitted files", () => {
  assert.deepEqual(
    evaluateReviewCoverage({
      provider: "pr-agent",
      expectedHead: head,
      runResult: "success",
      analysisJobConclusion: "success",
      analysisLog: prunedLog,
    }),
    {
      conclusion: "failure",
      headSha: head,
      omittedFileCount: null,
      provider: "pr-agent",
      reasonCode: "review-coverage-incomplete",
    },
  );
});

test("rejects missing, malformed, or mismatched PR-Agent job evidence", () => {
  const cases = [
    { analysisLog: "", reasonCode: "review-output-missing" },
    {
      analysisLog: "Review completed without token metadata.",
      reasonCode: "review-output-invalid",
    },
    {
      analysisLog: completeDecision,
      reasonCode: "review-output-invalid",
    },
    {
      analysisLog: logRecord("PR diff", { diff: completeDecision }),
      reasonCode: "review-output-invalid",
    },
    {
      analysisLog: `${completeLog}\n${prunedLog}`,
      reasonCode: "review-output-invalid",
    },
    {
      analysisLog: completeLog,
      publicationVerified: true,
      analysisJobConclusion: "failure",
      reasonCode: "review-output-invalid",
    },
  ];

  for (const {
    analysisJobConclusion = "success",
    analysisLog,
    reasonCode,
  } of cases) {
    assert.equal(
      evaluateReviewCoverage({
        provider: "pr-agent",
        expectedHead: head,
        runResult: "success",
        analysisJobConclusion,
        analysisLog,
      }).reasonCode,
      reasonCode,
    );
  }
});

test("maps reviewer control outcomes to stable reasons", () => {
  for (const [runResult, reasonCode] of [
    ["failure", "review-run-failed"],
    ["cancelled", "review-run-cancelled"],
    ["skipped", "review-output-missing"],
  ]) {
    assert.equal(
      evaluateReviewCoverage({
        provider: "pr-agent",
        expectedHead: head,
        runResult,
        analysisJobConclusion: runResult,
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

test("renders bounded required Gate output", () => {
  assert.deepEqual(
    buildCoverageCheckOutput({
      conclusion: "failure",
      headSha: head,
      omittedFileCount: 5,
      provider: "pr-agent",
      reasonCode: "review-coverage-incomplete",
    }),
    {
      title: "Automated Review Coverage: failure",
      summary: [
        "provider: pr-agent",
        `head_sha: ${head}`,
        "reason_code: review-coverage-incomplete",
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

test("publishes the required Gate through a current-head dedicated App path", async () => {
  const requests = [];
  const checkRequests = [];
  let targetReads = 0;
  const coverage = evaluateReviewCoverage({
    provider: "pr-agent",
    expectedHead: head,
    runResult: "success",
    analysisJobConclusion: "success",
    analysisLog: completeLog,
    publicationVerified: true,
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
        return { state: "open", head: { sha: head } };
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
        provider: "pr-agent",
        reasonCode: "review-coverage-incomplete",
      },
      42,
    ),
    [
      "## Automated Review Coverage",
      "",
      "- Pull request: `#42`",
      "- Provider: `pr-agent`",
      `- Head SHA: \`${head}\``,
      "- Conclusion: `failure`",
      "- Reason: `review-coverage-incomplete`",
      "- Omitted files: `2`",
      "- Next owner: `repository-maintainer`",
      "",
    ].join("\n"),
  );
});

test("rejects the #422 false green: full diff and successful job without published review evidence", () => {
  assert.equal(evaluateReviewCoverage({
    provider: "pr-agent", expectedHead: head, runResult: "success",
    analysisJobConclusion: "success", analysisLog: completeLog,
  }).conclusion, "failure");
});

function collectionFixture({ jobs, receipt, requestFailure, logResponse } = {}) {
  const context = {
    repository: "org/repo", prNumber: 42, expectedHead: head, runId: "123", attempt: "2",
  };
  const job = { id: 99, name: "PR-Agent Analysis", run_id: 123, run_attempt: 2,
    head_sha: head, status: "completed", conclusion: "success" };
  const requests = [];
  const publishedReceipt = { headSha: head, runId: "123", attempt: "2", reviewId: 77,
    findingCount: 0, commentsSha256: createHash("sha256").update("[]").digest("hex") };
  return { requests, job, input: {
    ...context, receipt: receipt ?? JSON.stringify(publishedReceipt),
    request: async (path) => {
      requests.push(path);
      if (requestFailure) await requestFailure(path);
      if (path.includes("/jobs?")) return { total_count: (jobs ?? [job]).length, jobs: jobs ?? [job] };
      if (path.endsWith("/comments?per_page=100")) return [];
      assert.equal(path, "/repos/org/repo/pulls/42/reviews/77");
      return { id: 77, user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
        state: "COMMENTED", commit_id: head,
        body: `## PR-Agent Review\n\nCommit: \`${head}\`\n\nNo major issues detected.\n\n<!-- agent-infra:pr-agent-review:123:2:${head} -->` };
    },
    logResponse: logResponse ?? (async (path) => {
      requests.push(path);
      assert.equal(path, "/repos/org/repo/actions/jobs/99/logs");
      return new Response(completeLog);
    }),
  } };
}

function collectedCoverage(evidence) {
  return evaluateReviewCoverage({ provider: "pr-agent", expectedHead: head, runResult: "success", ...evidence });
}

test("collects the native log for the exact attempt and verifies actual publication", async () => {
  const fixture = collectionFixture();
  const evidence = await collectPrAgentEvidence(fixture.input);
  assert.equal(fixture.requests[0], "/repos/org/repo/actions/runs/123/attempts/2/jobs?per_page=100");
  assert.equal(evidence.analysisLog, completeLog);
  assert.equal(evidence.publicationVerified, true);
  assert.deepEqual(evidence.collectionFailures, []);
  assert.equal(collectedCoverage(evidence).reasonCode, "complete");
});

test("distinguishes API failures from missing or mismatched Analysis jobs", async () => {
  const { job } = collectionFixture();
  const cases = [
    [{ requestFailure: async () => { throw Object.assign(new Error("SECRET"), { status: 403 }); } }, "api-denied"],
    [{ requestFailure: async () => { throw Object.assign(new Error("SECRET"), { status: 404 }); } }, "api-unavailable"],
    [{ requestFailure: async () => { throw new TypeError("SECRET"); } }, "api-unavailable"],
    [{ jobs: [] }, "job-count-mismatch"],
    [{ jobs: [job, job] }, "job-count-mismatch"],
    ...[{ run_attempt: 1 }, { run_id: 124 }, { head_sha: "b".repeat(40) }, { status: "in_progress" }]
      .map((delta) => [{ jobs: [{ ...job, ...delta }] }, "job-identity-mismatch"]),
  ];
  for (const [options, failure] of cases) {
    const evidence = await collectPrAgentEvidence(collectionFixture(options).input);
    assert.equal(evidence.collectionFailures[0].stage, "analysis-job-list");
    assert.equal(evidence.collectionFailures[0].failure, failure);
    const coverage = collectedCoverage(evidence);
    assert.equal(coverage.conclusion, "failure");
    assert.equal(coverage.omittedFileCount, null);
    assert.doesNotMatch(JSON.stringify(coverage), /SECRET/);
  }
});

test("receipt failures preserve the native log and cannot hide pruning", async () => {
  for (const [receipt, stage, failure] of [
    ["SECRET-not-json", "publication-receipt-parse", "invalid-receipt"],
    ["{}", "publication-verify", "receipt-mismatch"],
    ["null", "publication-verify", "receipt-mismatch"],
  ]) {
    for (const log of [completeLog, prunedLog]) {
      const evidence = await collectPrAgentEvidence(collectionFixture({ receipt, logResponse: async () => new Response(log) }).input);
      assert.equal(evidence.analysisLog, log);
      assert.deepEqual(evidence.collectionFailures.map((entry) => [entry.stage, entry.failure]), [[stage, failure]]);
      const coverage = collectedCoverage(evidence);
      assert.equal(coverage.conclusion, "failure");
      assert.equal(coverage.reasonCode, log === prunedLog ? "review-coverage-incomplete" : "review-output-invalid");
    }
  }
});

test("publication API failures keep the log and return a bounded safe diagnostic", async () => {
  const evidence = await collectPrAgentEvidence(collectionFixture({ requestFailure: async (path) => {
    if (path.includes("/reviews/")) throw Object.assign(new Error("SECRET-signed-url"), { status: 403 });
  } }).input);
  assert.equal(evidence.analysisLog, completeLog);
  assert.deepEqual(evidence.collectionFailures[0], { stage: "publication-verify", failure: "api-denied",
    apiStatus: 403, runId: 123, attempt: 2, analysisJobId: 99, analysisJobCount: 1 });
  const coverage = collectedCoverage(evidence);
  for (const rendered of [buildCoverageCheckOutput(coverage).summary, buildCoverageJobSummary(coverage, 42)]) {
    assert.match(rendered, /collection_stage: publication-verify/);
    assert.match(rendered, /collection_apiStatus: 403/);
    assert.doesNotMatch(rendered, /SECRET|signed-url|returning full diff/);
  }
});

test("log fetch, missing body, read failures and streaming limits all fail closed", async () => {
  const cases = [
    [async () => { throw Object.assign(new Error("SECRET"), { status: 403 }); }, "analysis-log-fetch", "api-denied"],
    [async () => new Response(null), "analysis-log-read", "missing-body"],
    [async () => new Response(""), "analysis-log-read", "missing-body"],
    [async () => new Response("x".repeat(10 * 1024 * 1024 + 1)), "analysis-log-read", "size-limit"],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("SECRET")); } })), "analysis-log-read", "unknown"],
  ];
  for (const [logResponse, stage, failure] of cases) {
    const evidence = await collectPrAgentEvidence(collectionFixture({ logResponse }).input);
    assert.equal(evidence.publicationVerified, true);
    assert.deepEqual(evidence.collectionFailures.map((entry) => [entry.stage, entry.failure]), [[stage, failure]]);
    assert.equal(collectedCoverage(evidence).conclusion, "failure");
    assert.doesNotMatch(JSON.stringify(evidence), /SECRET/);
  }
});

test("does not accept a truncated jobs page or let diagnostics upgrade coverage", async () => {
  const fixture = collectionFixture();
  const evidence = await collectPrAgentEvidence({ ...fixture.input,
    request: async (path) => path.includes("/jobs?") ? { jobs: [fixture.job], total_count: 101 } : fixture.input.request(path) });
  assert.equal(evidence.collectionFailures[0].failure, "job-count-mismatch");
  const failure = { stage: "analysis-log-read", failure: "unknown" };
  assert.equal(collectedCoverage({ analysisJobConclusion: "success", analysisLog: completeLog,
    publicationVerified: true, collectionFailures: [failure] }).conclusion, "failure");
  const output = buildCoverageCheckOutput({ ...collectedCoverage(evidence),
    collectionFailures: [{ stage: "SECRET", failure: "SECRET", apiStatus: "SECRET", analysisJobId: "SECRET" }] });
  assert.doesNotMatch(output.summary, /SECRET/);
  assert.match(output.summary, /omitted_file_count: unknown/);
});
