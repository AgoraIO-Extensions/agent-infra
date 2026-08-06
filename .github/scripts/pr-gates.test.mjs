import assert from "node:assert/strict";
import test from "node:test";

import {
  affectedPullRequests,
  auditDescription,
  buildCheckRunPayload,
  buildGateRecords,
  buildReviewState,
  claudeReviewGateUpdate,
  evaluateClaudeReviewGate,
  evaluateHumanValidationGate,
  evaluateIssueGate,
  extractPrimaryIssueNumbers,
  githubRequest,
  parseGateCommand,
  pendingGateNames,
  shouldReapplyHumanValidation,
} from "./pr-gates.mjs";

test("extracts one canonical primary Issue reference", () => {
  assert.deepEqual(
    extractPrimaryIssueNumbers("Summary\n\nCloses #42\n\nRelated to #7"),
    [42],
  );
});

test("scheduled membership reconciliation reevaluates every open PR", () => {
  const pulls = [
    { number: 1, body: "Closes #10" },
    { number: 2, body: "Closes #20" },
  ];
  assert.deepEqual(
    affectedPullRequests({ eventName: "schedule", pulls }),
    pulls,
  );
  assert.deepEqual(
    affectedPullRequests({ eventName: "issues", issueNumber: 20, pulls }),
    [pulls[1]],
  );
  assert.throws(() => affectedPullRequests({ eventName: "pull_request_target", pulls }));
});

test("allows idempotent GitHub DELETE requests to ignore a missing target", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    assert.equal(
      await githubRequest("/repos/example/repo/issues/1/labels/ready-for-human", {
        method: "DELETE",
        allowNotFound: true,
      }),
      null,
    );
    await assert.rejects(
      githubRequest("/repos/example/repo/issues/1/labels/ready-for-human", {
        method: "DELETE",
      }),
      /GitHub API DELETE .*: 404/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
  }
});

test("ignores closing keywords inside fenced examples", () => {
  assert.deepEqual(
    extractPrimaryIssueNumbers("```md\nCloses #9\n```\n\nCloses #42"),
    [42],
  );
});

test("Issue Gate rejects missing and duplicated primary Issues", () => {
  assert.equal(evaluateIssueGate({ issueNumbers: [] }).ok, false);
  assert.equal(evaluateIssueGate({ issueNumbers: [1, 2] }).ok, false);
});

test("Issue Gate accepts one open Issue without wontfix", () => {
  assert.deepEqual(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: { number: 42, state: "open", labels: [{ name: "bug" }] },
    }),
    { ok: true, description: "Primary Issue #42 is open" },
  );
});

test("Issue Gate rejects a closed or wontfix Issue", () => {
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: { number: 42, state: "closed", labels: [] },
    }).ok,
    false,
  );
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: { number: 42, state: "open", labels: [{ name: "wontfix" }] },
    }).ok,
    false,
  );
});

test("Issue Gate binds Worker branches to ready-for-agent Issues", () => {
  assert.deepEqual(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      headRef: "codex/issue-42",
    }),
    { ok: true, description: "Worker Issue #42 is ready for Agent" },
  );
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      headRef: "codex/issue-7",
    }).ok,
    false,
  );
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: { number: 42, state: "open", labels: [] },
      headRef: "codex/issue-42",
    }).ok,
    false,
  );
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      headRef: "codex/issue-not-a-number",
    }).ok,
    false,
  );
});

test("parses current-head validation and waiver commands with non-empty reasons", () => {
  const headSha = "a".repeat(40);
  assert.deepEqual(parseGateCommand(`/human-validation ${headSha}\nTested in staging.`), {
    type: "human-validation",
    headSha,
    reason: "Tested in staging.",
  });
  assert.deepEqual(
    parseGateCommand(`/claude-review-waiver ${headSha}\nProvider timeout.`),
    {
      type: "claude-review-waiver",
      headSha,
      reason: "Provider timeout.",
    },
  );
  assert.deepEqual(
    parseGateCommand(`/human-validation ${headSha}\r\nVerified in the browser.`),
    {
      type: "human-validation",
      headSha,
      reason: "Verified in the browser.",
    },
  );
  assert.equal(parseGateCommand(`/human-validation ${headSha}`), null);
  assert.equal(parseGateCommand("looks good"), null);
});

test("builds auditable gate records only for current-head comment commands", () => {
  const currentHead = "a".repeat(40);
  const oldHead = "b".repeat(40);
  const records = buildGateRecords({
    comments: [
      {
        body: `/human-validation ${currentHead}\nTested in staging.`,
        created_at: "2026-08-06T00:00:00Z",
        html_url: "https://github.com/example/repo/pull/1#issuecomment-1",
        user: { login: "owner", type: "User" },
      },
      {
        body: `/claude-review-waiver ${oldHead}\nOld failure.`,
        html_url: "https://github.com/example/repo/pull/1#issuecomment-2",
        user: { login: "owner", type: "User" },
      },
      {
        body: "looks good",
        html_url: "https://github.com/example/repo/pull/1#issuecomment-3",
        user: { login: "owner", type: "User" },
      },
    ],
    currentHead,
    memberships: new Map([["owner", { state: "active", role: "member" }]]),
  });
  assert.deepEqual(records, {
    confirmations: [
      {
        actor: { login: "owner", type: "User" },
        headSha: currentHead,
        membership: { state: "active", role: "member" },
        reason: "Tested in staging.",
        recordedAt: "2026-08-06T00:00:00Z",
        url: "https://github.com/example/repo/pull/1#issuecomment-1",
      },
    ],
    waivers: [],
  });
});

test("binds audit evidence to the exact actor selected by the Gate", () => {
  const records = {
    confirmations: [
      {
        actor: { login: "alice" },
        headSha: "a".repeat(40),
        reason: "Wrong record",
        recordedAt: "2026-08-06T00:00:00Z",
        url: "https://example.test/alice",
      },
      {
        actor: { login: "malice" },
        headSha: "a".repeat(40),
        reason: "Right record",
        recordedAt: "2026-08-06T00:01:00Z",
        url: "https://example.test/malice",
      },
    ],
    waivers: [],
  };
  assert.equal(
    auditDescription(
      {
        ok: true,
        description: "Human validation confirmed by malice for current head",
      },
      records,
      "human-validation",
    ),
    "Human validation confirmed by malice for current head\n\n" +
      "Reason: Right record\n\n" +
      "Recorded at: 2026-08-06T00:01:00Z\n\n" +
      "Evidence: https://example.test/malice",
  );
});

test("Human Validation Gate requires a current-head active Team member record", () => {
  const currentHead = "a".repeat(40);
  const valid = {
    actor: { login: "owner", type: "User" },
    headSha: currentHead,
    membership: { state: "active", role: "member" },
    reason: "Tested in staging.",
    recordedAt: "2026-08-06T00:00:00Z",
    url: "https://github.com/example/repo/pull/1#issuecomment-1",
  };
  assert.deepEqual(
    evaluateHumanValidationGate({
      labels: [{ name: "ready-for-human" }],
      validationWasRequired: true,
      currentHead,
      confirmations: [valid],
    }),
    {
      ok: true,
      removeLabel: true,
      description: "Human validation confirmed by owner for current head",
    },
  );
  for (const invalid of [
    { ...valid, headSha: "b".repeat(40) },
    { ...valid, actor: { login: "owner[bot]", type: "Bot" } },
    { ...valid, membership: { state: "pending", role: "member" } },
    { ...valid, membership: undefined },
    { ...valid, recordedAt: undefined },
  ]) {
    assert.equal(
      evaluateHumanValidationGate({
        labels: [],
        validationWasRequired: true,
        currentHead,
        confirmations: [invalid],
      }).ok,
      false,
    );
  }
  assert.deepEqual(
    evaluateHumanValidationGate({
      labels: [],
      validationWasRequired: false,
      currentHead,
      confirmations: [],
    }),
    { ok: true, removeLabel: false, description: "Human validation is not required" },
  );
});

test("Claude Review Gate accepts only current-head success or a bounded infrastructure waiver", () => {
  const currentHead = "a".repeat(40);
  const review = {
    appId: 15368,
    conclusion: "success",
    failureKind: null,
    headSha: currentHead,
    reasonCode: "success",
    status: "completed",
  };
  const waiver = {
    actor: { login: "owner", type: "User" },
    headSha: currentHead,
    membership: { state: "active", role: "member" },
    reason: "Provider timeout.",
    recordedAt: "2026-08-06T00:00:00Z",
    url: "https://github.com/example/repo/pull/1#issuecomment-2",
  };
  assert.deepEqual(
    evaluateClaudeReviewGate({ currentHead, review, waivers: [] }),
    { ok: true, waived: false, description: "Claude Review passed for current head" },
  );
  assert.deepEqual(
    evaluateClaudeReviewGate({
      currentHead,
      review: {
        ...review,
        conclusion: "failure",
        reasonCode: "blocking_finding",
        blockingFindingCount: 1,
      },
      publishedBlockingFindingCount: 1,
      waivers: [],
    }),
    { ok: true, waived: false, description: "Claude Review passed for current head" },
  );
  assert.deepEqual(
    evaluateClaudeReviewGate({
      currentHead,
      review: { ...review, conclusion: "failure", reasonCode: "unresolved_thread" },
      waivers: [],
    }),
    { ok: true, waived: false, description: "Claude Review passed for current head" },
  );
  for (const invalidReview of [
    undefined,
    { ...review, headSha: "b".repeat(40) },
    { ...review, status: "in_progress", conclusion: null },
    { ...review, appId: null },
  ]) {
    assert.equal(
      evaluateClaudeReviewGate({ currentHead, review: invalidReview, waivers: [] }).ok,
      false,
    );
  }
  assert.deepEqual(
    evaluateClaudeReviewGate({
      currentHead,
      review: {
        ...review,
        conclusion: "failure",
        failureKind: "infrastructure_failure",
        reasonCode: "infrastructure_failure",
      },
      waivers: [waiver],
    }),
    {
      ok: true,
      waived: true,
      description: "Claude Review infrastructure failure waived by owner for current head",
    },
  );
  const appliedWaiver = {
    ...review,
    conclusion: "success",
    failureKind: "infrastructure_failure",
    reasonCode: "waived_infrastructure_failure",
  };
  assert.equal(
    evaluateClaudeReviewGate({ currentHead, review: appliedWaiver, waivers: [] }).ok,
    false,
  );
  assert.deepEqual(
    evaluateClaudeReviewGate({ currentHead, review: appliedWaiver, waivers: [waiver] }),
    {
      ok: true,
      waived: true,
      description: "Claude Review infrastructure failure waived by owner for current head",
    },
  );
  for (const blocked of [
    {
      review: {
        ...review,
        conclusion: "failure",
        failureKind: "invalid_output",
        reasonCode: "invalid_output",
      },
      waivers: [waiver],
    },
    {
      review: {
        ...review,
        conclusion: "failure",
        failureKind: "infrastructure_failure",
        reasonCode: "infrastructure_failure",
      },
      waivers: [{ ...waiver, actor: { login: "owner[bot]", type: "Bot" } }],
    },
    {
      review: {
        ...review,
        conclusion: "failure",
        failureKind: "infrastructure_failure",
        reasonCode: "infrastructure_failure",
      },
      waivers: [waiver],
      hasPublishedBlockingFinding: true,
    },
    {
      review: {
        ...review,
        conclusion: "failure",
        failureKind: "infrastructure_failure",
        reasonCode: "infrastructure_failure",
      },
      waivers: [waiver],
      hasUnresolvedThread: true,
    },
  ]) {
    assert.equal(evaluateClaudeReviewGate({ currentHead, ...blocked }).ok, false);
  }
});

test("normalizes only current-head App Review state and blocking thread evidence", () => {
  const currentHead = "a".repeat(40);
  const oldHead = "b".repeat(40);
  const expectedExternalId = `agent-infra:pr:42:claude-review-gate:${currentHead}`;
  assert.deepEqual(
    buildReviewState({
      checkRuns: [
        {
          id: 1,
          name: "Claude Review Gate",
          head_sha: oldHead,
          app: { id: 15368 },
          external_id: expectedExternalId,
          status: "completed",
          conclusion: "success",
          output: { summary: "reason_code: success" },
        },
        {
          id: 2,
          name: "Claude Review Gate",
          head_sha: currentHead,
          app: { id: 15368 },
          external_id: expectedExternalId,
          status: "completed",
          conclusion: "failure",
          output: { summary: "reason_code: infrastructure_failure" },
        },
        {
          id: 3,
          name: "Claude Review Gate",
          head_sha: currentHead,
          app: { id: 999 },
          external_id: expectedExternalId,
          status: "completed",
          conclusion: "success",
          output: { summary: "reason_code: success" },
        },
        {
          id: 4,
          name: "Claude Review Gate",
          head_sha: currentHead,
          app: { id: 15368 },
          external_id: `agent-infra:pr:99:claude-review-gate:${currentHead}`,
          status: "completed",
          conclusion: "success",
          output: { summary: "reason_code: success" },
        },
      ],
      threads: [
        {
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: "github-actions" },
                body: `**P1: Bug**\n\n<!-- agent-infra-claude-review:${currentHead}:key -->`,
              },
            ],
          },
        },
      ],
      currentHead,
      prNumber: 42,
    }),
    {
      review: {
        appId: 15368,
        checkRunId: 2,
        conclusion: "failure",
        failureKind: "infrastructure_failure",
        headSha: currentHead,
        reasonCode: "infrastructure_failure",
        status: "completed",
      },
      hasPublishedBlockingFinding: true,
      hasUnresolvedThread: true,
    },
  );
});

test("preserves the trusted Review result beneath derived thread failures", () => {
  const currentHead = "a".repeat(40);
  const state = buildReviewState({
    checkRuns: [
      {
        id: 5,
        name: "Claude Review Gate",
        head_sha: currentHead,
        app: { id: 15368 },
        external_id: `agent-infra:pr:42:claude-review-gate:${currentHead}`,
        status: "completed",
        conclusion: "failure",
        output: {
          summary: "reason_code: blocking_finding\nblocking_finding_count: 1",
        },
      },
    ],
    threads: [
      {
        isResolved: true,
        comments: {
          nodes: [
            {
              author: { login: "github-actions" },
              body: `**P1: Fixed**\n\n<!-- agent-infra-claude-review:${currentHead}:key -->`,
            },
          ],
        },
      },
    ],
    currentHead,
    prNumber: 42,
  });
  assert.equal(
    state.review.reasonCode,
    "blocking_finding",
  );
  assert.equal(state.hasPublishedBlockingFinding, false);
  assert.equal(state.hasUnresolvedThread, false);
  assert.equal(
    evaluateClaudeReviewGate({
      currentHead,
      review: state.review,
      hasPublishedBlockingFinding: state.hasPublishedBlockingFinding,
      hasUnresolvedThread: state.hasUnresolvedThread,
      publishedBlockingFindingCount: state.publishedBlockingFindingCount,
    }).ok,
    true,
  );
});

test("keeps a blocking Review failed when its trusted finding comment is deleted", () => {
  const currentHead = "a".repeat(40);
  const state = buildReviewState({
    checkRuns: [
      {
        id: 6,
        name: "Claude Review Gate",
        head_sha: currentHead,
        app: { id: 15368 },
        external_id: `agent-infra:pr:42:claude-review-gate:${currentHead}`,
        status: "completed",
        conclusion: "failure",
        output: {
          summary: "reason_code: unresolved_thread\nblocking_finding_count: 2",
        },
      },
    ],
    threads: [
      {
        isResolved: true,
        comments: {
          nodes: [
            {
              author: { login: "github-actions" },
              body: `**P1: Fixed**\n\n<!-- agent-infra-claude-review:${currentHead}:key -->`,
            },
          ],
        },
      },
    ],
    currentHead,
    prNumber: 42,
  });

  assert.deepEqual(
    evaluateClaudeReviewGate({ currentHead, ...state }),
    {
      ok: false,
      waived: false,
      reasonCode: "blocking_finding",
      description: "Blocking Review finding evidence is incomplete",
    },
  );
});

test("a new commit restores a previously required human validation label", () => {
  assert.equal(
    shouldReapplyHumanValidation({
      action: "synchronize",
      labels: [],
      events: [{ event: "labeled", label: { name: "ready-for-human" } }],
    }),
    true,
  );
});

test("label removal can complete validation until another commit", () => {
  const events = [{ event: "labeled", label: { name: "ready-for-human" } }];
  assert.equal(
    shouldReapplyHumanValidation({ action: "unlabeled", labels: [], events }),
    false,
  );
  assert.equal(
    shouldReapplyHumanValidation({
      action: "synchronize",
      labels: [{ name: "ready-for-human" }],
      events,
    }),
    false,
  );
});

test("gate Check Runs bind the expected App result to the current head", () => {
  const headSha = "a".repeat(40);
  assert.deepEqual(
    buildCheckRunPayload({
      name: "Issue Gate",
      headSha,
      prNumber: 42,
      status: "completed",
      conclusion: "success",
      description: "Re-evaluating PR metadata",
      targetUrl: "https://github.com/example/repo/pull/1",
    }),
    {
      name: "Issue Gate",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      details_url: "https://github.com/example/repo/pull/1",
      external_id: `agent-infra:pr:42:issue-gate:${headSha}`,
      output: {
        title: "Issue Gate: success",
        summary: "Re-evaluating PR metadata",
      },
    },
  );
  assert.throws(() =>
    buildCheckRunPayload({
      name: "Issue Gate",
      headSha: "stale",
      prNumber: 42,
      status: "in_progress",
      description: "Re-evaluating PR metadata",
      targetUrl: "https://github.com/example/repo/pull/1",
    }),
  );
});

test("PR Gates never creates a competing Claude Review Gate", () => {
  assert.deepEqual(pendingGateNames(), ["Issue Gate", "Human Validation Gate"]);
});

test("revokes an applied waiver when its current audit record becomes invalid", () => {
  assert.deepEqual(
    claudeReviewGateUpdate({
      result: { ok: true, waived: true, description: "Approved waiver" },
      review: { reasonCode: "infrastructure_failure" },
    }),
    {
      conclusion: "success",
      description: "Approved waiver",
      reasonCode: "waived_infrastructure_failure",
    },
  );
  assert.deepEqual(
    claudeReviewGateUpdate({
      result: { ok: false, waived: false, description: "Waiver is invalid" },
      review: { reasonCode: "waived_infrastructure_failure" },
    }),
    {
      conclusion: "failure",
      description: "Waiver is invalid",
      reasonCode: "infrastructure_failure",
    },
  );
  assert.equal(
    claudeReviewGateUpdate({
      result: { ok: true, waived: false, description: "Review passed" },
      review: { reasonCode: "success" },
    }),
    null,
  );
});

test("writes blocking Review thread state to the Gate and restores Review success", () => {
  assert.deepEqual(
    claudeReviewGateUpdate({
      result: {
        ok: false,
        waived: false,
        reasonCode: "blocking_finding",
        description: "P0/P1 finding cannot be waived",
      },
      review: { reasonCode: "success" },
    }),
    {
      conclusion: "failure",
      description: "P0/P1 finding cannot be waived",
      reasonCode: "blocking_finding",
    },
  );
  assert.deepEqual(
    claudeReviewGateUpdate({
      result: {
        ok: false,
        waived: false,
        reasonCode: "unresolved_thread",
        description: "Blocking Review thread is unresolved",
      },
      review: { reasonCode: "blocking_finding", blockingFindingCount: 2 },
    }),
    {
      conclusion: "failure",
      description: "Blocking Review thread is unresolved",
      reasonCode: "unresolved_thread",
      blockingFindingCount: 2,
    },
  );
  assert.deepEqual(
    claudeReviewGateUpdate({
      result: { ok: true, waived: false, description: "Claude Review passed" },
      review: { reasonCode: "unresolved_thread", blockingFindingCount: 2 },
    }),
    {
      conclusion: "success",
      description: "Claude Review passed",
      reasonCode: "success",
      blockingFindingCount: 2,
    },
  );
  assert.equal(
    claudeReviewGateUpdate({
      result: {
        ok: false,
        waived: false,
        reasonCode: "blocking_finding",
        description: "P0/P1 finding cannot be waived",
      },
      review: { reasonCode: "infrastructure_failure" },
    }),
    null,
  );
});
