import assert from "node:assert/strict";
import test from "node:test";

import * as prGates from "./pr-gates.mjs";
import {
  affectedPullRequests,
  auditDescription,
  buildCheckRunPayload,
  buildGateRecords,
  evaluateHumanValidationGate,
  evaluateIssueGate,
  evaluateIssueReadinessGate,
  extractPrimaryIssueNumbers,
  shouldReapplyHumanValidation,
} from "./pr-gates.mjs";
import { buildAcceptanceCriteriaEvidenceMarker } from "./worker-contract.mjs";

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
  assert.deepEqual(
    affectedPullRequests({ eventName: "issue_comment", issueNumber: 10, pulls }),
    [pulls[0]],
  );
  assert.throws(() => affectedPullRequests({ eventName: "pull_request_target", pulls }));
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
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "bug" }],
        created_at: "2026-08-11T08:00:00Z",
      },
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
    }),
    { ok: true, description: "Primary Issue #42 is open" },
  );
});

test("Issue Gate requires the primary Issue to predate the PR", () => {
  const issue = {
    number: 42,
    state: "open",
    labels: [],
    created_at: "2026-08-11T08:00:00Z",
  };
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue,
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
    }).ok,
    true,
  );
  for (const pullRequestCreatedAt of [
    "2026-08-11T08:00:00Z",
    "2026-08-11T07:00:00Z",
    undefined,
  ]) {
    assert.equal(
      evaluateIssueGate({ issueNumbers: [42], issue, pullRequestCreatedAt }).ok,
      false,
    );
  }
  assert.equal(
    evaluateIssueGate({
      issue: { ...issue, created_at: undefined },
      issueNumbers: [42],
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
    }).ok,
    false,
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
        created_at: "2026-08-11T08:00:00Z",
      },
      headRef: "codex/issue-42-cycle-1",
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
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
        created_at: "2026-08-11T08:00:00Z",
      },
      headRef: "codex/issue-7-cycle-1",
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
    }).ok,
    false,
  );
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: {
        number: 42,
        state: "open",
        labels: [],
        created_at: "2026-08-11T08:00:00Z",
      },
      headRef: "codex/issue-42-cycle-1",
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
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
        created_at: "2026-08-11T08:00:00Z",
      },
      headRef: "codex/issue-not-a-number",
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
    }).ok,
    false,
  );
});

test("Issue Readiness Gate is not applicable to human PRs", () => {
  assert.deepEqual(
    evaluateIssueReadinessGate({
      repository: "AgoraIO-Extensions/agent-infra",
      defaultBranch: "main",
      pullRequest: { head: { ref: "feat/human" } },
    }),
    {
      ok: true,
      applicable: false,
      description: "not_applicable: human-authored PR",
    },
  );
});

test("Issue Readiness Gate binds cycle, content, ownership, blockers, and AC evidence", () => {
  const contract = {
    hash: "d".repeat(64),
    blockedByHash: "b".repeat(64),
    acceptanceCriteriaIds: ["AC-1", "AC-2"],
  };
  const authorizationRecord = {
    issueNumber: 42,
    cycle: 3,
    state: "active",
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
  };
  const marker = buildAcceptanceCriteriaEvidenceMarker(
    [
      { id: "AC-1", status: "pass", evidence: "unit test" },
      { id: "AC-2", status: "not_applicable", evidence: "no runtime dependency" },
    ],
    contract.acceptanceCriteriaIds,
  );
  const pullRequest = {
    number: 9,
    body: `Closes #42\n\n## 验收标准\n\n${marker}`,
    head: {
      ref: "codex/issue-42-cycle-3",
      repo: { full_name: "AgoraIO-Extensions/agent-infra" },
    },
    base: { ref: "main" },
  };
  const issue = {
    number: 42,
    state: "open",
    labels: [{ name: "ready-for-agent" }],
  };
  const workerPullRequests = [
    {
      number: 9,
      state: "open",
      merged_at: null,
      head: { ref: "codex/issue-42-cycle-3" },
    },
  ];
  const input = {
    repository: "AgoraIO-Extensions/agent-infra",
    defaultBranch: "main",
    pullRequest,
    issue,
    blockers: [],
    workerPullRequests,
    contract,
    authorizationRecord,
  };
  assert.deepEqual(evaluateIssueReadinessGate(input), {
    ok: true,
    applicable: true,
    description: "Worker Issue #42 cycle 3 is ready for review",
  });
  assert.equal(
    evaluateIssueReadinessGate({
      ...input,
      authorizationRecord: {
        ...authorizationRecord,
        executionContentHash: "e".repeat(64),
      },
    }).ok,
    false,
  );
  assert.equal(
    evaluateIssueReadinessGate({
      ...input,
      authorizationRecord: {
        ...authorizationRecord,
        blockedByHash: "c".repeat(64),
      },
    }).ok,
    false,
  );
  assert.equal(
    evaluateIssueReadinessGate({
      ...input,
      blockers: [{ number: 7, state: "open" }],
    }).ok,
    false,
  );
  for (const blocker of [
    { number: 7, state: "closed", state_reason: "not_planned" },
    { number: 7, state: "closed", state_reason: null },
    {
      number: 7,
      state: "closed",
      state_reason: "completed",
      labels: [{ name: "wontfix" }],
    },
  ]) {
    assert.equal(
      evaluateIssueReadinessGate({ ...input, blockers: [blocker] }).ok,
      false,
    );
  }
  assert.equal(
    evaluateIssueReadinessGate({
      ...input,
      blockers: [{ number: 7, state: "closed", state_reason: "completed" }],
    }).ok,
    true,
  );
  assert.equal(
    evaluateIssueReadinessGate({
      ...input,
      pullRequest: { ...pullRequest, body: "Closes #42" },
    }).ok,
    false,
  );
});

test("builds validation from label removal", () => {
  const currentHead = "a".repeat(40);
  const validationEvent = {
    event: "unlabeled",
    label: { name: "ready-for-human" },
    actor: { login: "validator", type: "User" },
    created_at: "2026-08-06T00:01:00Z",
    url: "https://api.github.com/repos/example/repo/issues/events/2",
  };
  const records = buildGateRecords({
    events: [
      {
        event: "labeled",
        label: { name: "ready-for-human" },
        actor: { login: "owner", type: "User" },
        created_at: "2026-08-06T00:00:00Z",
        url: "https://api.github.com/repos/example/repo/issues/events/1",
      },
      validationEvent,
    ],
    currentHead,
    memberships: new Map([
      ["owner", { state: "active", role: "member" }],
      ["validator", { state: "active", role: "member" }],
    ]),
  });
  assert.deepEqual(records, {
    validation: {
      actor: { login: "validator", type: "User" },
      headSha: currentHead,
      membership: { state: "active", role: "member" },
      reason: "ready-for-human removed",
      recordedAt: "2026-08-06T00:01:00Z",
      url: "https://api.github.com/repos/example/repo/issues/events/2",
    },
  });
  assert.deepEqual(
    buildGateRecords({
      events: [],
      event: {
        action: "unlabeled",
        label: { name: "ready-for-human" },
        sender: validationEvent.actor,
        pull_request: {
          head: { sha: currentHead },
          updated_at: validationEvent.created_at,
          html_url: validationEvent.url,
        },
      },
      currentHead,
      memberships: new Map([
        ["validator", { state: "active", role: "member" }],
      ]),
    }).validation,
    records.validation,
  );
});

test("binds audit evidence to the exact actor selected by the Gate", () => {
  const records = {
    validation: {
      actor: { login: "validator" },
      headSha: "a".repeat(40),
      reason: "ready-for-human removed",
      recordedAt: "2026-08-06T00:01:00Z",
      url: "https://api.github.com/repos/example/repo/issues/events/2",
    },
  };
  assert.equal(
    auditDescription(
      {
        ok: true,
        description: "Human validation confirmed by validator for current head",
      },
      records,
    ),
    "Human validation confirmed by validator for current head\n\n" +
      "Reason: ready-for-human removed\n\n" +
      "Recorded at: 2026-08-06T00:01:00Z\n\n" +
      "Evidence: https://api.github.com/repos/example/repo/issues/events/2",
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
      labels: [],
      validationWasRequired: true,
      currentHead,
      validation: valid,
    }),
    {
      ok: true,
      description: "Human validation confirmed by owner for current head",
    },
  );
  assert.equal(
    evaluateHumanValidationGate({
      labels: [{ name: "ready-for-human" }],
      validationWasRequired: true,
      currentHead,
      validation: valid,
    }).ok,
    false,
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
        validation: invalid,
      }).ok,
      false,
    );
  }
  assert.deepEqual(
    evaluateHumanValidationGate({
      labels: [],
      validationWasRequired: false,
      currentHead,
      validation: null,
    }),
    { ok: true, description: "Human validation is not required" },
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

test("Gate publication authenticates only with the check-only token", async () => {
  const previousFetch = globalThis.fetch;
  const previousGateToken = process.env.GATE_CHECK_TOKEN;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  let authorization;
  process.env.GATE_CHECK_TOKEN = "gate-token";
  process.env.GITHUB_TOKEN = "workflow-token";
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    return { ok: true, status: 204 };
  };
  try {
    await prGates.gateCheckRequest("/repos/example/repo/check-runs", {
      method: "POST",
    });
    assert.equal(authorization, "Bearer gate-token");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousGateToken === undefined) delete process.env.GATE_CHECK_TOKEN;
    else process.env.GATE_CHECK_TOKEN = previousGateToken;
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
  }
});
