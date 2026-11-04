import assert from "node:assert/strict";
import test from "node:test";

import {
  latestCiRun,
  rerunCiForWaiver,
  waiverDecision,
} from "./ci-waiver.mjs";

const repository = "example/agent-infra";
const headSha = "a".repeat(40);

function pullRequest(overrides = {}) {
  return {
    number: 8,
    state: "open",
    head: { sha: headSha, repo: { full_name: repository } },
    ...overrides,
  };
}

test("acts only on ci:skip changes of an open same-repository PR", () => {
  for (const action of ["labeled", "unlabeled"]) {
    assert.deepEqual(
      waiverDecision({ event: { action, label: { name: "ci:skip" } }, pullRequest: pullRequest(), repository }),
      { act: true, headSha, number: 8 },
    );
  }
  for (const [event, overrides, reason] of [
    [{ action: "opened", label: { name: "ci:skip" } }, {}, "unsupported action"],
    [{ action: "labeled", label: { name: "agent:kiro" } }, {}, "not the CI waiver label"],
    [{ action: "labeled" }, {}, "not the CI waiver label"],
    [{ action: "labeled", label: { name: "ci:skip" } }, { state: "closed" }, "pull request is not open"],
    [{ action: "labeled", label: { name: "ci:skip" } }, { head: { sha: headSha, repo: { full_name: "outside/fork" } } }, "pull request head is outside this repository"],
    [{ action: "labeled", label: { name: "ci:skip" } }, { head: { sha: "main", repo: { full_name: repository } } }, "pull request head SHA is unavailable"],
  ]) {
    assert.deepEqual(
      waiverDecision({ event, pullRequest: pullRequest(overrides), repository }),
      { act: false, reason },
    );
  }
});

test("selects the newest pull_request CI run of the live head, preferring this PR", () => {
  const run = (id, overrides = {}) => ({
    id, head_sha: headSha, event: "pull_request", status: "completed", pull_requests: [{ number: 8 }], ...overrides,
  });
  assert.equal(latestCiRun([], { headSha, number: 8 }), null);
  assert.equal(latestCiRun([run(1), run(3), run(2)], { headSha, number: 8 }).id, 3);
  assert.equal(
    latestCiRun([run(5, { head_sha: "b".repeat(40) }), run(4, { event: "push" }), run(2)], { headSha, number: 8 }).id,
    2,
  );
  // Another PR on the same commit cannot steal the rerun when this PR has one.
  assert.equal(latestCiRun([run(9, { pull_requests: [{ number: 9 }] }), run(6)], { headSha, number: 8 }).id, 6);
  // Without PR links in the listing, the head's newest run is still used.
  assert.equal(latestCiRun([run(7, { pull_requests: [] })], { headSha, number: 8 }).id, 7);
});

function fakeGitHub({ runs = [], statuses = [], cancelError } = {}) {
  const calls = [];
  const remaining = [...statuses];
  const request = async (path, options = {}) => {
    calls.push(`${options.method ?? "GET"} ${path}`);
    if (path.includes("/workflows/ci.yml/runs?")) return { workflow_runs: runs };
    if (path.endsWith("/cancel")) {
      if (cancelError) throw cancelError;
      return null;
    }
    if (path.endsWith("/rerun")) return null;
    return { status: remaining.length ? remaining.shift() : "completed" };
  };
  return { calls, request };
}

const sleep = async () => {};

test("reruns a completed CI run so the live label decides waiver or validation", async () => {
  const github = fakeGitHub({ runs: [{ id: 41, head_sha: headSha, event: "pull_request", status: "completed", pull_requests: [{ number: 8 }] }] });
  assert.deepEqual(
    await rerunCiForWaiver({ repository, headSha, number: 8, request: github.request, sleep }),
    { result: "rerun", runId: 41 },
  );
  assert.deepEqual(github.calls, [
    `GET /repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${headSha}&event=pull_request&per_page=50`,
    `POST /repos/${repository}/actions/runs/41/rerun`,
  ]);
});

test("cancels an active CI run and waits for it to stop before the rerun", async () => {
  const github = fakeGitHub({
    runs: [{ id: 42, head_sha: headSha, event: "pull_request", status: "in_progress", pull_requests: [{ number: 8 }] }],
    statuses: ["in_progress", "completed"],
  });
  assert.deepEqual(
    await rerunCiForWaiver({ repository, headSha, number: 8, request: github.request, sleep }),
    { result: "cancelled-and-rerun", runId: 42 },
  );
  assert.deepEqual(github.calls.slice(1), [
    `POST /repos/${repository}/actions/runs/42/cancel`,
    `GET /repos/${repository}/actions/runs/42`,
    `GET /repos/${repository}/actions/runs/42`,
    `POST /repos/${repository}/actions/runs/42/rerun`,
  ]);
});

test("tolerates a run that finished before cancel and fails closed if it never stops", async () => {
  const finished = Object.assign(new Error("conflict"), { status: 409 });
  const raced = fakeGitHub({
    runs: [{ id: 43, head_sha: headSha, event: "pull_request", status: "queued", pull_requests: [{ number: 8 }] }],
    cancelError: finished,
  });
  assert.deepEqual(
    await rerunCiForWaiver({ repository, headSha, number: 8, request: raced.request, sleep }),
    { result: "rerun", runId: 43 },
  );
  const stuck = fakeGitHub({
    runs: [{ id: 44, head_sha: headSha, event: "pull_request", status: "in_progress", pull_requests: [{ number: 8 }] }],
    statuses: Array(10).fill("in_progress"),
  });
  await assert.rejects(
    rerunCiForWaiver({ repository, headSha, number: 8, request: stuck.request, sleep, maxPolls: 3 }),
    /did not stop before the rerun/,
  );
  assert(!stuck.calls.some((call) => call.endsWith("/rerun")));
  const denied = fakeGitHub({
    runs: [{ id: 45, head_sha: headSha, event: "pull_request", status: "in_progress", pull_requests: [{ number: 8 }] }],
    cancelError: Object.assign(new Error("forbidden"), { status: 403 }),
  });
  await assert.rejects(
    rerunCiForWaiver({ repository, headSha, number: 8, request: denied.request, sleep }),
    /forbidden/,
  );
});

test("does nothing when the head has no CI run yet", async () => {
  const github = fakeGitHub();
  assert.deepEqual(
    await rerunCiForWaiver({ repository, headSha, number: 8, request: github.request, sleep }),
    { result: "no-ci-run" },
  );
  assert.equal(github.calls.length, 1);
});
