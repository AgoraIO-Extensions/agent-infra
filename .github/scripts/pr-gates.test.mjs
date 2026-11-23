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

function claimedGateFixture() {
  const fixture = gateFixture();
  fixture.pr.body = [
    "Refs #42",
    "",
    "<!-- agent-provenance:start -->",
    "Agent: codex",
    "Agent-Session-ID: session-alpha",
    "<!-- agent-provenance:end -->",
  ].join("\n");
  fixture.pr.labels = [{ name: "agent:codex" }];
  fixture.issue = {
    number: 42,
    state: "open",
    labels: [],
    created_at: "2026-10-01T00:00:00Z",
    body: fixture.pr.body,
  };
  const comments = [];
  fixture.request = async (apiPath, options = {}) => {
    fixture.calls.push({ apiPath, ...options });
    if (apiPath === "/repos/example/repo/pulls/7") return structuredClone(fixture.pr);
    if (apiPath === "/repos/example/repo/issues/42") return structuredClone(fixture.issue);
    if (apiPath.startsWith("/repos/example/repo/issues/42/comments")) {
      const page = Number(new URL(`https://example.test${apiPath}`).searchParams.get("page"));
      return page === 1 ? comments.slice(0, 100) : comments.slice(100, 200);
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  fixture.comments = comments;
  return fixture;
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

test("Refs keeps the primary Issue open while retaining all Issue Gate checks", async () => {
  const fixture = gateFixture();
  fixture.pr.body = "Refs #42";
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  assert(fixture.calls.some((call) => call.apiPath.endsWith("/issues/42")));
  fixture.pr.body = "Refs #42\nCloses #42";
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
  assert.deepEqual(extractPrimaryIssueNumbers("```md\nRefs #9\n```\nRefs #42"), [42]);
  assert.deepEqual(extractPrimaryIssueNumbers("References #42\nRelated to #7"), []);
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

test("agent PR must match the Issue provenance claim exactly", async () => {
  const fixture = claimedGateFixture();
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  fixture.pr.body = fixture.pr.body.replace("session-alpha", "Session-Alpha");
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
});

test("an Issue without provenance starts unclaimed and accepts Handoff-From none", async () => {
  const fixture = claimedGateFixture();
  fixture.issue.body = "Problem\nNo provenance";
  fixture.comments.push({
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
    author_association: "COLLABORATOR",
    body: "<!-- agent-claim:start -->\nClaimed-By-Session: session-alpha\nHandoff-From: none\n<!-- agent-claim:end -->",
  });
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
});

test("valid handoffs replace the claim and stale or malformed handoffs do not", async () => {
  const fixture = claimedGateFixture();
  fixture.comments.push(
    {
      created_at: "2026-10-02T00:00:00Z",
      updated_at: "2026-10-02T00:00:00Z",
      author_association: "MEMBER",
      body: "<!-- agent-claim:start -->\nClaimed-By-Session: malformed\nHandoff-From: session-alpha\n<!-- agent-claim:end -->\n<!-- agent-claim:start -->\nClaimed-By-Session: duplicate\nHandoff-From: session-alpha\n<!-- agent-claim:end -->",
    },
    {
      created_at: "2026-10-02T12:00:00Z",
      updated_at: "2026-10-02T12:00:00Z",
      author_association: "NONE",
      body: "<!-- agent-claim:start -->\nClaimed-By-Session: unauthorized\nHandoff-From: session-alpha\n<!-- agent-claim:end -->",
    },
    {
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
      author_association: "MEMBER",
      body: "<!-- agent-claim:start -->\nClaimed-By-Session: session-beta\nHandoff-From: session-alpha\n<!-- agent-claim:end -->",
    },
    {
      created_at: "2026-10-04T00:00:00Z",
      updated_at: "2026-10-04T00:00:01Z",
      author_association: "OWNER",
      body: "<!-- agent-claim:start -->\nClaimed-By-Session: session-gamma\nHandoff-From: session-beta\n<!-- agent-claim:end -->",
    },
    {
      created_at: "2026-10-05T00:00:00Z",
      updated_at: "2026-10-05T00:00:00Z",
      author_association: "OWNER",
      body: "<!-- agent-claim:start -->\nClaimed-By-Session: session-delta\nHandoff-From: session-alpha\n<!-- agent-claim:end -->",
    },
  );
  fixture.pr.body = fixture.pr.body.replace("session-alpha", "session-beta");
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  fixture.pr.body = fixture.pr.body.replace("session-beta", "session-gamma");
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
});

test("claim comments require valid association and paginate", async () => {
  const fixture = claimedGateFixture();
  for (let index = 0; index < 100; index += 1) {
    fixture.comments.push({
      created_at: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      updated_at: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
      author_association: "NONE",
      body: "noise",
    });
  }
  fixture.comments.push({
    created_at: "2026-12-01T00:00:00Z",
    updated_at: "2026-12-01T00:00:00Z",
    author_association: "MEMBER",
    body: "<!-- agent-claim:start -->\nClaimed-By-Session: session-beta\nHandoff-From: session-alpha\n<!-- agent-claim:end -->",
  });
  fixture.pr.body = fixture.pr.body.replace("session-alpha", "session-beta");
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  assert(fixture.calls.some((call) => call.apiPath.includes("page=2")));
});

test("human PRs skip claim checks and comment API failures fail closed", async () => {
  const fixture = claimedGateFixture();
  fixture.pr.labels = [];
  fixture.request = async (apiPath) => {
    if (apiPath.includes("/pulls/7")) return structuredClone(fixture.pr);
    if (apiPath.includes("/issues/42")) return structuredClone(fixture.issue);
    throw new Error("comments must not be read for human PRs");
  };
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, true);
  const failing = claimedGateFixture();
  const original = failing.request;
  failing.request = async (apiPath, options) => {
    if (apiPath.includes("comments")) throw new Error("API down");
    return original(apiPath, options);
  };
  await assert.rejects(runGate({ ...failing, mode: "issue" }), /API down/);
});

test("an agent PR cannot pass when both PR and Issue have no session claim", async () => {
  const fixture = claimedGateFixture();
  fixture.pr.body = "Refs #42";
  fixture.issue.body = "Human-created Issue without an agent provenance block";
  assert.equal((await runGate({ ...fixture, mode: "issue" })).ok, false);
});

test("claim failures report bounded ignore counts without comment body or username", async () => {
  const fixture = claimedGateFixture();
  fixture.comments.push({
    created_at: "2026-10-03T00:00:00Z",
    updated_at: "2026-10-03T00:00:00Z",
    author_association: "CONTRIBUTOR",
    user: { id: 101, login: "private-user-name" },
    body: "private-comment-text\n<!-- agent-claim:start -->\nClaimed-By-Session: session-beta\nHandoff-From: session-alpha\n<!-- agent-claim:end -->",
  });
  fixture.pr.body = fixture.pr.body.replace("session-alpha", "session-beta");
  const result = await runGate({ ...fixture, mode: "issue" });
  assert.equal(result.ok, false);
  assert.match(result.description, /association=CONTRIBUTOR:1/);
  assert.doesNotMatch(result.description, /private-user-name|private-comment-text/);
});
