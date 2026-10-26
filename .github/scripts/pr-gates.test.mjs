import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateIssueGate,
  extractPrimaryIssueNumbers,
  runGate,
} from "./pr-gates.mjs";

function gateFixture() {
  const head = "a".repeat(40);
  const pr = {
    number: 7,
    head: { sha: head },
    body: "Closes #42",
    created_at: "2026-10-02T00:00:00Z",
  };
  const event = { action: "edited", pull_request: structuredClone(pr) };
  const calls = [];
  const request = async (apiPath, options = {}) => {
    calls.push({ apiPath, ...options });
    if (apiPath === "/repos/example/repo/pulls/7") return structuredClone(pr);
    if (apiPath === "/repos/example/repo/issues/42") return {
      number: 42,
      state: "open",
      labels: [],
      created_at: "2026-10-01T00:00:00Z",
    };
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  return { pr, event, calls, request, repository: "example/repo" };
}

test("the native Issue job reads the live primary Issue and rejects missing references", async () => {
  const fixture = gateFixture();
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  fixture.pr.body = "No primary Issue";
  fixture.calls.length = 0;
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
  assert.equal(fixture.calls.length, 1);
});

test("stale PR events cannot validate the Issue job", async () => {
  const fixture = gateFixture();
  fixture.pr.head.sha = "b".repeat(40);
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
  assert.equal(fixture.calls.length, 1);
});

test("the removed human gate is not an accepted mode", async () => {
  await assert.rejects(
    runGate({ ...gateFixture(), mode: "human" }),
    /Expected issue gate/,
  );
});

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

test("Issue Gate accepts existing Issues without wontfix", () => {
  for (const state of ["open", "closed"]) {
    assert.deepEqual(
      evaluateIssueGate({
        issueNumbers: [42],
        issue: {
          number: 42,
          state,
          labels: [{ name: "bug" }],
          created_at: "2026-08-11T08:00:00Z",
        },
        pullRequestCreatedAt: "2026-08-11T09:00:00Z",
      }),
      { ok: true, description: "Primary Issue #42 exists" },
    );
  }
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

test("Issue Gate rejects a wontfix Issue", () => {
  assert.equal(
    evaluateIssueGate({
      issueNumbers: [42],
      issue: {
        number: 42,
        state: "closed",
        labels: [{ name: "wontfix" }],
        created_at: "2026-08-11T08:00:00Z",
      },
      pullRequestCreatedAt: "2026-08-11T09:00:00Z",
    }).ok,
    false,
  );
});
