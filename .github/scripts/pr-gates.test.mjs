import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGateRecords,
  evaluateHumanValidationGate,
  evaluateIssueGate,
  extractPrimaryIssueNumbers,
  runGate,
  shouldReapplyHumanValidation,
} from "./pr-gates.mjs";

function gateFixture({ action = "edited", labels = [], events = [], actor, membership } = {}) {
  const head = "a".repeat(40);
  const pr = {
    number: 7, head: { sha: head }, body: "Closes #42", labels,
    created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-03T00:00:00Z",
    html_url: "https://github.com/example/repo/pull/7",
  };
  const event = {
    action, pull_request: structuredClone(pr), sender: actor,
    label: { name: "ready-for-human" },
  };
  const calls = [];
  const request = async (apiPath, options = {}) => {
    calls.push({ apiPath, ...options });
    if (apiPath === "/repos/example/repo/pulls/7") return structuredClone(pr);
    if (apiPath === "/repos/example/repo/issues/42") return {
      number: 42, state: "open", labels: [], created_at: "2026-10-01T00:00:00Z",
    };
    if (apiPath.includes("/events?")) return events;
    if (apiPath.includes("/memberships/")) return membership;
    if (apiPath.endsWith("/labels") && options.method === "POST") return [];
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  return { pr, event, calls, request, repository: "example/repo" };
}

test("native Issue job reads the live primary Issue and rejects missing references", async () => {
  const fixture = gateFixture();
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  fixture.pr.body = "No primary Issue";
  fixture.calls.length = 0;
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
  assert.equal(fixture.calls.length, 1);
});

test("stale PR events cannot validate either job or write labels", async () => {
  for (const mode of ["issue", "human"]) {
    const fixture = gateFixture();
    fixture.pr.head.sha = "b".repeat(40);
    assert.equal((await runGate({ ...fixture, mode })).ok, false);
    assert.equal(fixture.calls.length, 1);
  }
});

test("human job needs no Team lookup when validation was never required", async () => {
  const fixture = gateFixture();
  assert.equal((await runGate({ ...fixture, mode: "human" })).ok, true);
  assert.equal(fixture.calls.some((call) => call.tokenEnvironment), false);
});

test("an active human Team member can confirm validation on the event head", async () => {
  const fixture = gateFixture({
    action: "unlabeled", actor: { login: "owner", type: "User" },
    membership: { state: "active", role: "member" },
  });
  assert.equal((await runGate({ ...fixture, mode: "human" })).ok, true);
  assert.equal(fixture.calls.find((call) => call.apiPath.includes("/memberships/"))?.tokenEnvironment,
    "TEAM_MEMBERSHIP_TOKEN");
  assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
});

test("Bots and nonmembers cannot clear human validation", async () => {
  for (const actor of [{ login: "robot[bot]", type: "Bot" }, { login: "outsider", type: "User" }]) {
    const fixture = gateFixture({ action: "unlabeled", actor, membership: null });
    assert.equal((await runGate({ ...fixture, mode: "human" })).ok, false);
    const write = fixture.calls.find((call) => call.method === "POST");
    assert.deepEqual(JSON.parse(write.body), { labels: ["ready-for-human"] });
  }
});

test("a synchronize event restores an earlier human validation requirement", async () => {
  const fixture = gateFixture({
    action: "synchronize", events: [{ event: "labeled", label: { name: "ready-for-human" } }],
  });
  assert.equal((await runGate({ ...fixture, mode: "human" })).ok, false);
  assert.equal(fixture.calls.at(-1).method, "POST");
});

test("Team lookup errors fail the job instead of accepting validation", async () => {
  const fixture = gateFixture({ action: "unlabeled", actor: { login: "owner", type: "User" } });
  const request = async (apiPath, options) => {
    if (apiPath.includes("/memberships/")) throw new Error("Membership unavailable");
    return fixture.request(apiPath, options);
  };
  await assert.rejects(runGate({ ...fixture, mode: "human", request }), /Membership unavailable/);
  assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
});

test("a head change during evaluation prevents label restoration", async () => {
  const fixture = gateFixture({ action: "unlabeled", actor: { login: "robot[bot]", type: "Bot" } });
  let reads = 0;
  const request = async (apiPath, options) => {
    if (apiPath.endsWith("/pulls/7") && ++reads > 1) return { head: { sha: "b".repeat(40) } };
    return fixture.request(apiPath, options);
  };
  await assert.rejects(runGate({ ...fixture, mode: "human", request }), /head changed before label update/);
  assert.equal(fixture.calls.some((call) => call.method === "POST"), false);
});

test("incomplete event pagination fails closed", async () => {
  const fixture = gateFixture({ events: Array.from({ length: 100 }, () => ({ event: "commented" })) });
  await assert.rejects(runGate({ ...fixture, mode: "human" }), /pagination limit/);
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
