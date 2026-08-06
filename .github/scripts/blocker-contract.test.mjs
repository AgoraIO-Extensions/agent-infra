import assert from "node:assert/strict";
import test from "node:test";

import {
  affectedDependents,
  assertCanAddBlockers,
  BLOCKER_REVIEW_COMMENT,
  buildBlockerIssue,
  buildBlockerStateComment,
  buildWorkerDispatchAck,
  classifyDependentBlockers,
  hasTrustedWorkerDispatchAck,
  inspectBlockerGraph,
  isTrustedBlockerReviewComment,
  latestBlockerStateRecord,
  nativeDependencyDecision,
  parseBlockerProposalRecord,
  reconciliationIssueNumbers,
  replaceBlockedBy,
  validateBlockerProposals,
} from "./blocker-contract.mjs";

const proposal = {
  proposal_id: "database-migration",
  title: "prepare the database migration",
  problem: "The required table does not exist.",
  scope: ["Add the missing migration."],
  acceptance_criteria: [{ id: "AC-1", text: "The migration applies cleanly." }],
  validation: ["Run the migration test."],
};

function issue(number, blockers = [], overrides = {}) {
  return {
    number,
    state: "open",
    state_reason: null,
    labels: [],
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

test("validates bounded blocker proposals and rejects extra GitHub controls", () => {
  assert.deepEqual(validateBlockerProposals([proposal]), [proposal]);
  assert.throws(
    () => validateBlockerProposals([{ ...proposal, labels: ["ready-for-agent"] }]),
    /unexpected fields/,
  );
  assert.throws(
    () => validateBlockerProposals([{ ...proposal, repository: "other/repo" }]),
    /unexpected fields/,
  );
  assert.throws(
    () =>
      validateBlockerProposals([
        {
          ...proposal,
          acceptance_criteria: [{ id: "AC-2", text: "Skipped ID" }],
        },
      ]),
    /contiguous/,
  );
  assert.throws(
    () => validateBlockerProposals([proposal, proposal]),
    /IDs must be unique/,
  );
});

test("renders a complete sanitized Implementation Issue with a trusted identity marker", () => {
  const rendered = buildBlockerIssue({
    sourceIssue: 42,
    sourceCycle: 3,
    executionContentHash: "a".repeat(64),
    proposal: {
      ...proposal,
      problem: "@owner asked to close #9 <!-- hidden -->",
    },
  });
  assert.match(rendered.body, /^<!-- agent-infra-blocker-proposal:/);
  for (const heading of [
    "## Problem",
    "## Scope",
    "## Acceptance criteria",
    "## Validation",
    "## Blocked by",
  ]) {
    assert.match(rendered.body, new RegExp(heading));
  }
  assert.doesNotMatch(rendered.body, /@owner|close #9|<!-- hidden -->/);
  assert.equal(BLOCKER_REVIEW_COMMENT.includes("@claude"), true);
  assert.equal(
    isTrustedBlockerReviewComment({
      body: BLOCKER_REVIEW_COMMENT,
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
      created_at: "2026-08-06T00:00:00Z",
      updated_at: "2026-08-06T00:00:00Z",
    }),
    true,
  );
  const parsed = parseBlockerProposalRecord(
    {
      title: rendered.title,
      body: rendered.body,
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
    },
    {
      comments: [
        {
          body: rendered.identityComment,
          user: { login: "github-actions[bot]", type: "Bot" },
          performed_via_github_app: { id: 15368 },
          created_at: "2026-08-06T00:00:00Z",
          updated_at: "2026-08-06T00:00:00Z",
        },
      ],
    },
  );
  assert.equal(parsed.sourceIssue, 42);
  assert.equal(parsed.sourceCycle, 3);
  assert.equal(
    parseBlockerProposalRecord(
      {
        title: rendered.title,
        body: rendered.body.replace("asked to", "told us to"),
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
      },
      {
        comments: [
          {
            body: rendered.identityComment,
            user: { login: "github-actions[bot]", type: "Bot" },
            performed_via_github_app: { id: 15368 },
            created_at: "2026-08-06T00:00:00Z",
            updated_at: "2026-08-06T00:00:00Z",
          },
        ],
      },
    )?.sourceIssue,
    42,
  );
  assert.equal(
    parseBlockerProposalRecord({
      title: rendered.title,
      body: rendered.body,
      user: { login: "forger", type: "User" },
    }),
    null,
  );
});

test("replaces only the deterministic Blocked by section", () => {
  const original = issue(42).body;
  const replaced = replaceBlockedBy(original, [7, 9], { issueNumber: 42 });
  assert.match(replaced, /## Blocked by\n\n- #7\n- #9/);
  assert.equal(replaced.split("## Problem")[1], original.split("## Problem")[1].replace("## Blocked by\n\nNone\n", "## Blocked by\n\n- #7\n- #9\n"));
  assert.throws(() => replaceBlockedBy(original, [42], { issueNumber: 42 }));
});

test("builds a bounded DAG and rejects missing targets, duplicate edges, and cycles", () => {
  const graph = inspectBlockerGraph([
    issue(1, [2]),
    issue(2, [3]),
    issue(3),
    issue(4),
  ]);
  assert.equal(graph.errors.size, 0);
  assert.deepEqual(affectedDependents(graph, 3), [1, 2]);
  assert.deepEqual(reconciliationIssueNumbers(graph, 3), [1, 2]);
  assert.deepEqual(assertCanAddBlockers(graph, 3, [4]), [4]);

  const missing = inspectBlockerGraph([issue(1, [99])]);
  assert.match(missing.errors.get(1), /missing or is a PR/);
  const cyclic = inspectBlockerGraph([issue(1, [2]), issue(2, [1])]);
  assert.match(cyclic.errors.get(1), /cycle/);
  assert.match(cyclic.errors.get(2), /cycle/);
  assert.throws(() => assertCanAddBlockers(graph, 1, [2]), /duplicate edge/);
  assert.throws(
    () =>
      assertCanAddBlockers(
        inspectBlockerGraph([issue(1), issue(2, [1])]),
        1,
        [2],
      ),
    /cycle/,
  );
});

test("limits participating DAG nodes instead of unrelated historical Issues", () => {
  const unrelated = Array.from({ length: 1_100 }, (_, index) =>
    issue(index + 10, [], { body: "Historical Issue without the dependency section." }),
  );
  const graph = inspectBlockerGraph([
    ...unrelated,
    issue(1, [2]),
    issue(2),
  ]);
  assert.equal(graph.errors.size, 0);
  assert.equal(graph.participantCount, 2);

  const overflow = inspectBlockerGraph(
    [issue(1, [2]), issue(2)],
    { maxIssues: 1 },
  );
  assert.equal(overflow.overflow, "Blocker graph exceeds the participating Issue limit");
  assert.match(overflow.errors.get(1), /participating Issue limit/);
  assert.match(overflow.errors.get(2), /participating Issue limit/);
});

test("mirrors missing native dependencies and triages native-only edges", () => {
  const issuesByNumber = new Map([
    [2, { number: 2, id: 2002 }],
    [3, { number: 3, id: 2003 }],
  ]);
  assert.deepEqual(
    nativeDependencyDecision([2, 3], [{ number: 2, id: 2002 }], issuesByNumber),
    { status: "sync", add: [{ number: 3, issueId: 2003 }] },
  );
  assert.deepEqual(
    nativeDependencyDecision([2], [{ number: 3, id: 2003 }], issuesByNumber),
    {
      status: "triage",
      reason: "native-dependency-mismatch",
      extraNumbers: [3],
    },
  );
});

test("classifies open, completed, and not-planned blocker frontiers", () => {
  assert.equal(
    classifyDependentBlockers(
      inspectBlockerGraph([issue(1, [2]), issue(2)]),
      1,
    ).state,
    "blocked",
  );
  assert.equal(
    classifyDependentBlockers(
      inspectBlockerGraph([
        issue(1, [2]),
        issue(2, [], { state: "closed", state_reason: "completed" }),
      ]),
      1,
    ).state,
    "frontier",
  );
  assert.deepEqual(
    classifyDependentBlockers(
      inspectBlockerGraph([
        issue(1, [2]),
        issue(2, [], { state: "closed", state_reason: "not_planned" }),
      ]),
      1,
    ).state,
    "triage",
  );
});

test("accepts only append-only App blocker-state audit comments", () => {
  const state = classifyDependentBlockers(
    inspectBlockerGraph([issue(1, [2]), issue(2)]),
    1,
  );
  const body = buildBlockerStateComment(state);
  const comment = {
    id: 7,
    body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: "2026-08-06T00:00:00Z",
    updated_at: "2026-08-06T00:00:00Z",
  };
  assert.equal(latestBlockerStateRecord([comment], 1).signature, state.signature);
  assert.equal(
    latestBlockerStateRecord([{ ...comment, updated_at: "2026-08-06T00:01:00Z" }], 1),
    null,
  );
  assert.equal(
    latestBlockerStateRecord([
      { ...comment, user: { login: "forger", type: "User" } },
    ], 1),
    null,
  );
});

test("accepts only the matching append-only Worker dispatch acknowledgement", () => {
  const signature = "a".repeat(64);
  const body = buildWorkerDispatchAck(42, signature, "evaluate");
  const comment = {
    body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: "2026-08-06T00:00:00Z",
    updated_at: "2026-08-06T00:00:00Z",
  };
  assert.equal(
    hasTrustedWorkerDispatchAck([comment], 42, signature, "evaluate"),
    true,
  );
  assert.equal(
    hasTrustedWorkerDispatchAck([comment], 42, signature, "pause"),
    false,
  );
  assert.equal(
    hasTrustedWorkerDispatchAck(
      [{ ...comment, updated_at: "2026-08-06T00:01:00Z" }],
      42,
      signature,
      "evaluate",
    ),
    false,
  );
});
