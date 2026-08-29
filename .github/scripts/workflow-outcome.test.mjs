import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOutcomeRecord,
  githubPaginate,
  parseSourceRunName,
  processWorkflowOutcome,
  renderJobSummary,
  renderWeComMessage,
  sendWeComNotification,
  triagePostMergeFailure,
} from "./workflow-outcome.mjs";

test("parses only fixed workflow run names into trusted targets", () => {
  assert.deepEqual(
    parseSourceRunName("PR #105 | claude-pr-review | source 31464062784"),
    {
      action: "source 31464062784",
      operation: "claude-pr-review",
      targetNumber: 105,
      targetType: "pr",
    },
  );
  assert.deepEqual(parseSourceRunName("main | ci | push"), {
    action: "push",
    operation: "ci",
    targetNumber: null,
    targetType: "main",
  });
  assert.deepEqual(parseSourceRunName("reconcile | pr-gates | schedule"), {
    action: "schedule",
    operation: "pr-gates",
    targetNumber: null,
    targetType: "reconcile",
  });

  for (const invalid of [
    "PR #105: user-controlled title | ci | pull_request",
    "PR #105 | ci | pull_request\nsecret",
    "Issue #0 | codex-worker | labeled",
    "PR #105 | unknown operation | opened",
  ]) {
    assert.throws(() => parseSourceRunName(invalid), /trusted run-name/);
  }
});

test("rejects PR run targets and operations that disagree with workflow_run metadata", async () => {
  const headSha = "9".repeat(40);
  const request = async (apiPath) => {
    const pullMatch = /\/pulls\/(\d+)$/.exec(apiPath);
    if (pullMatch) {
      return {
        number: Number(pullMatch[1]),
        body: "",
        head: { sha: headSha },
        merged_at: null,
      };
    }
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      return { check_runs: [] };
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  const eventFor = (displayTitle) => ({
    action: "completed",
    repository: {
      full_name: "AgoraIO-Extensions/agent-infra",
      default_branch: "main",
    },
    workflow_run: sourceRun({
      id: 91,
      name: "CI",
      display_title: displayTitle,
      event: "pull_request",
      head_sha: headSha,
      pull_requests: [{ number: 115, head: { sha: headSha } }],
    }),
  });

  await assert.rejects(
    processWorkflowOutcome({
      event: eventFor("PR #999 | ci | pull_request"),
      token: "test-token",
      webhookUrl: "",
      request,
      writeSummary: async () => {},
    }),
    /Source pull request target does not match workflow_run metadata/,
  );
  await assert.rejects(
    processWorkflowOutcome({
      event: eventFor("PR #115 | pr-gates | pull_request"),
      token: "test-token",
      webhookUrl: "",
      request,
      writeSummary: async () => {},
    }),
    /Source run operation does not match trusted workflow/,
  );
  await assert.rejects(
    processWorkflowOutcome({
      event: {
        ...eventFor("PR #115 | ci | pull_request"),
        workflow_run: {
          ...eventFor("PR #115 | ci | pull_request").workflow_run,
          path: ".github/workflows/untrusted.yml",
        },
      },
      token: "test-token",
      webhookUrl: "",
      request,
      writeSummary: async () => {},
    }),
    /Source workflow is not trusted/,
  );
});

test("records an unbound fork PR source as a repository no-op", async () => {
  const summaries = [];
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 93,
        name: "CI",
        display_title: "PR #999 | ci | pull_request",
        event: "pull_request",
        conclusion: "failure",
        pull_requests: [],
      }),
    },
    token: "test-token",
    webhookUrl: "https://example.invalid/webhook",
    request: async (apiPath) => {
      throw new Error(`Unexpected request: ${apiPath}`);
    },
    sendNotification: async () => {
      throw new Error("Unexpected notification");
    },
    writeSummary: async (value) => summaries.push(value),
  });

  assert.equal(result.record.target.type, "repository");
  assert.equal(result.record.target.number, null);
  assert.equal(result.record.sourceRun.action, "unbound");
  assert.equal(result.record.outcome.code, "workflow_not_run");
  assert.equal(result.record.outcome.notify, false);
  assert.equal(result.checkId, null);
  assert.equal(summaries.length, 1);
  assert.doesNotMatch(summaries[0], /#999/);
});

test("records a stale PR head as a non-notifying terminal outcome", async () => {
  const sourceHeadSha = "6".repeat(40);
  const liveHeadSha = "7".repeat(40);
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 92,
        name: "CI",
        display_title: "PR #115 | ci | pull_request",
        event: "pull_request",
        head_sha: sourceHeadSha,
        pull_requests: [{ number: 115, head: { sha: sourceHeadSha } }],
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request: async (apiPath) => {
      if (apiPath.endsWith("/pulls/115")) {
        return {
          number: 115,
          body: "",
          head: { sha: liveHeadSha },
          merged_at: null,
        };
      }
      throw new Error(`Unexpected request: ${apiPath}`);
    },
    writeSummary: async () => {},
  });

  assert.equal(result.record.target.number, 115);
  assert.equal(result.record.checkHeadSha, sourceHeadSha);
  assert.equal(result.record.outcome.code, "workflow_not_run");
  assert.equal(result.record.outcome.notify, false);
  assert.equal(result.checkId, null);
});

test("ignores an unresolvable primary Issue in a PR body", async () => {
  const headSha = "8".repeat(40);
  const paths = [];
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 94,
        name: "CI",
        display_title: "PR #115 | ci | pull_request",
        event: "pull_request",
        head_sha: headSha,
        pull_requests: [{ number: 115, head: { sha: headSha } }],
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request: async (apiPath, options = {}) => {
      paths.push(apiPath);
      if (apiPath.endsWith("/pulls/115")) {
        return {
          number: 115,
          body: "Closes #999",
          head: { sha: headSha },
          merged_at: null,
        };
      }
      if (apiPath.endsWith("/issues/999")) {
        assert.equal(options.allowNotFound, true);
        return null;
      }
      if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
        return { check_runs: [] };
      }
      throw new Error(`Unexpected request: ${apiPath}`);
    },
    writeSummary: async () => {},
  });

  assert.equal(result.record.target.number, 115);
  assert.equal(result.record.outcome.code, "workflow_completed");
  assert.equal(paths.some((path) => path.endsWith("/issues/999/comments")), false);
});

test("builds a safe terminal outcome and Job Summary from workflow_run metadata", () => {
  const record = buildOutcomeRecord({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: {
      id: 31464062784,
      name: "Claude PR Review",
      path: ".github/workflows/claude-pr-review.yml",
      display_title: "PR #105 | claude-pr-review | source 31464062784",
      event: "workflow_run",
      conclusion: "failure",
      head_sha: "a".repeat(40),
      run_attempt: 1,
      run_started_at: "2026-08-11T09:58:00Z",
      updated_at: "2026-08-11T10:00:00Z",
    },
    context: {
      cycle: 2,
      attempt: 3,
      untrustedText: "malicious title secret-value",
    },
  });

  assert.deepEqual(record, {
    version: 1,
    eventId: "workflow-run-31464062784",
    repository: "AgoraIO-Extensions/agent-infra",
    checkHeadSha: "a".repeat(40),
    sourceRun: {
      id: 31464062784,
      workflow: "Claude PR Review",
      event: "workflow_run",
      action: "source 31464062784",
      headSha: "a".repeat(40),
      conclusion: "failure",
      url:
        "https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/31464062784",
    },
    target: {
      type: "pr",
      number: 105,
      url: "https://github.com/AgoraIO-Extensions/agent-infra/pull/105",
    },
    cycle: 2,
    attempt: 3,
    outcome: {
      code: "workflow_terminal_failure",
      nextOwner: "repository-maintainer",
      notify: true,
      terminal: true,
    },
  });

  const summary = renderJobSummary(record);
  assert.match(summary, /Workflow outcome audit/);
  assert.match(summary, /\[#105\]\(https:\/\/github\.com\/AgoraIO-Extensions\/agent-infra\/pull\/105\)/);
  assert.match(summary, /\[31464062784\]\(https:\/\/github\.com\/AgoraIO-Extensions\/agent-infra\/actions\/runs\/31464062784\)/);
  assert.match(summary, /`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`/);
  assert.match(summary, /Cycle: 2/);
  assert.match(summary, /Attempt: 3/);
  assert.doesNotMatch(summary, /malicious title|secret-value/);
});

test("rejects an inactive Review provider outcome", () => {
  assert.throws(
    () =>
      buildOutcomeRecord({
        repository: "AgoraIO-Extensions/agent-infra",
        sourceRun: sourceRun({
          name: "PR-Agent Review",
          display_title: "PR #105 | pr-agent-review | synchronize",
          event: "pull_request_target",
        }),
        context: {
          reviewCoverage: {
            provider: "claude",
            reasonCode: "review-coverage-incomplete",
          },
        },
      }),
    /Review Coverage is invalid/,
  );
});

function sourceRun(overrides = {}) {
  const name = overrides.name ?? "Codex Worker";
  const workflowPaths = {
    "Auto-merge Enrollment": ".github/workflows/auto-merge.yml",
    "Blocker Reconciler": ".github/workflows/blocker-reconciler.yml",
    "Claude Issue Review": ".github/workflows/claude-issue-review.yml",
    "Claude PR Review": ".github/workflows/claude-pr-review.yml",
    "Codex Worker": ".github/workflows/codex-worker.yml",
    "CI": ".github/workflows/ci.yml",
    "PR-Agent Review": ".github/workflows/pr-agent-review.yml",
    "PR Gates": ".github/workflows/pr-gates.yml",
  };
  return {
    id: 90,
    name,
    path: overrides.path ?? workflowPaths[name],
    display_title: "Issue #55 | codex-worker | labeled",
    event: "issues",
    conclusion: "success",
    head_sha: "b".repeat(40),
    run_attempt: 1,
    run_started_at: "2026-08-11T09:58:00Z",
    updated_at: "2026-08-11T10:00:00Z",
    ...overrides,
  };
}

test("accepts the hosted workflow identity from its trusted path", async () => {
  const headSha = "e".repeat(40);
  const checks = [];
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/55")) {
      return {
        number: 55,
        state: "closed",
        closed_at: "2026-08-12T12:37:36Z",
        labels: [],
      };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [];
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      return { check_runs: checks };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 1_900,
        app: { id: 15_368 },
        head_sha: headSha,
        ...JSON.parse(options.body),
      };
      checks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/1900") && options.method === "PATCH") {
      Object.assign(checks[0], JSON.parse(options.body));
      return checks[0];
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };

  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 31597352414,
        name: "Issue #55 | pr-gates | closed",
        path: ".github/workflows/pr-gates.yml",
        display_title: "Issue #55 | pr-gates | closed",
        event: "issues",
        head_sha: headSha,
        updated_at: "2026-08-12T12:37:55Z",
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request,
    writeSummary: async () => {},
  });

  assert.equal(result.record.sourceRun.workflow, "PR Gates");
  assert.equal(result.record.outcome.code, "issue_completed");
});

test("notifies only actionable or final outcomes and ignores later audit state", () => {
  const build = (run, context = {}) =>
    buildOutcomeRecord({
      repository: "AgoraIO-Extensions/agent-infra",
      sourceRun: run,
      context,
    }).outcome;

  assert.deepEqual(
    build(
      sourceRun({
        name: "CI",
        display_title: "PR #105 | ci | pull_request",
        event: "pull_request",
        conclusion: "failure",
      }),
      { ciRecoveryEligible: true },
    ),
    {
      code: "ci_failure_pending_recovery",
      nextOwner: "automation",
      notify: false,
      terminal: true,
    },
  );
  for (const conclusion of ["cancelled", "neutral", "skipped", "stale"]) {
    assert.deepEqual(build(sourceRun({ conclusion })), {
      code: "workflow_not_run",
      nextOwner: "none",
      notify: false,
      terminal: true,
    });
  }
  assert.deepEqual(
    build(
      sourceRun({
        name: "CI",
        display_title: "PR #105 | ci | pull_request",
        event: "pull_request",
        conclusion: "failure",
      }),
      { ciRecoveryEligible: false },
    ),
    {
      code: "workflow_terminal_failure",
      nextOwner: "repository-maintainer",
      notify: true,
      terminal: true,
    },
  );
  assert.deepEqual(
    build(
      sourceRun({
        name: "CI",
        display_title: "PR #105 | ci | pull_request",
        event: "pull_request",
        conclusion: "failure",
        run_attempt: 2,
      }),
    ),
    {
      code: "workflow_terminal_failure",
      nextOwner: "repository-maintainer",
      notify: true,
      terminal: true,
    },
  );
  assert.deepEqual(
    build(sourceRun({ conclusion: "failure" }), {
      workerAttempt: {
        attempt: 3,
        outcome: "recoverable",
        terminationReason: "model_failed",
        recordedAt: "2026-08-11T09:59:00Z",
      },
    }),
    {
      code: "worker_budget_exhausted",
      nextOwner: "issue-owner",
      notify: true,
      terminal: true,
    },
  );
  assert.equal(
    build(sourceRun(), {
      workerAttempt: {
        attempt: 2,
        outcome: "recoverable",
        terminationReason: "model_failed",
        recordedAt: "2026-08-11T09:59:00Z",
      },
    }).notify,
    false,
  );
  assert.deepEqual(
    build(sourceRun(), {
      workerAttempt: {
        attempt: 3,
        outcome: "recoverable",
        terminationReason: "model_failed",
        recordedAt: "2026-08-11T09:59:00Z",
      },
    }),
    {
      code: "worker_budget_exhausted",
      nextOwner: "issue-owner",
      notify: true,
      terminal: true,
    },
  );
  assert.equal(
    build(sourceRun(), {
      workerAttempt: {
        attempt: 3,
        outcome: "non_retryable",
        terminationReason: "unsafe_artifact",
        recordedAt: "2026-08-11T10:01:00Z",
      },
    }).code,
    "workflow_completed",
  );

  for (const [runOverrides, context, code] of [
    [
      {},
      {
        workerAttempt: {
          attempt: 1,
          outcome: "completed",
          terminationReason: "human_handoff",
          recordedAt: "2026-08-11T09:59:00Z",
        },
      },
      "human_handoff",
    ],
    [
      { name: "Blocker Reconciler" },
      { blockerState: { state: "triage", reason: "blocker-not-planned" } },
      "dependency_triage",
    ],
    [
      { name: "Blocker Reconciler" },
      { blockerState: { state: "frontier", reason: "blockers-completed" } },
      "blocker_resumed",
    ],
    [{}, { humanValidationPending: true }, "human_validation_required"],
    [{ name: "PR Gates" }, { waiverUsed: true }, "waiver_used"],
    [{}, { issueCompleted: true }, "issue_completed"],
    [{}, { pullRequestMerged: true }, "pr_completed"],
  ]) {
    const outcome = build(sourceRun(runOverrides), context);
    assert.equal(outcome.code, code);
    assert.equal(outcome.notify, true);
  }
});

test("suppresses first CI failures only for current Worker PRs", async () => {
  const headSha = "c".repeat(40);
  const observe = async (headRef) => {
    const checks = [];
    let deliveries = 0;
    const request = async (apiPath, options = {}) => {
      if (apiPath.endsWith("/pulls/105")) {
        return {
          number: 105,
          body: "",
          state: "open",
          draft: false,
          head: {
            ref: headRef,
            sha: headSha,
            repo: { full_name: "AgoraIO-Extensions/agent-infra" },
          },
          base: { ref: "main" },
          merged_at: null,
        };
      }
      if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
        return { check_runs: checks };
      }
      if (apiPath.endsWith("/check-runs") && options.method === "POST") {
        const check = {
          id: 1_200,
          app: { id: 15_368 },
          head_sha: headSha,
          ...JSON.parse(options.body),
        };
        checks.push(check);
        return check;
      }
      if (apiPath.endsWith("/check-runs/1200") && options.method === "PATCH") {
        const payload = JSON.parse(options.body);
        Object.assign(checks[0], payload);
        return payload;
      }
      throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
    };
    const result = await processWorkflowOutcome({
      event: {
        action: "completed",
        repository: {
          full_name: "AgoraIO-Extensions/agent-infra",
          default_branch: "main",
        },
        workflow_run: sourceRun({
          id: 560,
          name: "CI",
          display_title: "PR #105 | ci | pull_request",
          event: "pull_request",
          conclusion: "failure",
          head_sha: headSha,
          pull_requests: [{ number: 105, head: { sha: headSha } }],
        }),
      },
      token: "test-token",
      webhookUrl: "https://example.invalid/webhook",
      request,
      sendNotification: async () => {
        deliveries += 1;
        return {
          configured: true,
          delivered: true,
          attempts: [],
          warning: null,
        };
      },
      writeSummary: async () => {},
    });
    return { checks, deliveries, result };
  };

  const worker = await observe("codex/issue-55-cycle-1");
  assert.equal(worker.result.record.outcome.code, "ci_failure_pending_recovery");
  assert.equal(worker.deliveries, 0);
  assert.equal(worker.checks.length, 0);

  const ordinary = await observe("fix/link-check");
  assert.equal(ordinary.result.record.outcome.code, "workflow_terminal_failure");
  assert.equal(ordinary.deliveries, 1);
  assert.equal(ordinary.checks[0].status, "completed");
});

test("uses the semantic audit identity across different observer source runs", () => {
  const context = {
    workerAttempt: {
      attempt: 3,
      outcome: "recoverable",
      terminationReason: "model_failed",
      recordedAt: "2026-08-11T09:59:00Z",
    },
    eventIds: {
      worker_budget_exhausted: "worker-attempt-worker-500-3-recoverable",
    },
  };
  const build = (id) =>
    buildOutcomeRecord({
      repository: "AgoraIO-Extensions/agent-infra",
      sourceRun: sourceRun({ id }),
      context,
    });

  assert.equal(build(100).eventId, "worker-attempt-worker-500-3-recoverable");
  assert.equal(build(101).eventId, "worker-attempt-worker-500-3-recoverable");
});

test("deduplicates completed target notifications across source workflows", async () => {
  const completedAt = "2026-08-11T09:55:00Z";
  for (const scenario of [
    {
      code: "pr_completed",
      expectedEventId: `pr-completed-115-${"4".repeat(40)}`,
      runs: [
        {
          name: "PR Gates",
          operation: "pr-gates",
          event: "pull_request_target",
          target: "PR #115",
        },
        {
          name: "Auto-merge Enrollment",
          operation: "auto-merge",
          event: "pull_request_target",
          target: "PR #115",
        },
      ],
    },
    {
      code: "issue_completed",
      expectedEventId: `issue-completed-55-${Date.parse(completedAt)}`,
      runs: [
        {
          name: "Codex Worker",
          operation: "codex-worker",
          event: "issues",
          target: "Issue #55",
        },
        {
          name: "Claude Issue Review",
          operation: "claude-issue-review",
          event: "issues",
          target: "Issue #55",
        },
      ],
    },
  ]) {
    const headSha = scenario.code === "pr_completed" ? "4".repeat(40) : "5".repeat(40);
    const checks = [];
    let deliveries = 0;
    const request = async (apiPath, options = {}) => {
      if (apiPath.endsWith("/pulls/115")) {
        return {
          number: 115,
          body: "",
          head: { sha: headSha },
          merged_at: completedAt,
        };
      }
      if (apiPath.endsWith("/issues/55")) {
        return {
          number: 55,
          state: "closed",
          closed_at: completedAt,
          labels: [],
        };
      }
      if (apiPath.endsWith("/issues/55/comments")) return [];
      if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
        return { check_runs: checks };
      }
      if (apiPath.endsWith("/check-runs") && options.method === "POST") {
        const check = {
          id: 1_300 + checks.length,
          app: { id: 15_368 },
          head_sha: headSha,
          ...JSON.parse(options.body),
        };
        checks.push(check);
        return check;
      }
      if (/\/check-runs\/\d+$/.test(apiPath) && options.method === "PATCH") {
        const check = checks.find((candidate) => apiPath.endsWith(`/${candidate.id}`));
        Object.assign(check, JSON.parse(options.body));
        return check;
      }
      throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
    };
    const results = [];
    for (const [index, run] of scenario.runs.entries()) {
      results.push(
        await processWorkflowOutcome({
          event: {
            action: "completed",
            repository: {
              full_name: "AgoraIO-Extensions/agent-infra",
              default_branch: "main",
            },
            workflow_run: sourceRun({
              id: 700 + index,
              name: run.name,
              display_title: `${run.target} | ${run.operation} | closed`,
              event: run.event,
              head_sha: headSha,
              ...(run.event.startsWith("pull_request")
                ? { pull_requests: [{ number: 115, head: { sha: headSha } }] }
                : {}),
            }),
          },
          token: "test-token",
          webhookUrl: "https://example.invalid/webhook",
          request,
          sendNotification: async () => {
            deliveries += 1;
            return {
              configured: true,
              delivered: true,
              attempts: [],
              warning: null,
            };
          },
          writeSummary: async () => {},
        }),
      );
    }

    assert.equal(results[0].record.outcome.code, scenario.code);
    assert.equal(results[0].record.eventId, scenario.expectedEventId);
    assert.equal(results[1].record.eventId, scenario.expectedEventId);
    assert.equal(results[1].replay, true);
    assert.equal(deliveries, 1);
    assert.equal(checks.length, 1);
  }
});

test("retries a rate-limited WeCom delivery without exposing response content", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1
      ? new Response('{"errcode":45009,"errmsg":"secret response"}', {
          status: 429,
        })
      : new Response('{"errcode":0,"errmsg":"ok"}', { status: 200 });
  };
  const result = await sendWeComNotification({
    webhookUrl: "https://example.invalid/webhook?key=never-log-me",
    record: buildOutcomeRecord({
      repository: "AgoraIO-Extensions/agent-infra",
      sourceRun: sourceRun({ conclusion: "failure" }),
    }),
    fetchImpl,
    retryDelayMs: 0,
    timeoutMs: 500,
  });

  assert.deepEqual(result, {
    configured: true,
    delivered: true,
    attempts: [
      { attempt: 1, businessCode: 45009, httpStatus: 429, status: "failed" },
      { attempt: 2, businessCode: 0, httpStatus: 200, status: "delivered" },
    ],
    warning: null,
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[0]), ["msgtype", "markdown"]);
  assert.doesNotMatch(JSON.stringify(result), /never-log-me|secret response/);
});

test("rejects plaintext WeCom webhook delivery before calling fetch", async () => {
  let requested = false;
  const result = await sendWeComNotification({
    webhookUrl: "http://example.invalid/webhook?key=never-log-me",
    record: buildOutcomeRecord({
      repository: "AgoraIO-Extensions/agent-infra",
      sourceRun: sourceRun({ conclusion: "failure" }),
    }),
    fetchImpl: async () => {
      requested = true;
      return new Response('{"errcode":0}', { status: 200 });
    },
  });

  assert.deepEqual(result, {
    configured: true,
    delivered: false,
    attempts: [],
    warning: "webhook_invalid",
  });
  assert.equal(requested, false);
});

test("keeps every WeCom failure non-blocking and bounded to three attempts", async () => {
  const record = buildOutcomeRecord({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: sourceRun({ conclusion: "failure" }),
  });
  assert.deepEqual(await sendWeComNotification({ record, webhookUrl: "" }), {
    configured: false,
    delivered: false,
    attempts: [],
    warning: "webhook_not_configured",
  });

  const cases = [
    async () => new Response('{"errcode":0}', { status: 400 }),
    async () => new Response('{"errcode":0}', { status: 500 }),
    async () => new Response('{"errcode":40013}', { status: 200 }),
    async () => {
      throw new TypeError("network response containing secret text");
    },
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new DOMException("timed out secret text", "AbortError"));
        });
      }),
  ];

  for (const fetchImpl of cases) {
    const result = await sendWeComNotification({
      webhookUrl: "https://example.invalid/webhook?key=never-log-me",
      record,
      fetchImpl,
      retryDelayMs: 0,
      timeoutMs: 5,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.warning, "delivery_failed");
    assert.equal(result.attempts.length, 3);
    assert.doesNotMatch(
      JSON.stringify(result),
      /never-log-me|secret text|network response|timed out/,
    );
  }
});

test("idempotently reopens and triages the primary Issue after a main failure", async () => {
  const calls = [];
  let issue = {
    number: 55,
    state: "closed",
    labels: [{ name: "ready-for-agent" }],
  };
  const comments = [];
  const request = async (apiPath, options = {}) => {
    calls.push({ apiPath, options });
    if (apiPath.endsWith(`/commits/${"c".repeat(40)}/pulls`)) {
      return [
        {
          number: 105,
          merged_at: "2026-08-11T09:00:00Z",
          merge_commit_sha: "c".repeat(40),
          base: { ref: "main" },
          body: "Closes #55\n\nUntrusted PR text and secret-value",
        },
      ];
    }
    if (apiPath.endsWith("/issues/55/comments") && !options.method) {
      return comments;
    }
    if (apiPath.endsWith("/issues/55") && !options.method) return issue;
    if (apiPath.endsWith("/issues/55") && options.method === "PATCH") {
      issue = { ...issue, ...JSON.parse(options.body) };
      return issue;
    }
    if (apiPath.endsWith("/issues/55/labels") && options.method === "POST") {
      issue = {
        ...issue,
        labels: [...issue.labels, { name: "needs-triage" }],
      };
      return issue.labels;
    }
    if (apiPath.endsWith("/issues/55/comments") && options.method === "POST") {
      comments.push({
        id: 1,
        body: JSON.parse(options.body).body,
        created_at: "2026-08-11T10:01:00Z",
        updated_at: "2026-08-11T10:01:00Z",
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
      });
      return comments.at(-1);
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const run = sourceRun({
    id: 400,
    name: "CI",
    display_title: "main | ci | push",
    event: "push",
    conclusion: "failure",
    head_sha: "c".repeat(40),
    head_branch: "main",
  });

  const first = await triagePostMergeFailure({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: run,
    token: "test-token",
    request,
    defaultBranch: "main",
  });
  issue = { ...issue, state: "closed", labels: [] };
  const replay = await triagePostMergeFailure({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: run,
    token: "test-token",
    request,
    defaultBranch: "main",
  });

  assert.deepEqual(first, {
    issueNumber: 55,
    pullRequestNumber: 105,
    replay: false,
  });
  assert.equal(replay.replay, true);
  assert.equal(issue.state, "closed");
  assert.equal(issue.labels.some((label) => label.name === "needs-triage"), false);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Post-merge failure audit/);
  assert.match(comments[0].body, /actions\/runs\/400/);
  assert.doesNotMatch(comments[0].body, /secret-value|Untrusted PR text/);
  assert.equal(
    calls.some(({ apiPath, options }) =>
      /revert|merge/.test(`${options.method ?? "GET"} ${apiPath}`),
    ),
    false,
  );
});

test("does not reopen an Issue for a cancelled or skipped main run", async () => {
  for (const conclusion of ["cancelled", "neutral", "skipped", "stale"]) {
    let requested = false;
    await assert.rejects(
      triagePostMergeFailure({
        repository: "AgoraIO-Extensions/agent-infra",
        sourceRun: sourceRun({
          name: "CI",
          display_title: "main | ci | push",
          event: "push",
          conclusion,
          head_branch: "main",
        }),
        token: "test-token",
        defaultBranch: "main",
        request: async () => {
          requested = true;
        },
      }),
      /failed default-branch push/,
    );
    assert.equal(requested, false);
  }
});

test("requires a failed push on the exact default branch for post-merge triage", async () => {
  for (const override of [
    { event: "workflow_dispatch", head_branch: "main" },
    { event: "push", head_branch: undefined },
    { event: "push", head_branch: "release" },
  ]) {
    let requested = false;
    await assert.rejects(
      triagePostMergeFailure({
        repository: "AgoraIO-Extensions/agent-infra",
        sourceRun: sourceRun({
          name: "CI",
          display_title: "main | ci | push",
          event: "push",
          conclusion: "failure",
          ...override,
        }),
        token: "test-token",
        defaultBranch: "main",
        request: async () => {
          requested = true;
        },
      }),
      /failed default-branch push/,
    );
    assert.equal(requested, false);
  }
});

test("returns an unmapped post-merge result when no single primary Issue exists", async () => {
  const sha = "7".repeat(40);
  const result = await triagePostMergeFailure({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: sourceRun({
      id: 425,
      name: "CI",
      display_title: "main | ci | push",
      event: "push",
      conclusion: "failure",
      head_sha: sha,
      head_branch: "main",
    }),
    token: "test-token",
    defaultBranch: "main",
    request: async (apiPath) => {
      if (apiPath.endsWith(`/commits/${sha}/pulls`)) {
        return [{
          number: 105,
          merged_at: "2026-08-11T09:00:00Z",
          merge_commit_sha: sha,
          base: { ref: "main" },
          body: "No primary Issue reference",
        }];
      }
      throw new Error(`Unexpected request: ${apiPath}`);
    },
  });

  assert.equal(result, null);
});

test("returns an unmapped post-merge result when the primary Issue is missing", async () => {
  const sha = "6".repeat(40);
  const result = await triagePostMergeFailure({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: sourceRun({
      id: 426,
      name: "CI",
      display_title: "main | ci | push",
      event: "push",
      conclusion: "failure",
      head_sha: sha,
      head_branch: "main",
    }),
    token: "test-token",
    defaultBranch: "main",
    request: async (apiPath, options = {}) => {
      if (apiPath.endsWith(`/commits/${sha}/pulls`)) {
        return [{
          number: 105,
          merged_at: "2026-08-11T09:00:00Z",
          merge_commit_sha: sha,
          base: { ref: "main" },
          body: "Closes #999",
        }];
      }
      if (apiPath.endsWith("/issues/999")) {
        assert.equal(options.allowNotFound, true);
        return null;
      }
      throw new Error(`Unexpected request: ${apiPath}`);
    },
  });

  assert.equal(result, null);
});

test("degrades an unmapped post-merge failure to a generic terminal notification", async () => {
  const sha = "8".repeat(40);
  const checks = [];
  let deliveries = 0;
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith(`/commits/${sha}/pulls`)) return [];
    if (apiPath.includes(`/commits/${sha}/check-runs`)) {
      return { check_runs: checks };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 650,
        app: { id: 15368 },
        head_sha: sha,
        ...JSON.parse(options.body),
      };
      checks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/650") && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      Object.assign(checks[0], payload);
      return payload;
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 450,
        name: "CI",
        display_title: "main | ci | push",
        event: "push",
        conclusion: "failure",
        head_sha: sha,
        head_branch: "main",
      }),
    },
    token: "test-token",
    webhookUrl: "https://example.invalid/webhook",
    request,
    sendNotification: async () => {
      deliveries += 1;
      return {
        configured: true,
        delivered: true,
        attempts: [
          { attempt: 1, businessCode: 0, httpStatus: 200, status: "delivered" },
        ],
        warning: null,
      };
    },
    writeSummary: async () => {},
  });

  assert.equal(result.record.target.type, "main");
  assert.equal(result.record.outcome.code, "workflow_terminal_failure");
  assert.equal(deliveries, 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "completed");
});

test("processes a workflow event once and deduplicates notification replays", async () => {
  const checks = [];
  const requests = [];
  const summaries = [];
  let deliveries = 0;
  const request = async (apiPath, options = {}) => {
    requests.push({ apiPath, options });
    if (apiPath.endsWith("/issues/55")) {
      return {
        number: 55,
        state: "open",
        labels: [{ name: "needs-triage" }],
      };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [];
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
        const payload = JSON.parse(options.body);
        const check = {
          id: 700 + checks.length,
          app: { id: 15368 },
          head_sha: "d".repeat(40),
          ...payload,
        };
        checks.push(check);
        return check;
    }
    if (apiPath.includes(`/commits/${"d".repeat(40)}/check-runs`)) {
      return { check_runs: checks };
    }
    if (/\/check-runs\/\d+$/.test(apiPath) && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      Object.assign(checks.find((check) => apiPath.endsWith(`/${check.id}`)), payload);
      return payload;
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const event = {
    action: "completed",
    repository: {
      full_name: "AgoraIO-Extensions/agent-infra",
      default_branch: "main",
    },
    workflow_run: sourceRun({
      id: 500,
      conclusion: "failure",
      head_sha: "d".repeat(40),
    }),
  };
  const sendNotification = async () => {
    deliveries += 1;
    return {
      configured: true,
      delivered: false,
      attempts: [
        { attempt: 1, businessCode: null, httpStatus: 500, status: "failed" },
        { attempt: 2, businessCode: null, httpStatus: 500, status: "failed" },
        { attempt: 3, businessCode: null, httpStatus: 500, status: "failed" },
      ],
      warning: "delivery_failed",
    };
  };

  const first = await processWorkflowOutcome({
    event,
    token: "test-token",
    webhookUrl: "https://example.invalid/webhook",
    request,
    sendNotification,
    writeSummary: async (value) => summaries.push(value),
  });
  const replay = await processWorkflowOutcome({
    event,
    token: "test-token",
    webhookUrl: "https://example.invalid/webhook",
    request,
    sendNotification,
    writeSummary: async (value) => summaries.push(value),
  });

  assert.equal(first.record.outcome.code, "workflow_terminal_failure");
  assert.equal(first.notification.warning, "delivery_failed");
  assert.equal(replay.replay, true);
  assert.equal(deliveries, 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].external_id, "agent-infra:workflow-outcome:workflow-run-500:workflow_terminal_failure");
  assert.equal(summaries.length, 2);
  assert.match(summaries[0], /Notification: `delivery_failed`/);
  assert.match(summaries[1], /Notification: `deduplicated`/);
  assert.doesNotMatch(JSON.stringify({ checks, summaries }), /test-token|webhook/);
});

test("notifies one failed Automated Review Coverage Gate outcome", async () => {
  const headSha = "c".repeat(40);
  const outcomeChecks = [];
  const summaries = [];
  const deliveredReasons = [];
  const coverageCheck = {
    id: 800,
    app: { id: 4_503_079 },
    name: "Automated Review Coverage",
    head_sha: headSha,
    external_id: `agent-infra:pr:105:automated-review-coverage:${headSha}`,
    status: "completed",
    conclusion: "failure",
    output: {
      summary: [
        "provider: pr-agent",
        `head_sha: ${headSha}`,
        "reason_code: review-run-cancelled",
        "omitted_file_count: unknown",
      ].join("\n"),
    },
  };
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/pulls/105")) {
      return {
        number: 105,
        body: "",
        head: { sha: headSha, ref: "feat/review", repo: { full_name: "AgoraIO-Extensions/agent-infra" } },
        base: { ref: "main" },
        state: "open",
        draft: false,
        merged_at: null,
      };
    }
    if (apiPath.includes("check_name=Workflow%20Outcome")) {
      return { check_runs: outcomeChecks };
    }
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      return { check_runs: [coverageCheck], total_count: 1 };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 801 + outcomeChecks.length,
        app: { id: 15_368 },
        head_sha: headSha,
        ...JSON.parse(options.body),
      };
      outcomeChecks.push(check);
      return check;
    }
    const patchMatch = /\/check-runs\/(\d+)$/.exec(apiPath);
    if (patchMatch && options.method === "PATCH") {
      const check = outcomeChecks.find(
        (candidate) => candidate.id === Number(patchMatch[1]),
      );
      Object.assign(check, JSON.parse(options.body));
      return check;
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const event = {
    action: "completed",
    repository: {
      full_name: "AgoraIO-Extensions/agent-infra",
      default_branch: "main",
    },
    workflow_run: sourceRun({
      id: 580,
      name: "PR-Agent Review",
      display_title: "PR #105 | pr-agent-review | synchronize",
      event: "pull_request_target",
      head_sha: headSha,
      pull_requests: [{ number: 105, head: { sha: headSha } }],
    }),
  };
  const sendNotification = async ({ record }) => {
    deliveredReasons.push(record.reviewCoverage.reasonCode);
    assert.match(renderWeComMessage(record), /Provider: pr-agent/);
    assert.match(
      renderWeComMessage(record),
      new RegExp(`Reason: ${record.reviewCoverage.reasonCode}`),
    );
    return {
      configured: true,
      delivered: true,
      attempts: [{ attempt: 1, businessCode: 0, httpStatus: 200, status: "delivered" }],
      warning: null,
    };
  };

  const invoke = () =>
    processWorkflowOutcome({
      event,
      token: "test-token",
      webhookUrl: "https://example.invalid/webhook",
      request,
      sendNotification,
      writeSummary: async (value) => summaries.push(value),
    });
  const first = await invoke();
  const replay = await invoke();
  coverageCheck.output.summary = coverageCheck.output.summary.replace(
    "reason_code: review-run-cancelled",
    "reason_code: review-coverage-incomplete",
  );
  const changedReason = await invoke();

  assert.equal(first.record.outcome.code, "review_coverage_failed");
  assert.deepEqual(first.record.reviewCoverage, {
    provider: "pr-agent",
    reasonCode: "review-run-cancelled",
  });
  assert.equal(replay.replay, true);
  assert.equal(changedReason.replay, false);
  assert.deepEqual(deliveredReasons, [
    "review-run-cancelled",
    "review-coverage-incomplete",
  ]);
  assert.deepEqual(
    outcomeChecks.map((check) => check.external_id),
    [
      "agent-infra:workflow-outcome:review-coverage-check-800-pr-agent-review-run-cancelled:review_coverage_failed",
      "agent-infra:workflow-outcome:review-coverage-check-800-pr-agent-review-coverage-incomplete:review_coverage_failed",
    ],
  );
  assert.match(summaries[0], /Coverage reason: `review-run-cancelled`/);
  assert.match(summaries[2], /Coverage reason: `review-coverage-incomplete`/);
});

test("finds a semantic Check claim beyond the first filter=all page", async () => {
  const headSha = "8".repeat(40);
  const externalId =
    "agent-infra:workflow-outcome:workflow-run-510:workflow_terminal_failure";
  const existing = {
    id: 899,
    app: { id: 15368 },
    external_id: externalId,
    head_sha: headSha,
    status: "completed",
  };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: 1_000 + index,
    app: { id: 15368 },
    external_id: `other-${index}`,
    head_sha: headSha,
    status: "completed",
  }));
  const pages = [];
  let deliveries = 0;
  const request = async (apiPath) => {
    if (apiPath.endsWith("/issues/55")) {
      return { number: 55, state: "open", labels: [] };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [];
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      assert.match(apiPath, /check_name=Workflow%20Outcome&filter=all&per_page=100/);
      const page = Number(new URL(apiPath, "https://api.github.test").searchParams.get("page"));
      pages.push(page);
      return page === 1
        ? { total_count: 101, check_runs: firstPage }
        : { total_count: 101, check_runs: [existing] };
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 510,
        conclusion: "failure",
        head_sha: headSha,
      }),
    },
    token: "test-token",
    webhookUrl: "https://example.invalid/webhook",
    request,
    sendNotification: async () => {
      deliveries += 1;
    },
    writeSummary: async () => {},
  });

  assert.equal(result.replay, true);
  assert.equal(result.notification.warning, "deduplicated");
  assert.equal(deliveries, 0);
  assert.deepEqual(pages, [1, 2]);
});

test("elects one canonical Check after concurrent semantic claims", async () => {
  const headSha = "5".repeat(40);
  const externalId =
    "agent-infra:workflow-outcome:workflow-run-525:workflow_terminal_failure";
  const canonical = {
    id: 699,
    app: { id: 15368 },
    external_id: externalId,
    head_sha: headSha,
    status: "in_progress",
  };
  const checks = [];
  let checkReads = 0;
  let deliveries = 0;
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/55")) {
      return { number: 55, state: "open", labels: [] };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [];
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      checkReads += 1;
      return { check_runs: checkReads === 1 ? [] : [canonical, ...checks] };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 700,
        app: { id: 15368 },
        head_sha: headSha,
        ...JSON.parse(options.body),
      };
      checks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/700") && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      Object.assign(checks[0], payload);
      return payload;
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 525,
        conclusion: "failure",
        head_sha: headSha,
      }),
    },
    token: "test-token",
    webhookUrl: "https://example.invalid/webhook",
    request,
    sendNotification: async () => {
      deliveries += 1;
    },
    writeSummary: async () => {},
  });

  assert.equal(result.replay, true);
  assert.equal(result.notification.warning, "deduplicated");
  assert.equal(deliveries, 0);
  assert.equal(checks[0].status, "completed");
  assert.equal(checks[0].conclusion, "neutral");
});

test("fails loudly and preserves an interrupted notification claim", async () => {
  const headSha = "4".repeat(40);
  const check = {
    id: 750,
    app: { id: 15368 },
    external_id:
      "agent-infra:workflow-outcome:workflow-run-550:workflow_terminal_failure",
    head_sha: headSha,
    status: "in_progress",
  };
  let deliveries = 0;
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/55")) {
      return { number: 55, state: "open", labels: [] };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [];
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      return { check_runs: [check] };
    }
    if (apiPath.endsWith("/check-runs/750") && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      Object.assign(check, payload);
      return payload;
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  await assert.rejects(
    processWorkflowOutcome({
      event: {
        action: "completed",
        repository: {
          full_name: "AgoraIO-Extensions/agent-infra",
          default_branch: "main",
        },
        workflow_run: sourceRun({
          id: 550,
          conclusion: "failure",
          head_sha: headSha,
        }),
      },
      token: "test-token",
      webhookUrl: "https://example.invalid/webhook",
      request,
      sendNotification: async () => {
        deliveries += 1;
      },
      writeSummary: async () => {},
    }),
    /Notification claim 750 is incomplete and requires recovery/,
  );

  assert.equal(deliveries, 0);
  assert.equal(check.status, "in_progress");
  assert.equal(check.conclusion, undefined);
});

test("derives a final Worker failure from its trusted append-only audit", async () => {
  const attempt = {
    version: 1,
    issueNumber: 55,
    cycle: 2,
    workerRunId: "worker-500",
    baseSha: "e".repeat(40),
    attempt: 2,
    outcome: "non_retryable",
    terminationReason: "unsafe_artifact",
    remainingAcceptanceCriteria: ["AC-1"],
    checkpoint: null,
    recordedAt: "2026-08-11T09:59:00Z",
  };
  const comment = {
    id: 800,
    body: `<!-- agent-infra-worker-attempt:${Buffer.from(
      JSON.stringify(attempt),
      "utf8",
    ).toString("base64url")} -->`,
    created_at: attempt.recordedAt,
    updated_at: attempt.recordedAt,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const checks = [];
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/55")) {
      return { number: 55, state: "open", labels: [] };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [comment];
    if (apiPath.includes("/commits/") && apiPath.includes("/check-runs")) {
      return { check_runs: checks };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 801,
        app: { id: 15368 },
        head_sha: "e".repeat(40),
        ...JSON.parse(options.body),
      };
      checks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/801") && options.method === "PATCH") {
      return JSON.parse(options.body);
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 501,
        head_sha: "e".repeat(40),
        updated_at: "2026-08-11T10:00:00Z",
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request,
    writeSummary: async () => {},
  });

  assert.equal(result.record.cycle, 2);
  assert.equal(result.record.attempt, 2);
  assert.equal(result.record.outcome.code, "worker_final_failure");
  assert.equal(result.notification.warning, "webhook_not_configured");
});

test("does not reuse a Worker audit from before an unrelated source run", async () => {
  const attempt = {
    version: 1,
    issueNumber: 55,
    cycle: 1,
    workerRunId: "older-worker",
    baseSha: "e".repeat(40),
    attempt: 1,
    outcome: "non_retryable",
    terminationReason: "unsafe_artifact",
    remainingAcceptanceCriteria: ["AC-1"],
    checkpoint: null,
    recordedAt: "2026-08-11T08:00:00Z",
  };
  const comment = {
    id: 850,
    body: `<!-- agent-infra-worker-attempt:${Buffer.from(
      JSON.stringify(attempt),
      "utf8",
    ).toString("base64url")} -->`,
    created_at: attempt.recordedAt,
    updated_at: attempt.recordedAt,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const request = async (apiPath) => {
    if (apiPath.endsWith("/issues/55")) {
      return { number: 55, state: "open", labels: [] };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [comment];
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 502,
        name: "Claude Issue Review",
        display_title: "Issue #55 | claude-issue-review | opened",
        event: "issues",
        run_started_at: "2026-08-11T09:00:00Z",
        updated_at: "2026-08-11T10:00:00Z",
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request,
    writeSummary: async () => {},
  });

  assert.equal(result.record.outcome.code, "workflow_completed");
  assert.equal(result.record.attempt, null);
});

test("notifies one post-merge main failure across replayed observer events", async () => {
  const sha = "f".repeat(40);
  let issue = { number: 55, state: "closed", labels: [] };
  const comments = [];
  const checks = [];
  let deliveries = 0;
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith(`/commits/${sha}/pulls`)) {
      return [{
        number: 105,
        merged_at: "2026-08-11T09:00:00Z",
        merge_commit_sha: sha,
        base: { ref: "main" },
        body: "Closes #55",
      }];
    }
    if (apiPath.endsWith("/issues/55") && !options.method) return issue;
    if (apiPath.endsWith("/issues/55") && options.method === "PATCH") {
      issue = { ...issue, ...JSON.parse(options.body) };
      return issue;
    }
    if (apiPath.endsWith("/issues/55/labels") && options.method === "POST") {
      issue = { ...issue, labels: [{ name: "needs-triage" }] };
      return issue.labels;
    }
    if (apiPath.endsWith("/issues/55/comments") && !options.method) return comments;
    if (apiPath.endsWith("/issues/55/comments") && options.method === "POST") {
      const timestamp = "2026-08-11T10:00:00Z";
      const comment = {
        id: 900,
        body: JSON.parse(options.body).body,
        created_at: timestamp,
        updated_at: timestamp,
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
      };
      comments.push(comment);
      return comment;
    }
    if (apiPath.includes(`/commits/${sha}/check-runs`)) {
      return { check_runs: checks };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 901,
        app: { id: 15368 },
        head_sha: sha,
        ...JSON.parse(options.body),
      };
      checks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/901") && options.method === "PATCH") {
      const payload = JSON.parse(options.body);
      Object.assign(checks[0], payload);
      return payload;
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const event = {
    action: "completed",
    repository: {
      full_name: "AgoraIO-Extensions/agent-infra",
      default_branch: "main",
    },
    workflow_run: sourceRun({
      id: 600,
      name: "CI",
      display_title: "main | ci | push",
      event: "push",
      conclusion: "failure",
      head_sha: sha,
      head_branch: "main",
    }),
  };
  const sendNotification = async () => {
    deliveries += 1;
    return {
      configured: true,
      delivered: true,
      attempts: [
        { attempt: 1, businessCode: 0, httpStatus: 200, status: "delivered" },
      ],
      warning: null,
    };
  };
  const invoke = () =>
    processWorkflowOutcome({
      event,
      token: "test-token",
      webhookUrl: "https://example.invalid/webhook",
      request,
      sendNotification,
      writeSummary: async () => {},
    });

  await triagePostMergeFailure({
    repository: "AgoraIO-Extensions/agent-infra",
    sourceRun: event.workflow_run,
    token: "test-token",
    request,
    defaultBranch: "main",
  });
  const first = await invoke();
  const replay = await invoke();
  assert.equal(first.record.target.type, "issue");
  assert.equal(first.record.target.number, 55);
  assert.equal(first.record.outcome.code, "post_merge_failure");
  assert.equal(replay.replay, true);
  assert.equal(deliveries, 1);
  assert.equal(checks.length, 1);
  assert.equal(comments.length, 1);
});

test("derives dependency triage from a trusted Blocker Reconciler audit", async () => {
  const record = {
    version: 1,
    issueNumber: 55,
    blockers: [{ number: 54, status: "not_planned" }],
    state: "triage",
    reason: "blocker-not-planned",
    signature: "1".repeat(64),
  };
  const timestamp = "2026-08-11T09:59:00Z";
  const comment = {
    id: 1_000,
    body: `<!-- agent-infra-blocker-state:${Buffer.from(
      JSON.stringify(record),
      "utf8",
    ).toString("base64url")} -->`,
    created_at: timestamp,
    updated_at: timestamp,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const checks = [];
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/55")) {
      return { number: 55, state: "open", labels: [{ name: "needs-triage" }] };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [comment];
    if (apiPath.includes("/commits/") && apiPath.includes("/check-runs")) {
      return { check_runs: checks };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 1_001,
        app: { id: 15368 },
        head_sha: "1".repeat(40),
        ...JSON.parse(options.body),
      };
      checks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/1001") && options.method === "PATCH") {
      return JSON.parse(options.body);
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 700,
        name: "Blocker Reconciler",
        display_title: "Issue #55 | blocker-reconcile | closed",
        conclusion: "success",
        head_sha: "1".repeat(40),
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request,
    writeSummary: async () => {},
  });

  assert.equal(result.record.outcome.code, "dependency_triage");
  assert.equal(result.record.eventId, `blocker-state-${"1".repeat(64)}`);
});

test("derives current-head waiver use from trusted PR Gate Checks", async () => {
  const headSha = "2".repeat(40);
  const sourceHeadSha = "3".repeat(40);
  const gateChecks = [
    {
      id: 1_099,
      name: "Claude Review Gate",
      app: { id: 15_368 },
      head_sha: headSha,
      conclusion: "success",
      output: { summary: "reason_code: waived_infrastructure_failure" },
    },
    {
      id: 1_100,
      name: "Human Validation Gate",
      app: { id: 4_503_079 },
      head_sha: headSha,
      conclusion: "failure",
      output: { summary: "reason_code: pending" },
    },
    {
      id: 1_101,
      name: "Claude Review Gate",
      app: { id: 4_503_079 },
      head_sha: headSha,
      conclusion: "success",
      output: { summary: "reason_code: waived_infrastructure_failure" },
    },
  ];
  const outcomeChecks = [];
  const staleGateChecks = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: index === 0 ? "Claude Review Gate" : `Other ${index}`,
    app: { id: 4_503_079 },
    head_sha: headSha,
    conclusion: "failure",
    output: { summary: "reason_code: blocking_finding" },
  }));
  const gatePages = [];
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/pulls/105")) {
      return {
        number: 105,
        body: "Closes #55",
        head: { sha: headSha },
        merged_at: null,
      };
    }
    if (apiPath.endsWith("/issues/55")) {
      return {
        number: 55,
        state: "open",
        labels: [{ name: "ready-for-human" }],
      };
    }
    if (apiPath.endsWith("/issues/55/comments")) return [];
    if (apiPath.includes(`/commits/${headSha}/check-runs`)) {
      if (apiPath.includes("check_name=Workflow%20Outcome")) {
        return { check_runs: outcomeChecks };
      }
      assert.match(apiPath, /filter=all&per_page=100/);
      const page = Number(new URL(apiPath, "https://api.github.test").searchParams.get("page"));
      gatePages.push(page);
      return page === 1
        ? { total_count: 103, check_runs: staleGateChecks }
        : { total_count: 103, check_runs: gateChecks };
    }
    if (apiPath.endsWith("/check-runs") && options.method === "POST") {
      const check = {
        id: 1_102,
        app: { id: 15368 },
        head_sha: headSha,
        ...JSON.parse(options.body),
      };
      outcomeChecks.push(check);
      return check;
    }
    if (apiPath.endsWith("/check-runs/1102") && options.method === "PATCH") {
      return JSON.parse(options.body);
    }
    throw new Error(`Unexpected request: ${options.method ?? "GET"} ${apiPath}`);
  };
  const result = await processWorkflowOutcome({
    event: {
      action: "completed",
      repository: {
        full_name: "AgoraIO-Extensions/agent-infra",
        default_branch: "main",
      },
      workflow_run: sourceRun({
        id: 701,
        name: "PR Gates",
        display_title: "PR #105 | pr-gates | synchronize",
        event: "pull_request_target",
        conclusion: "success",
        head_sha: sourceHeadSha,
        pull_requests: [{ number: 105, head: { sha: headSha } }],
      }),
    },
    token: "test-token",
    webhookUrl: "",
    request,
    writeSummary: async () => {},
  });

  assert.equal(result.record.outcome.code, "waiver_used");
  assert.equal(result.record.eventId, "claude-waiver-check-1101");
  assert.equal(result.record.sourceRun.headSha, sourceHeadSha);
  assert.equal(result.record.checkHeadSha, headSha);
  assert.equal(outcomeChecks[0].head_sha, headSha);
  assert.deepEqual(gatePages, [1, 2]);
});

test("paginates trusted audit comments instead of truncating old Issues", async () => {
  const paths = [];
  const request = async (apiPath) => {
    paths.push(apiPath);
    return /[?&]page=1(?:&|$)/.test(apiPath)
      ? Array.from({ length: 100 }, (_, id) => ({ id: id + 1 }))
      : [{ id: 101 }];
  };
  const values = await githubPaginate("/repos/example/repo/issues/55/comments", {
    token: "test-token",
    request,
  });
  assert.equal(values.length, 101);
  assert.deepEqual(paths, [
    "/repos/example/repo/issues/55/comments?per_page=100&page=1",
    "/repos/example/repo/issues/55/comments?per_page=100&page=2",
  ]);
});
