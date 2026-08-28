import assert from "node:assert/strict";
import test from "node:test";

import { parsePilotIssueNumber, validatePilotSnapshot } from "./gh-aw-pilot.mjs";
import { executionContent } from "./worker-contract.mjs";

const issue = {
  number: 42,
  state: "open",
  title: "Implement the pilot target",
  body: `## Problem

Problem

## Scope

Scope

## Acceptance criteria

- [ ] **AC-1:** Complete the target.

## Validation

Run tests.

## Blocked by

None
`,
  labels: [{ name: "enhancement" }],
};

const valid = {
  repository: "AgoraIO-Extensions/agent-infra",
  issueNumber: 42,
  issue,
  blockers: [],
  activePullRequests: [],
  branchExists: false,
  actor: "LichKing-2234",
  triggeringActor: "LichKing-2234",
  expectedActor: "LichKing-2234",
  actorAccount: { type: "User" },
  membership: { state: "active", role: "member" },
  phase: "authorize",
  expectedExecutionContentHash: executionContent(issue).hash,
};

test("authorizes and rechecks one unchanged pilot target", () => {
  const authorized = validatePilotSnapshot(valid);
  assert.equal(authorized.category, "enhancement");
  assert.match(authorized.targetHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    validatePilotSnapshot({
      ...valid,
      phase: "recheck",
      expectedTargetHash: authorized.targetHash,
    }),
    authorized,
  );
});

test("rejects alternate Issue spellings and unauthorized execution content", () => {
  assert.equal(parsePilotIssueNumber("42"), 42);
  for (const value of ["042", "42 ", "0", "-1", "x"]) {
    assert.throws(() => parsePilotIssueNumber(value), /Issue number/);
  }
  assert.throws(
    () =>
      validatePilotSnapshot({
        ...valid,
        expectedExecutionContentHash: "0".repeat(64),
      }),
    /dispatch authorization/,
  );
  assert.throws(
    () =>
      validatePilotSnapshot({
        ...valid,
        phase: "recheck",
        expectedTargetHash: "0".repeat(64),
      }),
    /changed after authorization/,
  );
});

test("fails closed across actor, Team, Issue, blocker, and ownership boundaries", () => {
  const cases = [
    [{ triggeringActor: "other-admin" }, /operator/],
    [{ actorAccount: { type: "Bot" } }, /membership/],
    [{ membership: { state: "inactive", role: "member" } }, /membership/],
    [{ issue: { ...issue, state: "closed" } }, /open Issue/],
    [
      { issue: { ...issue, labels: [{ name: "bug" }, { name: "enhancement" }] } },
      /one source category/,
    ],
    [
      { blockers: [{ number: 7, state: "open", state_reason: null, labels: [] }] },
      /incomplete native blocker/,
    ],
    [{ activePullRequests: [{ number: 9 }] }, /active implementation/],
    [{ branchExists: true }, /active implementation/],
  ];
  for (const [overrides, error] of cases) {
    assert.throws(() => validatePilotSnapshot({ ...valid, ...overrides }), error);
  }
});
