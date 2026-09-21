import assert from "node:assert/strict";
import test from "node:test";

import {
  validateSupervisedBranch,
  validateSupervisedIssue,
} from "./connection-pr-preflight.mjs";

const body = `## Problem

Late release failures.

## Scope

Add deterministic checks.

## Acceptance criteria

- [ ] **AC-1:** Validate delivery inputs.

## Validation

Run focused tests.

## Blocked by

None`;

test("accepts a supervised branch and complete Issue", () => {
  validateSupervisedBranch("codex/connection-release-preflight");
  assert.deepEqual(
    validateSupervisedIssue({
      body,
      labels: [{ name: "ready-for-human" }],
      number: 647,
      state: "OPEN",
      title: "Release preflight",
    }).acceptanceCriteriaIds,
    ["AC-1"],
  );
});

test("rejects reserved Worker branches", () => {
  assert.throws(
    () => validateSupervisedBranch("codex/issue-647-release-preflight"),
    /reserved/,
  );
});

test("rejects incomplete supervised Issues", () => {
  assert.throws(
    () =>
      validateSupervisedIssue({
        body,
        labels: [],
        number: 647,
        state: "OPEN",
        title: "Release preflight",
      }),
    /ready-for-human/,
  );
  assert.throws(() =>
    validateSupervisedIssue({
      body: body.replace("## Validation", "## Checks"),
      labels: [{ name: "ready-for-human" }],
      number: 647,
      state: "OPEN",
      title: "Release preflight",
    }),
  );
});
