import assert from "node:assert/strict";
import test from "node:test";

import {
  dependentReconciliationDecision,
  hasSystemTriageEvidence,
  isUneditedActionsBlockerSnapshot,
  isRetiredBlockerProposal,
  matchesRecoveryAuthorization,
  reconcileRepository,
} from "./blocker-reconciler.mjs";
import {
  BLOCKER_PUBLISH_TRIAGE_COMMENT,
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
    native_blockers: blockers,
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

function actionsLabelEvent(id, createdAt) {
  return {
    id,
    event: "labeled",
    label: { name: "needs-triage" },
    actor: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    created_at: createdAt,
  };
}

test("rejects edited blocker snapshots and stale recovery authorization", () => {
  const issueSnapshot = {
    node_id: "I_blocker_2",
    number: 2,
    title: "blocker: bounded change",
    body: "proposal body",
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: null,
  };
  const liveSnapshot = {
    id: issueSnapshot.node_id,
    title: issueSnapshot.title,
    body: issueSnapshot.body,
    lastEditedAt: null,
    author: { login: "github-actions" },
  };
  assert.equal(isUneditedActionsBlockerSnapshot(issueSnapshot, liveSnapshot), true);
  assert.equal(
    isUneditedActionsBlockerSnapshot(issueSnapshot, {
      ...liveSnapshot,
      lastEditedAt: "2026-08-07T00:02:00Z",
    }),
    false,
  );

  const record = { sourceCycle: 1, executionContentHash: "a".repeat(64) };
  const authorization = {
    current: {
      state: "active",
      cycle: 1,
      executionContentHash: record.executionContentHash,
      blockedByHash: "b".repeat(64),
    },
    contract: {
      hash: record.executionContentHash,
      blockedByHash: "b".repeat(64),
    },
  };
  assert.equal(matchesRecoveryAuthorization(record, authorization), true);
  assert.equal(
    matchesRecoveryAuthorization(
      { ...record, sourceCycle: 2 },
      authorization,
    ),
    false,
  );
  assert.equal(
    matchesRecoveryAuthorization(
      { ...record, executionContentHash: "c".repeat(64) },
      authorization,
    ),
    false,
  );
});

test("retires only closed older-cycle proposals authorized absent", () => {
  const record = { sourceCycle: 1 };
  const blocker = {
    number: 2,
    state: "closed",
    state_reason: "not_planned",
    labels: [],
  };
  const authorization = {
    current: {
      state: "active",
      cycle: 2,
      executionContentHash: "a".repeat(64),
      blockedByHash: "b".repeat(64),
    },
    contract: {
      hash: "a".repeat(64),
      blockedByHash: "b".repeat(64),
      blockerNumbers: [],
    },
  };

  assert.equal(isRetiredBlockerProposal(record, blocker, authorization), true);
  assert.equal(
    isRetiredBlockerProposal(record, { ...blocker, state: "open" }, authorization),
    false,
  );
  assert.equal(
    isRetiredBlockerProposal(
      record,
      { ...blocker, state_reason: "completed" },
      authorization,
    ),
    false,
  );
  assert.equal(
    isRetiredBlockerProposal(record, blocker, {
      ...authorization,
      current: { ...authorization.current, cycle: 1 },
    }),
    false,
  );
  assert.equal(
    isRetiredBlockerProposal(record, blocker, {
      ...authorization,
      current: { ...authorization.current, state: "consumed" },
    }),
    false,
  );
  assert.equal(
    isRetiredBlockerProposal(record, blocker, {
      ...authorization,
      current: { ...authorization.current, blockedByHash: "c".repeat(64) },
    }),
    false,
  );
  assert.equal(
    isRetiredBlockerProposal(record, blocker, {
      ...authorization,
      contract: { ...authorization.contract, blockerNumbers: [2] },
    }),
    false,
  );
});

test("clears only triage state derived from the matching Publisher failure", () => {
  const labeledAt = "2026-08-07T00:01:00Z";
  const failure = {
    ...appComment(10, BLOCKER_PUBLISH_TRIAGE_COMMENT),
    created_at: "2026-08-07T00:01:01Z",
    updated_at: "2026-08-07T00:01:01Z",
  };
  const actionsEvent = actionsLabelEvent(11, labeledAt);

  assert.equal(
    hasSystemTriageEvidence({
      comments: [failure],
      events: [actionsEvent],
      requirePublisherFailure: true,
    }),
    true,
  );
  assert.equal(
    hasSystemTriageEvidence({
      comments: [{ ...failure, body: "Another failure" }],
      events: [actionsEvent],
      requirePublisherFailure: true,
    }),
    false,
  );
  assert.equal(
    hasSystemTriageEvidence({
      comments: [failure],
      events: [
        {
          ...actionsEvent,
          actor: { id: 1, login: "maintainer", type: "User" },
        },
      ],
      requirePublisherFailure: true,
    }),
    false,
  );
  assert.equal(
    hasSystemTriageEvidence({
      comments: [
        {
          ...failure,
          created_at: "2026-08-07T00:00:59Z",
          updated_at: "2026-08-07T00:00:59Z",
        },
      ],
      events: [actionsEvent],
      requirePublisherFailure: true,
    }),
    false,
  );
});

function mockGitHub(
  issues,
  {
    pullRequests = [],
    branchRefs = new Map(),
    lastEditedAt = new Map(),
  } = {},
) {
  const comments = new Map();
  const events = new Map();
  const nativeDependencies = new Map();
  for (const source of issues) {
    const blockerNumbers = source.native_blockers ?? [];
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
    if (apiPath.includes("/pulls?state=all")) return pullRequests;
    const branchMatch = /\/git\/matching-refs\/heads\/codex\/issue-(\d+)-cycle-/.exec(
      apiPath,
    );
    if (branchMatch) return branchRefs.get(Number(branchMatch[1])) ?? [];
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
    if (apiPath === "/graphql" && options.method === "POST") {
      const target = issues.find(
        (entry) => entry.number === body.variables.number,
      );
      return {
        data: {
          repository: {
            issue: target
              ? {
                  id: target.node_id,
                  title: target.title,
                  body: target.body,
                  lastEditedAt: lastEditedAt.get(target.number) ?? null,
                  author: { login: "github-actions" },
                }
              : null,
          },
        },
      };
    }
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
    const removeLabelMatch =
      /\/issues\/(\d+)\/labels\/needs-triage$/.exec(apiPath);
    if (removeLabelMatch && options.method === "DELETE") {
      const target = issues.find(
        (entry) => entry.number === Number(removeLabelMatch[1]),
      );
      target.labels = target.labels.filter(
        (label) => label.name !== "needs-triage",
      );
      return null;
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
  return {
    branchRefs,
    calls,
    comments,
    events,
    nativeDependencies,
    paginate,
    pullRequests,
    request,
  };
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

test("rechecks Worker topology once when a Draft PR becomes ready", async () => {
  const issues = [
    issue(1, [2]),
    issue(2, [], { state: "closed", state_reason: "completed" }),
  ];
  const pullRequest = {
    number: 10,
    state: "open",
    draft: true,
    merged_at: null,
    head: {
      ref: "codex/issue-1-cycle-1",
      sha: "a".repeat(40),
      repo: { full_name: "example/agent-infra" },
    },
    base: { ref: "main" },
  };
  const github = mockGitHub(issues, {
    pullRequests: [pullRequest],
    branchRefs: new Map([
      [
        1,
        [
          {
            ref: "refs/heads/codex/issue-1-cycle-1",
            object: { sha: "a".repeat(40) },
          },
        ],
      ],
    ]),
  });

  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  const firstDispatches = github.calls.filter((call) =>
    call.apiPath.endsWith("/dispatches"),
  ).length;
  const firstState = github.comments
    .get(1)
    .find((comment) => comment.body.includes("agent-infra-blocker-state"));
  assert.doesNotMatch(firstState.body, /codex\/issue-1-cycle-1/);
  assert.doesNotMatch(firstState.body, new RegExp("a{40}"));
  const firstDispatch = github.calls.find((call) =>
    call.apiPath.endsWith("/dispatches"),
  );
  assert.doesNotMatch(JSON.stringify(firstDispatch.body), /codex\/issue-1-cycle-1/);
  assert.doesNotMatch(JSON.stringify(firstDispatch.body), new RegExp("a{40}"));

  pullRequest.draft = false;
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  const stateAudits = github.comments
    .get(1)
    .filter((comment) => comment.body.includes("agent-infra-blocker-state"));
  assert.equal(stateAudits.length, 2);
  assert.notEqual(stateAudits[1].body, firstState.body);
  assert.equal(
    github.calls.filter((call) => call.apiPath.endsWith("/dispatches")).length,
    firstDispatches + 1,
  );

  const beforeStableReplay = github.calls.length;
  await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(github.calls.length, beforeStableReplay);
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
  const issues = [issue(1, [2]), issue(2, [], { labels: [] })];
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

test("projects native dependencies to the compatibility body section", async () => {
  const issues = [issue(1, [2]), issue(2), issue(3)];
  const github = mockGitHub(issues);
  github.nativeDependencies.set(1, [issues[2]]);
  const outcome = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(outcome.repairedBodyProjections, 1);
  assert.match(issues[0].body, /## Blocked by\n\n- #3/);
  assert.doesNotMatch(issues[0].body, /- #2/);
  assert.equal(
    github.calls.some(
      (call) =>
        call.apiPath.includes("/dependencies/blocked_by") &&
        ["POST", "DELETE"].includes(call.method),
    ),
    false,
  );
});

test("triages projection write failures idempotently", async () => {
  const issues = [issue(1, [2]), issue(2), issue(3)];
  const github = mockGitHub(issues);
  github.nativeDependencies.set(1, [issues[2]]);
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/1") && options.method === "PATCH") {
      throw new Error("projection unavailable");
    }
    return github.request(apiPath, options);
  };

  const first = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request,
    paginate: github.paginate,
  });
  assert.equal(first.outcomes[0].state.reason, "body-projection-update-failed");
  assert.equal(issues[0].labels.some((label) => label.name === "needs-triage"), true);

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
});

test("reconciles a dependent when its final native blocker is removed", async () => {
  const issues = [issue(1), issue(2)];
  const github = mockGitHub(issues);
  github.nativeDependencies.set(1, []);

  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.equal(result.repairedBodyProjections, 0);
  assert.match(issues[0].body, /## Blocked by\n\nNone/);
  assert.equal(result.outcomes[0].issueNumber, 1);
  assert.equal(result.outcomes[0].state.state, "frontier");
});

test("invalid graphs add one triage label and one stable audit", async () => {
  const issues = [issue(1, [99])];
  const github = mockGitHub(issues);
  github.nativeDependencies.set(1, [{ number: 99 }]);
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

test("ignores Wayfinder planning objects during execution reconciliation", async () => {
  const question = issue(199, [], {
    labels: [{ name: "wayfinder:grilling" }],
    body: "## Question\n\nShould the parser require `## Blocked by`?",
  });
  const map = issue(195, [], {
    labels: [{ name: "wayfinder:map" }],
    body: "## Notes\n\nDecision map.",
  });
  const github = mockGitHub([question, map]);
  github.nativeDependencies.set(199, [map]);

  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.deepEqual(result.outcomes, []);
  assert.deepEqual(result.triage, []);
  assert.deepEqual(question.labels, [{ name: "wayfinder:grilling" }]);
  assert.deepEqual(github.comments.get(199) ?? [], []);
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
      deliverable: "A versioned migration that creates the missing table.",
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

test("recovers the trusted prefix after partial multi-edge publication", async () => {
  const source = issue(1, [], { title: "Source Issue" });
  const contract = executionContent(source);
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
  const rendered = ["schema", "index"].map((name) =>
    buildBlockerIssue({
      sourceIssue: 1,
      sourceCycle: 1,
      executionContentHash: contract.hash,
      proposal: {
        proposal_id: `database-${name}`,
        title: `add the database ${name}`,
        problem: `The database ${name} is missing.`,
        deliverable: `A versioned database ${name}.`,
        scope: [`Add only the ${name}.`],
        acceptance_criteria: [{ id: "AC-1", text: `${name} is present.` }],
        validation: ["Run migration tests."],
      },
    }),
  );
  const blockers = rendered.map((entry, index) => ({
    ...issue(index + 2, [], { labels: [] }),
    title: entry.title,
    body: entry.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  }));
  const github = mockGitHub([source, ...blockers]);
  github.nativeDependencies.set(1, [blockers[0]]);
  github.comments.set(1, [
    {
      ...appComment(40, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/40",
    },
  ]);
  for (const [index, blocker] of blockers.entries()) {
    const record = parseBlockerProposalRecord(blocker, { trusted: false });
    github.comments.set(blocker.number, [
      appComment(41 + index * 2, rendered[index].identityComment),
      appComment(42 + index * 2, buildBlockerReviewAck(blocker.number, record)),
    ]);
  }
  github.events.set(1, [timelineEvent]);

  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.equal(result.repairedAuthorizations, 2);
  assert.deepEqual(
    github.nativeDependencies.get(1).map(({ number }) => number),
    [2, 3],
  );
  assert.deepEqual(parseBlockedBy(source.body, { issueNumber: 1 }), [2, 3]);
  assert.equal(source.labels.some((label) => label.name === "needs-triage"), false);
});

test("retires a not-planned older-cycle proposal after new authorization", async () => {
  const source = issue(1, [], { title: "Source Issue" });
  const contract = executionContent(source);
  const timelineEvent = {
    id: 201,
    event: "labeled",
    label: { name: "ready-for-agent" },
    actor: { login: "owner", type: "User" },
    created_at: "2026-08-09T00:00:00Z",
    url: "https://api.github.test/issues/events/201",
    authorizationCycle: 2,
  };
  const priorTimelineEvent = {
    ...timelineEvent,
    id: 101,
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
    recordedAt: "2026-08-09T00:00:01Z",
  });
  const rendered = buildBlockerIssue({
    sourceIssue: 1,
    sourceCycle: 1,
    executionContentHash: contract.hash,
    proposal: {
      proposal_id: "retired-workflow-change",
      title: "authorize the retired workflow change",
      problem: "The old cycle proposed a protected workflow change.",
      deliverable: "A bounded workflow authorization record.",
      scope: ["Authorize only the old workflow change."],
      acceptance_criteria: [
        { id: "AC-1", text: "The authorization is bounded." },
      ],
      validation: ["Run workflow policy tests."],
    },
  });
  const blocker = {
    ...issue(2, [], {
      labels: [],
      state: "closed",
      state_reason: "not_planned",
    }),
    title: rendered.title,
    body: rendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const github = mockGitHub([source, blocker]);
  const proposalRecord = parseBlockerProposalRecord(blocker, { trusted: false });
  github.comments.set(1, [
    {
      ...appComment(40, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/40",
    },
  ]);
  github.comments.set(2, [
    appComment(41, rendered.identityComment),
    appComment(42, buildBlockerReviewAck(2, proposalRecord)),
  ]);
  assert.ok(
    parseBlockerProposalRecord(blocker, { comments: github.comments.get(2) }),
  );
  github.events.set(1, [priorTimelineEvent, timelineEvent]);

  const first = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.deepEqual(first.triage, []);
  assert.equal(
    source.labels.some((label) => label.name === "needs-triage"),
    false,
  );
  assert.deepEqual(parseBlockedBy(source.body, { issueNumber: 1 }), []);
  assert.deepEqual(github.nativeDependencies.get(1), []);

  const beforeReplay = github.calls.length;
  const second = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.deepEqual(second.triage, []);
  assert.deepEqual(github.calls.slice(beforeReplay), []);
});

test("keeps same-cycle not-planned orphan recovery fail closed", async () => {
  const source = issue(1, [], { title: "Source Issue" });
  const contract = executionContent(source);
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
      proposal_id: "same-cycle-workflow-change",
      title: "authorize the same-cycle workflow change",
      problem: "The current cycle proposed a protected workflow change.",
      deliverable: "A bounded workflow authorization record.",
      scope: ["Authorize only the current workflow change."],
      acceptance_criteria: [
        { id: "AC-1", text: "The authorization is bounded." },
      ],
      validation: ["Run workflow policy tests."],
    },
  });
  const blocker = {
    ...issue(2, [], {
      labels: [],
      state: "closed",
      state_reason: "not_planned",
    }),
    title: rendered.title,
    body: rendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const github = mockGitHub([source, blocker]);
  const proposalRecord = parseBlockerProposalRecord(blocker, { trusted: false });
  github.comments.set(1, [
    {
      ...appComment(40, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/40",
    },
  ]);
  github.comments.set(2, [
    appComment(41, rendered.identityComment),
    appComment(42, buildBlockerReviewAck(2, proposalRecord)),
  ]);
  github.events.set(1, [timelineEvent]);

  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.equal(result.repairedEdges, true);
  assert.deepEqual(parseBlockedBy(source.body, { issueNumber: 1 }), [2]);
  assert.deepEqual(
    github.nativeDependencies.get(1).map(({ number }) => number),
    [2],
  );
  assert.equal(
    source.labels.some((label) => label.name === "needs-triage"),
    true,
  );
});

test("restores only current-cycle proposals from a mixed missing set", async () => {
  const source = issue(1, [], { title: "Source Issue" });
  const contract = executionContent(source);
  const timelineEvent = {
    id: 201,
    event: "labeled",
    label: { name: "ready-for-agent" },
    actor: { login: "owner", type: "User" },
    created_at: "2026-08-09T00:00:00Z",
    url: "https://api.github.test/issues/events/201",
    authorizationCycle: 2,
  };
  const priorTimelineEvent = {
    ...timelineEvent,
    id: 101,
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
    recordedAt: "2026-08-09T00:00:01Z",
  });
  const retiredRendered = buildBlockerIssue({
    sourceIssue: 1,
    sourceCycle: 1,
    executionContentHash: contract.hash,
    proposal: {
      proposal_id: "retired-workflow-change",
      title: "authorize the retired workflow change",
      problem: "The old cycle proposed a protected workflow change.",
      deliverable: "A bounded retired workflow authorization record.",
      scope: ["Authorize only the retired workflow change."],
      acceptance_criteria: [
        { id: "AC-1", text: "The retired authorization is bounded." },
      ],
      validation: ["Run workflow policy tests."],
    },
  });
  const currentRendered = buildBlockerIssue({
    sourceIssue: 1,
    sourceCycle: 2,
    executionContentHash: contract.hash,
    proposal: {
      proposal_id: "current-database-change",
      title: "deliver the current database change",
      problem: "The current cycle requires a database change.",
      deliverable: "A versioned database migration.",
      scope: ["Add only the current migration."],
      acceptance_criteria: [
        { id: "AC-1", text: "The current migration applies cleanly." },
      ],
      validation: ["Run migration tests."],
    },
  });
  const retired = {
    ...issue(2, [], {
      labels: [],
      state: "closed",
      state_reason: "not_planned",
    }),
    title: retiredRendered.title,
    body: retiredRendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const current = {
    ...issue(3, [], { labels: [] }),
    title: currentRendered.title,
    body: currentRendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const github = mockGitHub([source, retired, current]);
  const currentRecord = parseBlockerProposalRecord(current, { trusted: false });
  github.comments.set(1, [
    {
      ...appComment(40, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/40",
    },
  ]);
  github.comments.set(2, [appComment(41, retiredRendered.identityComment)]);
  github.comments.set(3, [
    appComment(42, currentRendered.identityComment),
    appComment(43, buildBlockerReviewAck(3, currentRecord)),
  ]);
  github.events.set(1, [priorTimelineEvent, timelineEvent]);

  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.equal(result.repairedEdges, true);
  assert.deepEqual(parseBlockedBy(source.body, { issueNumber: 1 }), [3]);
  assert.deepEqual(
    github.nativeDependencies.get(1).map(({ number }) => number),
    [3],
  );
  assert.equal(github.comments.get(2).length, 1);
  assert.equal(
    source.labels.some((label) => label.name === "needs-triage"),
    false,
  );
});

test("recovers one Actions-created blocker missing its identity audit", async () => {
  const source = issue(1, [], { labels: [
    { name: "ready-for-agent" },
    { name: "needs-triage" },
  ] });
  const contract = executionContent({ ...source, title: "Source Issue" });
  source.title = "Source Issue";
  const timelineEvent = {
    id: 201,
    event: "labeled",
    label: { name: "ready-for-agent" },
    actor: { login: "owner", type: "User" },
    created_at: "2026-08-07T00:00:00Z",
    url: "https://api.github.test/issues/events/201",
    authorizationCycle: 1,
  };
  const authorization = authorizeCycle({
    issueNumber: 1,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    timelineEvent,
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-07T00:00:01Z",
  });
  const rendered = buildBlockerIssue({
    sourceIssue: 1,
    sourceCycle: 1,
    executionContentHash: contract.hash,
    proposal: {
      proposal_id: "workflow-authorization",
      title: "authorize the workflow change",
      problem: "The protected workflow is outside the Worker write boundary.",
      deliverable: "A bounded workflow authorization record.",
      scope: ["Authorize only the required workflow files."],
      acceptance_criteria: [{ id: "AC-1", text: "The authorization is bounded." }],
      validation: ["Run workflow policy tests."],
    },
  });
  const blocker = {
    ...issue(2, [], { labels: [{ name: "needs-triage" }] }),
    node_id: "I_blocker_2",
    title: rendered.title,
    body: rendered.body,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: null,
  };
  const github = mockGitHub([source, blocker]);
  github.comments.set(1, [
    {
      ...appComment(50, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/50",
    },
    {
      ...appComment(51, BLOCKER_PUBLISH_TRIAGE_COMMENT),
      created_at: "2026-08-07T00:01:01Z",
      updated_at: "2026-08-07T00:01:01Z",
    },
  ]);
  github.events.set(1, [
    timelineEvent,
    actionsLabelEvent(202, "2026-08-07T00:01:00Z"),
  ]);
  github.events.set(2, [
    actionsLabelEvent(203, "2026-08-07T00:01:01Z"),
  ]);

  const first = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.equal(first.repairedIdentities, 1);
  assert.equal(first.repairedEdges, true);
  assert.equal(first.clearedTriage, 2);
  assert.match(github.comments.get(2)[0].body, /agent-infra-blocker-identity/);
  assert.match(source.body, /## Blocked by\n\n- #2/);
  assert.equal(
    source.labels.some((label) => label.name === "needs-triage"),
    false,
  );
  assert.equal(
    blocker.labels.some((label) => label.name === "needs-triage"),
    false,
  );
  assert.deepEqual(
    github.nativeDependencies.get(1).map(({ number }) => number),
    [2],
  );

  const beforeReplay = github.calls.length;
  const second = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });
  assert.equal(second.repairedIdentities, 0);
  assert.equal(second.repairedEdges, false);
  assert.equal(
    github.calls.slice(beforeReplay).every((call) =>
      call.apiPath === "/graphql" && call.method === "POST"
    ),
    true,
  );
});

test("fails closed when concurrent replay leaves duplicate orphan blockers", async () => {
  const source = issue(1, [], {
    title: "Source Issue",
    labels: [{ name: "ready-for-agent" }, { name: "needs-triage" }],
  });
  const contract = executionContent(source);
  const timelineEvent = {
    id: 301,
    event: "labeled",
    label: { name: "ready-for-agent" },
    actor: { login: "owner", type: "User" },
    created_at: "2026-08-07T00:00:00Z",
    url: "https://api.github.test/issues/events/301",
    authorizationCycle: 1,
  };
  const authorization = authorizeCycle({
    issueNumber: 1,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    timelineEvent,
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-07T00:00:01Z",
  });
  const rendered = buildBlockerIssue({
    sourceIssue: 1,
    sourceCycle: 1,
    executionContentHash: contract.hash,
    proposal: {
      proposal_id: "workflow-authorization",
      title: "authorize the workflow change",
      problem: "The protected workflow is outside the Worker write boundary.",
      deliverable: "A bounded workflow authorization record.",
      scope: ["Authorize only the required workflow files."],
      acceptance_criteria: [{ id: "AC-1", text: "The authorization is bounded." }],
      validation: ["Run workflow policy tests."],
    },
  });
  const orphan = (number) => ({
    ...issue(number, [], { labels: [{ name: "needs-triage" }] }),
    node_id: "I_blocker_" + number,
    title: rendered.title,
    body: rendered.body,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: null,
  });
  const firstOrphan = orphan(2);
  const secondOrphan = orphan(3);
  const github = mockGitHub([source, firstOrphan, secondOrphan]);
  github.comments.set(1, [
    {
      ...appComment(60, buildAuthorizationRecordComment(authorization)),
      html_url: "https://github.test/comments/60",
    },
  ]);
  github.events.set(1, [timelineEvent]);

  const result = await reconcileRepository({
    repository: "example/agent-infra",
    token: "test-token",
    request: github.request,
    paginate: github.paginate,
  });

  assert.equal(result.repairedIdentities, 0);
  assert.deepEqual(result.triage, [1, 2, 3]);
  assert.equal(github.comments.get(2)?.length ?? 0, 0);
  assert.equal(github.comments.get(3)?.length ?? 0, 0);
  assert.deepEqual(parseBlockedBy(source.body, { issueNumber: 1 }), []);
  assert.deepEqual(github.nativeDependencies.get(1), []);
});
