import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkerAttemptComment,
  buildPullRequestRecoveryComment,
  classifyCiFailure,
  parsePullRequestRecoveryRecords,
  parseWorkerAttemptRecords,
  planPullRequestRecovery,
  planWorkerAttempt,
} from "./worker-resilience.mjs";

const identity = {
  issueNumber: 54,
  cycle: 2,
  workerRunId: "54-2-0123456789abcdef0123456789abcdef01234567",
  baseSha: "0123456789abcdef0123456789abcdef01234567",
};

test("advances a recoverable Worker run only from its trusted checkpoint", () => {
  const checkpoint = {
    ...identity,
    sourceAttempt: 1,
    patchSha256: "a".repeat(64),
    remainingAcceptanceCriteria: ["AC-2"],
  };

  assert.deepEqual(
    planWorkerAttempt({
      identity,
      controlState: "active",
      attempts: [{ attempt: 1, outcome: "recoverable", checkpoint }],
    }),
    { operation: "invoke", attempt: 2, checkpoint },
  );
});

test("stops a Worker run after its third recoverable model attempt", () => {
  const attempts = [1, 2, 3].map((attempt) => ({
    attempt,
    outcome: "recoverable",
    checkpoint: {
      ...identity,
      sourceAttempt: attempt,
      patchSha256: "a".repeat(64),
      remainingAcceptanceCriteria: ["AC-2"],
    },
  }));

  assert.deepEqual(
    planWorkerAttempt({ identity, controlState: "active", attempts }),
    { operation: "terminal", reason: "attempts_exhausted", attemptsUsed: 3 },
  );
});

test("counts an interrupted started attempt and resumes from the last valid checkpoint", () => {
  const checkpoint = {
    ...identity,
    sourceAttempt: 1,
    patchSha256: "a".repeat(64),
    remainingAcceptanceCriteria: ["AC-2"],
  };
  const attempts = [
    { attempt: 1, outcome: "recoverable", checkpoint },
    { attempt: 2, outcome: "started", checkpoint: null },
  ];

  assert.deepEqual(
    planWorkerAttempt({ identity, controlState: "active", attempts }),
    { operation: "invoke", attempt: 3, checkpoint },
  );
});

test("does not invoke the model after success, a non-retryable error, or a pause", () => {
  const completed = [{ attempt: 1, outcome: "completed" }];
  const rejected = [
    {
      attempt: 1,
      outcome: "non_retryable",
      terminationReason: "checkpoint_rejected",
    },
  ];

  assert.deepEqual(
    planWorkerAttempt({ identity, controlState: "active", attempts: completed }),
    { operation: "terminal", reason: "completed", attemptsUsed: 1 },
  );
  assert.deepEqual(
    planWorkerAttempt({ identity, controlState: "active", attempts: rejected }),
    {
      operation: "terminal",
      reason: "checkpoint_rejected",
      attemptsUsed: 1,
    },
  );
  assert.deepEqual(
    planWorkerAttempt({ identity, controlState: "paused", attempts: rejected }),
    { operation: "pause", reason: "worker-paused", attemptsUsed: 1 },
  );
});

test("round-trips append-only Worker attempt state for later runs", () => {
  const checkpoint = {
    ...identity,
    sourceAttempt: 1,
    patchSha256: "a".repeat(64),
    artifactRunId: 123456,
    artifactName: `codex-worker-checkpoint-${identity.workerRunId}-attempt-1`,
    remainingAcceptanceCriteria: ["AC-2"],
  };
  const record = {
    version: 1,
    ...identity,
    attempt: 1,
    outcome: "recoverable",
    terminationReason: "timeout",
    remainingAcceptanceCriteria: ["AC-2"],
    checkpoint,
    recordedAt: "2026-08-10T00:00:00.000Z",
  };
  const comments = [
    {
      id: 99,
      body: buildWorkerAttemptComment(record),
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
      created_at: "2026-08-10T00:00:00Z",
      updated_at: "2026-08-10T00:00:00Z",
      html_url: "https://github.com/owner/repo/issues/54#issuecomment-99",
    },
  ];

  assert.deepEqual(parseWorkerAttemptRecords(comments, identity), [
    { ...record, commentId: 99, commentUrl: comments[0].html_url },
  ]);
});

test("collapses a started attempt into its append-only terminal transition", () => {
  const started = {
    version: 1,
    ...identity,
    attempt: 1,
    outcome: "started",
    terminationReason: "model_started",
    remainingAcceptanceCriteria: ["AC-1", "AC-2"],
    checkpoint: null,
    recordedAt: "2026-08-10T00:00:00.000Z",
  };
  const finished = {
    ...started,
    outcome: "completed",
    terminationReason: "completed",
    remainingAcceptanceCriteria: [],
    recordedAt: "2026-08-10T00:01:00.000Z",
  };
  const comment = (id, record, timestamp) => ({
    id,
    body: buildWorkerAttemptComment(record),
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: timestamp,
    updated_at: timestamp,
    html_url: `https://github.com/owner/repo/issues/54#issuecomment-${id}`,
  });

  assert.deepEqual(
    parseWorkerAttemptRecords(
      [
        comment(100, started, "2026-08-10T00:00:00Z"),
        comment(101, finished, "2026-08-10T00:01:00Z"),
      ],
      identity,
    ),
    [
      {
        ...finished,
        commentId: 101,
        commentUrl:
          "https://github.com/owner/repo/issues/54#issuecomment-101",
      },
    ],
  );
});

test("ignores trusted attempt records from another Worker run", () => {
  const record = {
    version: 1,
    ...identity,
    workerRunId: "another-run",
    attempt: 1,
    outcome: "completed",
    terminationReason: "completed",
    remainingAcceptanceCriteria: [],
    checkpoint: null,
    recordedAt: "2026-08-10T00:01:00.000Z",
  };
  const comment = {
    id: 102,
    body: buildWorkerAttemptComment(record),
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: "2026-08-10T00:01:00Z",
    updated_at: "2026-08-10T00:01:00Z",
  };

  assert.deepEqual(parseWorkerAttemptRecords([comment], identity), []);
});

test("retries the first deterministic CI failure without code before repair", () => {
  const headSha = "c".repeat(40);
  const fingerprint = "d".repeat(64);
  const event = {
    kind: "ci_failure",
    headSha,
    failureClass: "deterministic",
    fingerprint,
  };

  assert.deepEqual(
    planPullRequestRecovery({ event, headSha, noCodeRetries: [], repairRounds: [] }),
    {
      operation: "retry_ci",
      reason: "first_ci_failure",
      headSha,
      fingerprint,
    },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      event,
      headSha,
      noCodeRetries: [{ headSha, fingerprint }],
      repairRounds: [],
    }),
    {
      operation: "repair",
      reason: "repeated_deterministic_ci_failure",
      headSha,
      round: 1,
    },
  );
  assert.equal(
    planPullRequestRecovery({
      event: { ...event, fingerprint: "e".repeat(64) },
      headSha,
      noCodeRetries: [{ headSha, fingerprint }],
      repairRounds: [],
    }).operation,
    "repair",
  );
});

test("classifies only repository validation steps as deterministic CI failures", () => {
  const deterministic = classifyCiFailure([
    {
      name: "Docs CI",
      conclusion: "failure",
      steps: [{ name: "Run tests", conclusion: "failure" }],
    },
  ]);
  const infrastructure = classifyCiFailure([
    {
      name: "Docs CI",
      conclusion: "failure",
      steps: [{ name: "Install dependencies", conclusion: "failure" }],
    },
  ]);
  const markdown = classifyCiFailure([
    {
      name: "Docs CI",
      conclusion: "failure",
      steps: [{ name: "Lint Markdown", conclusion: "failure" }],
    },
  ]);

  assert.equal(deterministic.failureClass, "deterministic");
  assert.equal(markdown.failureClass, "deterministic");
  assert.match(deterministic.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(infrastructure.failureClass, "infrastructure");
  assert.notEqual(infrastructure.fingerprint, deterministic.fingerprint);
});

test("uses the immutable source commit of a GitHub Actions Claude finding", () => {
  const headSha = "6".repeat(40);
  assert.deepEqual(
    planPullRequestRecovery({
      event: {
        kind: "claude_blocking",
        headSha,
        reviewComments: [
          {
            id: 3_734_920_271,
            user: {
              id: 41_898_282,
              login: "github-actions[bot]",
              type: "Bot",
            },
            performed_via_github_app: null,
            commit_id: "1".repeat(40),
            original_commit_id: headSha,
            path: ".github/scripts/blocker-contract.mjs",
            line: 398,
            body: `**P1: Mutable blocker identity**\n\nUse immutable content.\n\n<!-- agent-infra-claude-review:${headSha}:trusted-key -->`,
          },
        ],
      },
      headSha,
      noCodeRetries: [],
      repairRounds: [],
    }),
    {
      operation: "repair",
      reason: "claude_p0_p1",
      headSha,
      round: 1,
      recoveryContext: [
        "P1 at .github/scripts/blocker-contract.mjs:398\nMutable blocker identity\nUse immutable content.",
      ],
    },
  );
});

test("shares two repair rounds across CI and Claude while infrastructure never repairs", () => {
  const headSha = "c".repeat(40);
  const claudeComment = (severity, overrides = {}) => ({
    id: 100,
    user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: null,
    commit_id: headSha,
    original_commit_id: headSha,
    path: "apps/web/src/app.tsx",
    line: 42,
    body: `**${severity}: Broken authorization**\n\nDo not trust @actor input.\n\n<!-- agent-infra-claude-review:${headSha}:trusted-key -->`,
    ...overrides,
  });
  assert.deepEqual(
    planPullRequestRecovery({
      event: {
        kind: "claude_blocking",
        headSha,
        reviewComments: [claudeComment("P1")],
      },
      headSha,
      noCodeRetries: [],
      repairRounds: [{ round: 1, reason: "ci" }],
    }),
    {
      operation: "repair",
      reason: "claude_p0_p1",
      headSha,
      round: 2,
      recoveryContext: [
        "P1 at apps/web/src/app.tsx:42\nBroken authorization\nDo not trust @\u200bactor input.",
      ],
    },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      event: {
        kind: "claude_blocking",
        headSha,
        reviewComments: [claudeComment("P0")],
      },
      headSha,
      noCodeRetries: [],
      repairRounds: [{ round: 1 }, { round: 2 }],
    }),
    {
      operation: "triage",
      reason: "repair_budget_exhausted",
      headSha,
      roundsUsed: 2,
    },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      event: {
        kind: "claude_blocking",
        headSha,
        reviewComments: [
          claudeComment("P1", {
            user: { id: 999, login: "github-actions[bot]", type: "Bot" },
          }),
          claudeComment("P1", { original_commit_id: "e".repeat(40) }),
        ],
      },
      headSha,
      noCodeRetries: [],
      repairRounds: [],
    }),
    { operation: "triage", reason: "claude_findings_unavailable", headSha },
  );
  assert.equal(
    planPullRequestRecovery({
      event: {
        kind: "ci_failure",
        headSha,
        failureClass: "infrastructure",
        fingerprint: "d".repeat(64),
      },
      headSha,
      noCodeRetries: [{ headSha, fingerprint: "d".repeat(64) }],
      repairRounds: [],
    }).operation,
    "triage",
  );
});

test("updates a clean base, triages conflicts, and reuses only an existing no-change PR", () => {
  const headSha = "c".repeat(40);
  const baseSha = "e".repeat(40);
  const common = { headSha, noCodeRetries: [], repairRounds: [] };

  assert.deepEqual(
    planPullRequestRecovery({
      ...common,
      event: { kind: "base_advanced", headSha, baseSha, mergeable: "clean" },
    }),
    { operation: "update_base", reason: "clean_base_update", headSha, baseSha },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      ...common,
      event: { kind: "base_advanced", headSha, baseSha, mergeable: "conflicting" },
    }),
    { operation: "triage", reason: "base_update_conflict", headSha },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      ...common,
      event: { kind: "base_advanced", headSha, baseSha, mergeable: "unknown" },
    }),
    { operation: "noop", reason: "mergeability_pending", headSha },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      ...common,
      event: { kind: "no_change", headSha, draftPrNumber: 84 },
    }),
    { operation: "reuse_pr", reason: "no_change", headSha, pullRequestNumber: 84 },
  );
  assert.deepEqual(
    planPullRequestRecovery({
      ...common,
      event: { kind: "no_change", headSha, draftPrNumber: null },
    }),
    {
      operation: "triage",
      reason: "no_change",
      headSha,
      createPullRequest: false,
      closeIssue: false,
    },
  );
});

test("round-trips trusted CI retry and shared repair budget records", () => {
  const headSha = "c".repeat(40);
  const base = {
    version: 1,
    issueNumber: 54,
    cycle: 2,
    pullRequestNumber: 90,
    headSha,
    recordedAt: "2026-08-10T00:00:00.000Z",
  };
  const retry = {
    ...base,
    action: "ci_retry",
    fingerprint: "d".repeat(64),
    round: 0,
    reason: "first_ci_failure",
  };
  const repair = {
    ...base,
    action: "repair",
    fingerprint: null,
    round: 1,
    reason: "repeated_deterministic_ci_failure",
  };
  const comment = (id, record) => ({
    id,
    body: buildPullRequestRecoveryComment(record),
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: `2026-08-10T00:0${id - 200}:00Z`,
    updated_at: `2026-08-10T00:0${id - 200}:00Z`,
    html_url: `https://github.com/owner/repo/pull/90#issuecomment-${id}`,
  });

  assert.deepEqual(
    parsePullRequestRecoveryRecords([comment(200, retry), comment(201, repair)], {
      issueNumber: 54,
      cycle: 2,
      pullRequestNumber: 90,
    }),
    {
      noCodeRetries: [{ ...retry, commentId: 200 }],
      repairRounds: [{ ...repair, commentId: 201 }],
    },
  );
});
