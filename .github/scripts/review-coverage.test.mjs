import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCoverageCheckOutput,
  buildCoverageJobSummary,
  collectEvidence,
  collectReviewEvidence,
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
    record: {
      extra,
      message,
      name: "pr_agent.algo.pr_processing",
      function: "get_pr_diff",
    },
    text: `${message}\n`,
  })}`;
const heading = `## PR Reviewer Guide [head ${head}; run 123/2] 🔍`;
const output = `${heading}\n\nReview observations.`;
const outputRecord = (artifact = output) =>
  `2026-08-29T00:51:00Z ${JSON.stringify({
    record: {
      name: "pr_agent.tools.pr_reviewer",
      function: "run",
      message: "PR output",
      extra: { artifact },
    },
  })}`;
const completeLog = `${logRecord(completeDecision)}\n${outputRecord()}`;
const reviewContext = {
  repository: "example/repo",
  prNumber: 42,
  runId: 123,
  runAttempt: 2,
};
const analysisJob = {
  started_at: "2026-08-29T00:50:00Z",
  completed_at: "2026-08-29T00:52:00Z",
};
const comment = {
  id: 25,
  user: { login: "github-actions[bot]", id: 41_898_282, type: "Bot" },
  performed_via_github_app: { id: 15_368 },
  issue_url: "https://api.github.com/repos/example/repo/issues/42",
  updated_at: "2026-08-29T00:51:01Z",
  body: `${heading}\n\n<!-- pr-agent:review:full -->\n\nReview observations.`,
};
const evidence = { reviewContext, analysisJob, reviewComments: [comment] };
const input = {
  provider: "pr-agent",
  selectedProvider: "pr-agent",
  expectedHead: head,
  runResult: "success",
  analysisJobConclusion: "success",
  analysisLog: completeLog,
  ...evidence,
};
const claudeCheck = {
  name: "Claude Review Gate",
  app: { id: 4_503_079 },
  head_sha: head,
  status: "completed",
  external_id: `agent-infra:pr:42:claude-review-gate:${head}`,
};
const prunedLog = logRecord(prunedDecision);

test("bounds downloaded review evidence while reading", async () => {
  assert.equal(await readBoundedTextResponse(new Response("test"), 4), "test");
  await assert.rejects(
    readBoundedTextResponse(new Response("large"), 4),
    /exceeds the evidence size limit/,
  );
});

test("skips failed runs and degrades evidence collection errors", async () => {
  let calls = 0;
  const failingCollector = async () => {
    calls += 1;
    throw new Error("logs unavailable");
  };

  assert.deepEqual(
    await collectReviewEvidence("failure", failingCollector),
    {},
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await collectReviewEvidence("success", failingCollector),
    {},
  );
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
      ...evidence,
      provider: "pr-agent",
      selectedProvider: "pr-agent",
      expectedHead: head,
      runResult: "success",
      analysisJobConclusion: "success",
      analysisLog: completeLog,
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

test("fails closed when PR-Agent reports omitted files", () => {
  assert.deepEqual(
    evaluateReviewCoverage({
      ...evidence,
      provider: "pr-agent",
      selectedProvider: "pr-agent",
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
      reasonCode: "review-coverage-incomplete",
    },
    {
      analysisLog: completeLog,
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
        ...evidence,
        provider: "pr-agent",
        selectedProvider: "pr-agent",
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
        ...evidence,
        provider: "pr-agent",
        selectedProvider: "pr-agent",
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
        selectedProvider: "claude",
        prNumber: 42,
        expectedHead: head,
        runResult: "success",
        claudeReview: { ...claudeCheck, conclusion, output: { summary } },
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
        selectedProvider: "claude",
        prNumber: 42,
        expectedHead: head,
        runResult: "success",
        claudeReview: { ...claudeCheck, ...claudeReview },
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
    ...evidence,
    provider: "pr-agent",
    selectedProvider: "pr-agent",
    expectedHead: head,
    runResult: "success",
    analysisJobConclusion: "success",
    analysisLog: completeLog,
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
  assert.match(
    requests[1],
    /check-runs\?check_name=Automated%20Review%20Coverage/,
  );
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

test("retries a transient service failure while verifying the current target", async () => {
  const waits = [];
  const writes = [];
  let targetReads = 0;
  const existing = {
    id: 99,
    name: "Automated Review Coverage",
    head_sha: head,
    app: { id: 4_503_079 },
    external_id: `agent-infra:pr:42:automated-review-coverage:${head}`,
  };

  await publishCoverageCheck({
    repository: "example/repo",
    prNumber: 42,
    expectedHead: head,
    targetUrl: "https://github.com/example/repo/actions/runs/1",
    coverage: evaluateReviewCoverage(input),
    request: async (path) => {
      if (path.endsWith("/pulls/42")) {
        targetReads += 1;
        if (targetReads === 1) {
          throw Object.assign(new Error("GitHub API GET /repos/example/repo/pulls/42: 503"), {
            status: 503,
          });
        }
        return { state: "open", head: { sha: head } };
      }
      return { check_runs: [existing] };
    },
    checkRequest: async (path, options) => {
      writes.push([path, options.method]);
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  assert.equal(targetReads, 3);
  assert.deepEqual(waits, [250]);
  assert.deepEqual(writes, [["/repos/example/repo/check-runs/99", "PATCH"]]);
});

test("does not retry a closed or moved current Review target", async () => {
  for (const target of [
    { state: "closed", head: { sha: head } },
    { state: "open", head: { sha: "b".repeat(40) } },
  ]) {
    const waits = [];
    const writes = [];

    await assert.rejects(
      publishCoverageCheck({
        repository: "example/repo",
        prNumber: 42,
        expectedHead: head,
        targetUrl: "https://github.com/example/repo/actions/runs/1",
        coverage: evaluateReviewCoverage(input),
        request: async (path) =>
          path.endsWith("/pulls/42") ? target : { check_runs: [] },
        checkRequest: async (path, options) => {
          writes.push([path, options.method]);
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
      /PR is closed or its head changed/,
    );

    assert.deepEqual(waits, []);
    assert.deepEqual(writes, []);
  }
});

test("fails closed when current-target service retries are exhausted", async () => {
  const waits = [];
  const writes = [];

  await assert.rejects(
    publishCoverageCheck({
      repository: "example/repo",
      prNumber: 42,
      expectedHead: head,
      targetUrl: "https://github.com/example/repo/actions/runs/1",
      coverage: evaluateReviewCoverage(input),
      request: async (path) => {
        if (path.endsWith("/pulls/42")) {
          throw Object.assign(new Error("GitHub API GET /repos/example/repo/pulls/42: 503"), {
            status: 503,
          });
        }
        return { check_runs: [] };
      },
      checkRequest: async (path, options) => {
        writes.push([path, options.method]);
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    }),
    /503/,
  );

  assert.deepEqual(waits, [250, 500]);
  assert.deepEqual(writes, []);
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

test("requires the published current-run output, not only a full-diff decision", () => {
  const cases = [
    [
      "missing artifact",
      { analysisLog: logRecord(completeDecision) },
      "review-output-missing",
    ],
    ["missing comment", { reviewComments: [] }, "review-output-missing"],
    [
      "stale output",
      {
        analysisLog: `${logRecord(completeDecision)}\n${outputRecord(output.replace(head, "b".repeat(40)))}`,
      },
      "review-output-stale",
    ],
    [
      "stale comment",
      {
        reviewComments: [
          { ...comment, body: comment.body.replace(head, "b".repeat(40)) },
        ],
      },
      "review-output-stale",
    ],
    [
      "old attempt",
      { reviewContext: { ...reviewContext, runAttempt: 3 } },
      "review-output-invalid",
    ],
    [
      "old run",
      { reviewContext: { ...reviewContext, runId: 124 } },
      "review-output-invalid",
    ],
    ["inactive provider", { selectedProvider: "claude" }, "provider-mismatch"],
    [
      "edited comment",
      { reviewComments: [{ ...comment, body: `${comment.body}\nEdited.` }] },
      "review-output-invalid",
    ],
    [
      "untrusted user",
      { reviewComments: [{ ...comment, user: { ...comment.user, id: 1 } }] },
      "review-output-invalid",
    ],
    [
      "untrusted app",
      { reviewComments: [{ ...comment, performed_via_github_app: { id: 1 } }] },
      "review-output-invalid",
    ],
    [
      "wrong PR",
      {
        reviewComments: [
          {
            ...comment,
            issue_url: "https://api.github.com/repos/example/repo/issues/43",
          },
        ],
      },
      "review-output-invalid",
    ],
    [
      "missing timestamp",
      { reviewComments: [{ ...comment, updated_at: undefined }] },
      "review-output-invalid",
    ],
    [
      "late edit",
      { reviewComments: [{ ...comment, updated_at: "2026-08-29T00:52:01Z" }] },
      "review-output-invalid",
    ],
    [
      "early output",
      { reviewComments: [{ ...comment, updated_at: "2026-08-29T00:49:59Z" }] },
      "review-output-invalid",
    ],
    [
      "duplicate output",
      { reviewComments: [comment, { ...comment, id: 26 }] },
      "review-output-invalid",
    ],
    [
      "suggestions only",
      {
        reviewComments: [
          {
            ...comment,
            body: comment.body.replace(
              "pr-agent:review:full",
              "pr-agent:improve:no-suggestions",
            ),
          },
        ],
      },
      "review-output-missing",
    ],
    ["malformed log", { analysisLog: {} }, "review-output-invalid"],
    [
      "ambiguous artifact",
      { analysisLog: `${completeLog}\n${outputRecord()}` },
      "review-output-invalid",
    ],
    [
      "spoofed log origin",
      {
        analysisLog: completeLog.replace(
          "pr_agent.tools.pr_reviewer",
          "pr_agent.tools.pr_code_suggestions",
        ),
      },
      "review-output-missing",
    ],
  ];
  for (const [label, change, reason] of cases) {
    const actual = evaluateReviewCoverage({ ...input, ...change });
    assert.equal(actual.conclusion, "failure", label);
    assert.equal(actual.reasonCode, reason, label);
  }
});

test("malformed output separators and null comment entries fail closed", () => {
  const parseFailure = `2026-08-29T00:51:00Z ${JSON.stringify({
    record: {
      name: "pr_agent.tools.pr_reviewer",
      message: "Failed to parse review data",
    },
  })}`;
  assert.equal(
    evaluateReviewCoverage({
      ...input,
      analysisLog: `${completeLog}\n${parseFailure}`,
    }).reasonCode,
    "review-output-invalid",
  );
  assert.equal(
    evaluateReviewCoverage({
      ...input,
      analysisLog: `${logRecord(completeDecision)}\n${outputRecord(output.replace("\n\n", "\nx"))}`,
    }).reasonCode,
    "review-output-invalid",
  );
  assert.equal(
    evaluateReviewCoverage({ ...input, reviewComments: [null] }).reasonCode,
    "review-output-missing",
  );
});

test("accepts the deterministic persistent update wrapper and same-run replay", () => {
  const updated = {
    ...comment,
    body: comment.body.replace(
      "Review observations.",
      `#### (Review updated until commit https://github.com/example/repo/commit/${head})\n\n\nReview observations.`,
    ),
  };
  const expected = evaluateReviewCoverage(input);
  assert.deepEqual(
    evaluateReviewCoverage({ ...input, reviewComments: [updated] }),
    expected,
  );
  assert.deepEqual(evaluateReviewCoverage(input), expected);
});

test("remaining-file footer and upstream filtering cannot be hidden by full-diff success", () => {
  const files = [
    "packages/contracts/generated/client.ts",
    "openapi.json",
    "schema.json",
    "tests/isolation.test.ts",
    "tests/fake.ts",
    "pnpm-lock.yaml",
    "vendor/runtime.ts",
  ];
  const footer =
    "\n\n<hr>\n\n⚠️ **Review coverage:** The following files were not included in this review because of the token budget:\n" +
    files.map((file) => `- \`${file}\``).join("\n");
  const logs = [
    `${logRecord(completeDecision)}\n${outputRecord(output + footer)}`,
    `${logRecord(completeDecision)}\n${outputRecord(output + footer + "\n... and 25 more")}`,
    `${completeLog}\n2026-08-29T00:51:00Z ${JSON.stringify({ record: { name: "pr_agent.git_providers.github_provider", message: "Filtered out files with invalid extensions: " + JSON.stringify(files) } })}`,
    `${prunedLog}\n${completeLog}`,
  ];
  for (const analysisLog of logs) {
    assert.equal(
      evaluateReviewCoverage({ ...input, analysisLog }).reasonCode,
      "review-coverage-incomplete",
    );
  }

  const quotation =
    "\n\n```markdown" + footer + "\n```\nThis is a quoted example.";
  assert.equal(
    evaluateReviewCoverage({
      ...input,
      analysisLog: `${logRecord(completeDecision)}\n${outputRecord(output + quotation)}`,
      reviewComments: [{ ...comment, body: comment.body + quotation }],
    }).reasonCode,
    "complete",
  );
});

test("rejects stale, untrusted, unfinished and ambiguous Claude evidence", () => {
  const valid = {
    ...claudeCheck,
    conclusion: "success",
    output: { summary: "reason_code: success" },
  };
  for (const [change, reason] of [
    [{ head_sha: "b".repeat(40) }, "review-output-stale"],
    [{ app: { id: 15368 } }, "review-output-invalid"],
    [{ status: "in_progress" }, "review-output-invalid"],
    [
      { external_id: `agent-infra:pr:43:claude-review-gate:${head}` },
      "review-output-invalid",
    ],
    [
      {
        output: {
          summary: "reason_code: success\nreason_code: invalid_output",
        },
      },
      "review-output-invalid",
    ],
  ]) {
    assert.equal(
      evaluateReviewCoverage({
        provider: "claude",
        selectedProvider: "claude",
        expectedHead: head,
        prNumber: 42,
        runResult: "success",
        claudeReview: { ...valid, ...change },
      }).reasonCode,
      reason,
    );
  }
});

test("collects only the selected workflow attempt and paginates Review comments", async () => {
  const requests = [];
  const run = {
    id: 123,
    run_attempt: 2,
    repository: { full_name: "example/repo" },
    path: ".github/workflows/pr-agent-review.yml",
    event: "pull_request_target",
  };
  const job = {
    ...analysisJob,
    id: 456,
    run_id: 123,
    name: "PR-Agent Analysis",
    status: "completed",
    conclusion: "success",
  };
  const request = async (path) => {
    requests.push(path);
    if (path.endsWith("/attempts/2")) return run;
    if (path.endsWith("/jobs?per_page=100")) return { jobs: [job] };
    if (path.includes("page=1&"))
      return Array.from({ length: 100 }, () => ({ body: "Unrelated" }));
    if (path.includes("page=2&")) return [comment];
    throw new Error("Unexpected request");
  };
  const textRequest = async (path) => {
    assert.equal(path, "/repos/example/repo/actions/jobs/456/logs");
    return completeLog;
  };
  const options = {
    ...reviewContext,
    expectedHead: head,
    provider: "pr-agent",
    request,
    textRequest,
  };
  const collected = await collectEvidence(options);
  assert.deepEqual(collected.reviewComments, [comment]);
  assert.ok(
    requests
      .filter((path) => path.includes("/comments?"))
      .every((path) =>
        path.endsWith(`since=${encodeURIComponent(analysisJob.started_at)}`),
      ),
  );
  assert.equal(
    evaluateReviewCoverage({ ...input, ...collected }).reasonCode,
    "complete",
  );
  assert.ok(requests.every((path) => !path.includes("filter=latest")));
  for (const conclusion of ["failure", "cancelled"]) {
    const failed = await collectEvidence({
      ...options,
      request: async () => ({ ...run, conclusion }),
    });
    assert.equal(
      evaluateReviewCoverage({ ...input, ...failed }).reasonCode,
      conclusion === "failure" ? "review-run-failed" : "review-run-cancelled",
    );
  }
  for (const change of [
    { run_attempt: 1 },
    { path: ".github/workflows/ci.yml" },
    { event: "workflow_dispatch" },
    { repository: { full_name: "other/repo" } },
  ]) {
    assert.deepEqual(
      await collectEvidence({
        ...options,
        request: async () => ({ ...run, ...change }),
      }),
      {},
    );
  }
});

test("publication replay updates the same dedicated Check and rejects a moved head", async () => {
  const writes = [];
  const existing = {
    id: 99,
    name: "Automated Review Coverage",
    head_sha: head,
    app: { id: 4_503_079 },
    external_id: `agent-infra:pr:42:automated-review-coverage:${head}`,
  };
  let currentHead = head;
  const args = {
    repository: "example/repo",
    prNumber: 42,
    expectedHead: head,
    targetUrl: "https://github.com/example/repo/actions/runs/123",
    coverage: evaluateReviewCoverage(input),
    request: async (path) =>
      path.endsWith("/pulls/42")
        ? { state: "open", head: { sha: currentHead } }
        : { check_runs: [existing] },
    checkRequest: async (path, options) => {
      writes.push([path, options.method]);
    },
  };
  await publishCoverageCheck(args);
  await publishCoverageCheck(args);
  assert.deepEqual(
    writes,
    Array.from({ length: 2 }, () => [
      "/repos/example/repo/check-runs/99",
      "PATCH",
    ]),
  );
  currentHead = "b".repeat(40);
  await assert.rejects(publishCoverageCheck(args));
  assert.equal(writes.length, 2);
});

test("validates current official Action state without treating findings as coverage", () => {
  const lastRun = {
    head_sha: head,
    kind: "full",
    complete: true,
    excluded_files: [],
  };
  const trailer = (last_run = lastRun, version = 1) =>
    `\n\n<!-- pr-agent-review-state:v${version}\n${JSON.stringify({ schema_version: version, findings: [], last_run })}\n-->\n`;
  for (const [state, expected] of [
    [trailer(), "complete"],
    [trailer({ ...lastRun, complete: false }), "review-coverage-incomplete"],
    [
      trailer({
        ...lastRun,
        excluded_files: ["generated/client.ts", "tests/fake.ts"],
      }),
      "review-coverage-incomplete",
    ],
    [trailer({ ...lastRun, head_sha: "b".repeat(40) }), "review-output-stale"],
    [trailer({ ...lastRun, excluded_files: "none" }), "review-output-invalid"],
    [trailer(lastRun, 2), "review-output-invalid"],
    [
      trailer().replace('"schema_version":1', '"schema_version":'),
      "review-output-invalid",
    ],
  ]) {
    assert.equal(
      evaluateReviewCoverage({
        ...input,
        analysisLog: `${logRecord(completeDecision)}\n${outputRecord(output + state)}`,
        reviewComments: [{ ...comment, body: comment.body + state }],
      }).reasonCode,
      expected,
    );
  }
  const footer =
    "\n\n<hr>\n\n⚠️ **Review coverage:** The following files were not included in this review because of the token budget:\n- `schema.json`";
  assert.equal(
    evaluateReviewCoverage({
      ...input,
      analysisLog: `${logRecord(completeDecision)}\n${outputRecord(output + footer + trailer())}`,
    }).reasonCode,
    "review-coverage-incomplete",
  );
});
