import assert from "node:assert/strict";
import test from "node:test";

import {
  dependentReconciliationDecision,
  reconcileRepository,
} from "./blocker-reconciler.mjs";
import {
  buildBlockerIssue,
  buildBlockerReviewAck,
  buildBlockerStateComment,
  buildWorkerDispatchAck,
  classifyDependentBlockers,
  inspectBlockerGraph,
  parseBlockerProposalRecord,
} from "./blocker-contract.mjs";
import {
  authorizeCycle,
  buildAuthorizationRecordComment,
  executionContent,
  parseBlockedBy,
} from "./worker-contract.mjs";

function issue(number, blockers = [], overrides = {}) {
  return {
    id: number * 1_000,
    number,
    state: "open",
    state_reason: null,
    labels: [{ name: "ready-for-agent" }],
    body: [
      "## Problem",
      "",
      `Issue ${number}`,
      "",
      "## Scope",
      "",
      "Scope",
      "",
      "## Acceptance criteria",
      "",
      "- [ ] **AC-1:** Outcome",
      "",
      "## Validation",
      "",
      "Validation",
      "",
      "## Blocked by",
      "",
      ...(blockers.length ? blockers.map((blocker) => `- #${blocker}`) : ["None"]),
      "",
    ].join("\n"),
    ...overrides,
  };
}

function appComment(id, body) {
  const timestamp = new Date(Date.UTC(2026, 7, 6, 0, 0, id)).toISOString();
  return {
    id,
    body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function mockGitHub(issues) {
  const comments = new Map();
  const events = new Map();
  const nativeDependencies = new Map();
  for (const source of issues) {
    let blockerNumbers = [];
    try {
      blockerNumbers = parseBlockedBy(source.body, { issueNumber: source.number });
    } catch {
      // Invalid body fixtures intentionally start with no native mirror.
    }
    nativeDependencies.set(
      source.number,
      blockerNumbers
        .map((number) => issues.find((candidate) => candidate.number === number))
        .filter(Boolean),
    );
  }
  const calls = [];
  let commentId = 100;
  const paginate = async (apiPath) => {
    if (apiPath.includes("/issues?state=all")) return issues;
    const match = /\/issues\/(\d+)\/comments/.exec(apiPath);
    if (match) return comments.get(Number(match[1])) ?? [];
    const eventMatch = /\/issues\/(\d+)\/events/.exec(apiPath);
    if (eventMatch) return events.get(Number(eventMatch[1])) ?? [];
    const nativeMatch = /\/issues\/(\d+)\/dependencies\/blocked_by/.exec(apiPath);
    if (nativeMatch) return nativeDependencies.get(Number(nativeMatch[1])) ?? [];
    throw new Error(`Unexpected pagination path: ${apiPath}`);
  };
  const request = async (apiPath, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ apiPath, method: options.method ?? "GET", body });
    const commentMatch = /\/issues\/(\d+)\/comments$/.exec(apiPath);
    if (commentMatch && options.method === "POST") {
      const issueNumber = Number(commentMatch[1]);
      const values = comments.get(issueNumber) ?? [];
      values.push(appComment(commentId, body.body));
      commentId += 1;
      comments.set(issueNumber, values);
      return values.at(-1);
    }
    const labelMatch = /\/issues\/(\d+)\/labels$/.exec(apiPath);
    if (labelMatch && options.method === "POST") {
      const target = issues.find((entry) => entry.number === Number(labelMatch[1]));
      for (const label of body.labels) {
        if (!target.labels.some((entry) => entry.name === label)) {
          target.labels.push({ name: label });
        }
      }
      return target.labels;
    }
    const nativeMatch = /\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(apiPath);
    if (nativeMatch && options.method === "POST") {
      const sourceNumber = Number(nativeMatch[1]);
      const blocker = issues.find((entry) => entry.id === body.issue_id);
      if (!blocker) throw new Error("Unknown native blocker fixture");
      const values = nativeDependencies.get(sourceNumber) ?? [];
      if (!values.some((entry) => entry.number === blocker.number)) values.push(blocker);
      nativeDependencies.set(sourceNumber, values);
      return null;
    }
    if (apiPath.endsWith("/dispatches") && options.method === "POST") {
      const payload = body.client_payload;
      const values = comments.get(payload.issue_number) ?? [];
      if (body.event_type === "claude-blocker-review") {
        const target = issues.find((entry) => entry.number === payload.issue_number);
        values.push(
          appComment(
            commentId,
            buildBlockerReviewAck(
              payload.issue_number,
              parseBlockerProposalRecord(target, { trusted: false }),
            ),
          ),
        );
        commentId += 1;
        comments.set(payload.issue_number, values);
        return null;
      }
      values.push(
        appComment(
          commentId,
          buildWorkerDispatchAck(
            payload.issue_number,
            payload.blocker_state_signature,
            payload.operation,
          ),
        ),
      );
      commentId += 1;
      comments.set(payload.issue_number, values);
      return null;
    }
    const issueMatch = /\/issues\/(\d+)$/.exec(apiPath);
    if (issueMatch && options.method === "PATCH") {
      const target = issues.find((entry) => entry.number === Number(issueMatch[1]));
      if (typeof body.body === "string") target.body = body.body;
      return target;
    }
    throw new Error(`Unexpected request: ${options.method} ${apiPath}`);
  };
  return { calls, comments, events, nativeDependencies, paginate, request };
}

test("derives blocked, frontier, and triage actions without creating authorization", () => {
  const graph = inspectBlockerGraph([
    issue(1, [2]),
    issue(2, [], { state: "closed", state_reason: "completed" }),
  ]);
  const frontier = classifyDependentBlockers(graph, 1);
  assert.deepEqual(
    dependentReconciliationDecision({ issue: graph.issuesByNumber.get(1), state: frontier }),
    {
      addTriage: false,
      comment: true,
      dispatch: { operation: "evaluate", reason: "blockers-completed" },
    },
  );

  const notPlannedGraph = inspectBlockerGraph([
    issue(1, [2]),
    issue(2, [], { state: "closed", state_reason: "not_planned" }),
  ]);
  const triage = classifyDependentBlockers(notPlannedGraph, 1);
  assert.deepEqual(
    dependentReconciliationDecision({
      issue: notPlannedGraph.issuesByNumber.get(1),
      state: triage,
    }),
    {
      addTriage: true,
      comment: true,
      dispatch: { operation: "triage", reason: "blocker-not-planned" },
    },
  );
});

test("reconciles a two-level DAG once and suppresses a second identical run", async () => {
  const issues = [
    issue(1, [2]),
    issue(2, [3]),
    issue(3, [], { state: "closed", state_reason: "completed" }),
  ];
  const github = mockGitHub(issues);
  const first = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.deepEqual(
    first.outcomes.map(({ issueNumber, state, decision }) => ({
      issueNumber,
      state: state.state,
      operation: decision.dispatch?.operation ?? null,
    })),
    [
      { issueNumber: 1, state: "blocked", operation: "pause" },
      { issueNumber: 2, state: "frontier", operation: "evaluate" },
    ],
  );
  assert.equal(
    github.calls.filter((call) => call.apiPath.endsWith("/dispatches")).length,
    2,
  );
  assert.equal(
    github.calls.filter((call) => call.apiPath.endsWith("/comments")).length,
    2,
  );

  const before = github.calls.length;
  const second = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.deepEqual(github.calls.slice(before), []);
  assert.equal(second.outcomes.every(({ decision }) => !decision.comment), true);
});

test("not-planned and wontfix blockers triage dependents idempotently", async () => {
  const issues = [
    issue(1, [2]),
    issue(2, [], {
      state: "closed",
      state_reason: "completed",
      labels: [{ name: "wontfix" }],
    }),
  ];
  const github = mockGitHub(issues);
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(
    issues[0].labels.some((label) => label.name === "needs-triage"),
    true,
  );
  const audit = github.comments.get(1)[0];
  assert.match(audit.body, /blocker-not-planned/);

  const before = github.calls.length;
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(github.calls.length, before);
});

test("reconciles close, reopen, duplicate, and state-reason changes", async () => {
  const issues = [
    issue(1, [2]),
    issue(2, [], { state: "closed", state_reason: "completed" }),
  ];
  const github = mockGitHub(issues);
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  const afterCompleted = github.calls.length;
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(github.calls.length, afterCompleted);

  issues[1].state = "open";
  issues[1].state_reason = null;
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  issues[1].state = "closed";
  issues[1].state_reason = "not_planned";
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  const stateAudits = github.comments
    .get(1)
    .filter((comment) => comment.body.includes("agent-infra-blocker-state"));
  assert.equal(stateAudits.length, 3);
  assert.match(stateAudits[0].body, /blockers-completed/);
  assert.match(stateAudits[1].body, /open-blockers/);
  assert.match(stateAudits[2].body, /blocker-not-planned/);
});

test("persists state intent before dispatch and retries only the failed dispatch", async () => {
  const issues = [issue(1, [2]), issue(2)];
  const github = mockGitHub(issues);
  let rejectDispatch = true;
  const request = async (apiPath, options) => {
    if (apiPath.endsWith("/dispatches") && rejectDispatch) {
      rejectDispatch = false;
      throw new Error("dispatch unavailable");
    }
    return github.request(apiPath, options);
  };
  await assert.rejects(
    reconcileRepository({
      repository: "example/agent-infra",
      token: "test-token",
      request,
      paginate: github.paginate,
    }),
    /dispatch unavailable/,
  );
  assert.equal(
    github.comments
      .get(1)
      .filter((comment) => comment.body.includes("agent-infra-blocker-state"))
      .length,
    1,
  );

  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request,
    paginate: github.paginate,
  });
  assert.equal(
    github.comments
      .get(1)
      .filter((comment) => comment.body.includes("agent-infra-blocker-state"))
      .length,
    1,
  );
  assert.equal(
    github.calls.filter((call) => call.apiPath.endsWith("/dispatches")).length,
    1,
  );
});

test("adds missing native dependencies and triages native-only edges", async () => {
  const issues = [issue(1, [2]), issue(2), issue(3)];
  const repair = mockGitHub(issues);
  repair.nativeDependencies.set(1, []);
  const first = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: repair.request,
    paginate: repair.paginate,
  });
  assert.equal(first.repairedNativeDependencies, 1);
  assert.deepEqual(
    repair.nativeDependencies.get(1).map((entry) => entry.number),
    [2],
  );

  const mismatchIssues = [issue(1, [2]), issue(2), issue(3)];
  const mismatch = mockGitHub(mismatchIssues);
  mismatch.nativeDependencies.set(1, [mismatchIssues[2]]);
  const outcome = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: mismatch.request,
    paginate: mismatch.paginate,
  });
  assert.deepEqual(outcome.nativeDependencyTriage, [1]);
  assert.equal(
    mismatchIssues[0].labels.some((label) => label.name === "needs-triage"),
    true,
  );
  assert.match(
    mismatch.comments
      .get(1)
      .find((comment) => comment.body.includes("agent-infra-blocker-state")).body,
    /native-dependency-mismatch/,
  );
  assert.equal(
    mismatch.calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("invalid graphs add one triage label and one stable audit", async () => {
  const issues = [issue(1, [99])];
  const github = mockGitHub(issues);
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(
    github.calls.filter((call) => call.apiPath.endsWith("/labels")).length,
    1,
  );
  assert.equal(
    github.calls.filter((call) => call.apiPath.endsWith("/comments")).length,
    1,
  );
  assert.match(github.comments.get(1)[0].body, /invalid-graph/);

  const before = github.calls.length;
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.deepEqual(github.calls.slice(before), []);
});

test("graph overflow fails closed by triaging affected open Issues", async () => {
  const issues = [issue(1, [2]), issue(2)];
  const github = mockGitHub(issues);
  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
    graphOptions: { maxIssues: 1 },
  });
  assert.equal(result.outcomes.length, 2);
  assert.equal(
    issues.every((entry) => entry.labels.some((label) => label.name === "needs-triage")),
    true,
  );
  assert.equal(
    github.calls.some((call) => call.apiPath.includes("/dependencies/blocked_by")),
    false,
  );
});

test("repairs a removed triage label without duplicating the state audit", () => {
  const graph = inspectBlockerGraph([
    issue(1, [2]),
    issue(2, [], { state: "closed", state_reason: "not_planned" }),
  ]);
  const state = classifyDependentBlockers(graph, 1);
  const prior = appComment(1, buildBlockerStateComment(state));
  assert.deepEqual(
    dependentReconciliationDecision({
      issue: graph.issuesByNumber.get(1),
      state,
      latestRecord: {
        ...state,
        commentId: prior.id,
      },
    }),
    {
      addTriage: true,
      comment: false,
      dispatch: { operation: "triage", reason: "blocker-not-planned" },
    },
  );
});

test("repairs one orphan trusted proposal edge and review marker idempotently", async () => {
  const source = issue(1);
  const contract = executionContent({ ...source, title: "Source Issue" });
  source.title = "Source Issue";
  const timelineEvent = {
    id: 101,
    event: "labeled",
    label: { name: "ready-for-agent" },
    actor: { login: "owner", type: "User" },
    created_at: "2026-08-06T00:00:00Z",
    url: "https://api.github.test/issues/events/101",
    authorizationCycle: 1,
  };
  const authorization = authorizeCycle({
    issueNumber: 1,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    timelineEvent,
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-06T00:00:01Z",
  });
  const rendered = buildBlockerIssue({
    sourceIssue: 1,
    sourceCycle: 1,
    executionContentHash: contract.hash,
    proposal: {
      proposal_id: "missing-migration",
      title: "add the missing migration",
      problem: "The table is missing.",
      scope: ["Add the migration."],
      acceptance_criteria: [{ id: "AC-1", text: "Migration applies." }],
      validation: ["Run migration tests."],
    },
  });
  const blocker = {
    ...issue(2, [], { labels: [] }),
    title: rendered.title,
    body: rendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const github = mockGitHub([source, blocker]);
  github.comments.set(2, [appComment(39, rendered.identityComment)]);
  github.comments.set(1, [
    {
      ...appComment(40, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/40",
    },
  ]);
  github.events.set(1, [timelineEvent]);

  const first = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(first.repairedEdges, true);
  assert.equal(first.repairedAuthorizations, 1);
  assert.match(source.body, /## Blocked by\n\n- #2/);
  assert.equal(github.comments.get(2).length, 3);
  assert.match(github.comments.get(2)[1].body, /agent-infra-blocker-review/);

  const before = github.calls.length;
  const second = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(second.repairedEdges, false);
  assert.deepEqual(github.calls.slice(before), []);
});
