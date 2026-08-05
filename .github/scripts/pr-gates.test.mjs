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
