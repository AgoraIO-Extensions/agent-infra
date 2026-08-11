import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStatusPayload,
  evaluateHumanValidationGate,
  evaluateIssueGate,
  extractPrimaryIssueNumbers,
  shouldReapplyHumanValidation,
} from "./pr-gates.mjs";

test("extracts one canonical primary Issue reference", () => {
  assert.deepEqual(
    extractPrimaryIssueNumbers("Summary\n\nCloses #42\n\nRelated to #7"),
    [42],
  );
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

test("Issue Gate accepts one open Issue created before the PR", () => {
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
    { ok: true, description: "Primary Issue #42 predates this PR and is open" },
  );
});

test("Issue Gate rejects a primary Issue that does not predate the PR", () => {
  for (const [issueCreatedAt, pullRequestCreatedAt] of [
    ["2026-08-11T09:00:00Z", "2026-08-11T09:00:00Z"],
    ["2026-08-11T10:00:00Z", "2026-08-11T09:00:00Z"],
    [undefined, "2026-08-11T09:00:00Z"],
    ["2026-08-11T08:00:00Z", undefined],
  ]) {
    assert.equal(
      evaluateIssueGate({
        issueNumbers: [42],
        issue: {
          number: 42,
          state: "open",
          labels: [],
          created_at: issueCreatedAt,
        },
        pullRequestCreatedAt,
      }).ok,
      false,
    );
  }
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

test("Human Validation Gate fails only while ready-for-human is present", () => {
  assert.equal(evaluateHumanValidationGate([{ name: "ready-for-human" }]).ok, false);
  assert.equal(evaluateHumanValidationGate([{ name: "bug" }]).ok, true);
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

test("metadata changes reset both merge gates to pending before evaluation", () => {
  assert.deepEqual(
    buildStatusPayload({
      state: "pending",
      context: "Issue Gate",
      description: "Re-evaluating PR metadata",
      targetUrl: "https://github.com/example/repo/pull/1",
    }),
    {
      state: "pending",
      context: "Issue Gate",
      description: "Re-evaluating PR metadata",
      target_url: "https://github.com/example/repo/pull/1",
    },
  );
});
