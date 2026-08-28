import assert from "node:assert/strict";
import test from "node:test";

import {
  affectedDependents,
  assertCanAddBlockers,
  BLOCKER_REVIEW_COMMENT,
  buildBlockerIssue,
  buildBlockerStateComment,
  buildWorkerDispatchAck,
  canRegisterBlockerIdentity,
  classifyDependentBlockers,
  hasTrustedWorkerDispatchAck,
  hydrateNativeDependencies,
  inspectBlockerGraph,
  isTrustedBlockerReviewComment,
  latestBlockerStateRecord,
  parseBlockerProposalRecord,
  reconciliationIssueNumbers,
  replaceBlockedBy,
  validatedExecutionIssue,
  validateBlockerProposals,
  validateHumanHandoffs,
} from "./blocker-contract.mjs";

const proposal = {
  proposal_id: "database-migration",
  title: "prepare the database migration",
  problem: "The required table does not exist.",
  deliverable: "A versioned migration that creates the required table.",
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

test("validates explicit human handoffs without GitHub controls", () => {
  const handoff = {
    handoff_id: "protected-workflow-change",
    reason: "protected_path_change",
    required_action: "A maintainer must review the protected change.",
  };
  assert.deepEqual(validateHumanHandoffs([handoff]), [handoff]);
  assert.throws(
    () => validateHumanHandoffs([{ ...handoff, reason: "other" }]),
    /reason is invalid/,
  );
  assert.throws(
    () => validateHumanHandoffs([{ ...handoff, labels: ["ready-for-human"] }]),
    /unexpected fields/,
  );
  assert.throws(
    () => validateHumanHandoffs([handoff, handoff]),
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
    "## Deliverable",
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
  const identityComments = [
    {
      body: rendered.identityComment,
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
      created_at: "2026-08-06T00:00:00Z",
      updated_at: "2026-08-06T00:00:00Z",
    },
  ];
  for (const edited of [
    { ...rendered, title: `${rendered.title} edited` },
    { ...rendered, body: rendered.body.replace("asked to", "told us to") },
  ]) {
    assert.equal(
      parseBlockerProposalRecord(
        {
          title: edited.title,
          body: edited.body,
          user: { login: "github-actions[bot]", type: "Bot" },
          performed_via_github_app: { id: 15368 },
        },
        { comments: identityComments },
      ),
      null,
    );
  }
  assert.equal(
    parseBlockerProposalRecord({
      title: rendered.title,
      body: rendered.body,
      user: { login: "forger", type: "User" },
    }),
    null,
  );
  assert.equal(
    parseBlockerProposalRecord(
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
            updated_at: "2026-08-06T00:01:00Z",
          },
        ],
      },
    ),
    null,
  );
});

test("trusts an Actions-created blocker after an App identity audit", () => {
  const rendered = buildBlockerIssue({
    sourceIssue: 42,
    sourceCycle: 3,
    executionContentHash: "a".repeat(64),
    proposal,
  });
  const actionsIssue = {
    title: rendered.title,
    body: rendered.body,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: null,
    created_at: "2026-08-07T07:56:36Z",
    updated_at: "2026-08-07T07:56:36Z",
  };
  const identity = {
    body: rendered.identityComment,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: "2026-08-07T07:56:37Z",
    updated_at: "2026-08-07T07:56:37Z",
  };

  assert.deepEqual(
    parseBlockerProposalRecord(actionsIssue, { comments: [identity] }),
    rendered.record,
  );
  for (const edited of [
    { ...actionsIssue, title: `${actionsIssue.title} edited` },
    { ...actionsIssue, body: `${actionsIssue.body}\nedited` },
  ]) {
    assert.equal(
      parseBlockerProposalRecord(edited, { comments: [identity] }),
      null,
    );
  }
  assert.equal(canRegisterBlockerIdentity(actionsIssue, rendered), true);
  assert.equal(
    canRegisterBlockerIdentity(
      { ...actionsIssue, title: `${actionsIssue.title} edited` },
      rendered,
    ),
    false,
  );
  assert.equal(
    canRegisterBlockerIdentity(
      { ...actionsIssue, body: `${actionsIssue.body}\nedited` },
      rendered,
    ),
    false,
  );
  assert.equal(
    canRegisterBlockerIdentity(
      actionsIssue,
      {
        ...rendered,
        record: { ...rendered.record, digest: "0".repeat(64) },
      },
    ),
    false,
  );
  assert.equal(
    parseBlockerProposalRecord(
      {
        ...actionsIssue,
        user: { ...actionsIssue.user, id: 1 },
      },
      { comments: [identity] },
    ),
    null,
  );
  assert.equal(
    parseBlockerProposalRecord(
      {
        ...actionsIssue,
        user: { id: 41898282, login: "forger", type: "User" },
      },
      { comments: [identity] },
    ),
    null,
  );
});

test("keeps blocker identity trusted after an authoritative dependency update", () => {
  const rendered = buildBlockerIssue({
    sourceIssue: 42,
    sourceCycle: 3,
    executionContentHash: "a".repeat(64),
    proposal,
  });
  const identity = {
    body: rendered.identityComment,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: "2026-08-07T07:56:37Z",
    updated_at: "2026-08-07T07:56:37Z",
  };
  const nestedBlockerIssue = {
    number: 99,
    title: rendered.title,
    body: replaceBlockedBy(rendered.body, [7], { issueNumber: 99 }),
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: null,
  };

  assert.deepEqual(
    parseBlockerProposalRecord(nestedBlockerIssue, { comments: [identity] }),
    rendered.record,
  );
});

test("keeps model-supplied headings out of generated blocker Issue structure", () => {
  const headings = [
    "## Problem",
    "## Deliverable",
    "## Scope",
    "## Acceptance criteria",
    "## Validation",
    "## Blocked by",
  ];
  const rendered = buildBlockerIssue({
    sourceIssue: 42,
    sourceCycle: 3,
    executionContentHash: "a".repeat(64),
    proposal: {
      ...proposal,
      problem: ["The dependency is missing.", ...headings, "Injected text"].join(
        "\n",
      ),
    },
  });

  for (const heading of headings) {
    const structuralHeading = new RegExp(`^${heading}$`, "gm");
    assert.equal(rendered.body.match(structuralHeading)?.length, 1);
  }
  const graph = inspectBlockerGraph([
    issue(42),
    issue(43, [], { body: rendered.body }),
  ]);
  assert.equal(graph.errors.size, 0);
});

test("replaces only the deterministic Blocked by section", () => {
  const original = issue(42).body;
  const replaced = replaceBlockedBy(original, [7, 9], { issueNumber: 42 });
  assert.match(replaced, /## Blocked by\n\n- #7\n- #9/);
  assert.equal(replaced.split("## Problem")[1], original.split("## Problem")[1].replace("## Blocked by\n\nNone\n", "## Blocked by\n\n- #7\n- #9\n"));
  assert.match(
    replaceBlockedBy(original.replace("None", "Waiting for planning"), [7], {
      issueNumber: 42,
    }),
    /## Blocked by\n\n- #7/,
  );
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
  const prTarget = inspectBlockerGraph([
    issue(1, [2]),
    issue(2, [], { pull_request: { url: "https://api.github.test/pulls/2" } }),
  ]);
  assert.match(prTarget.errors.get(1), /missing or is a PR/);
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

test("hydrates native dependencies with bounded concurrency", async () => {
  let active = 0;
  let peak = 0;
  const snapshot = await hydrateNativeDependencies(
    Array.from({ length: 12 }, (_, index) => issue(index + 1)),
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return [];
    },
    { concurrency: 3 },
  );
  assert.equal(snapshot.size, 12);
  assert.equal(peak, 3);
});

test("keeps Wayfinder planning objects outside the Execution Graph", () => {
  const implementation = issue(1);
  const map = issue(2, [], {
    labels: [{ name: "wayfinder:map" }],
    body: "Question: should planning tickets use `## Blocked by`?",
  });
  const decision = issue(3, [], {
    labels: [{ name: "wayfinder:grilling" }],
    body: "## Question\n\nChoose the dependency model.",
  });
  const planningGraph = inspectBlockerGraph(
    [implementation, map, decision],
    {
      nativeDependencies: new Map([
        [1, []],
        [2, [decision]],
        [3, [map]],
      ]),
    },
  );
  assert.equal(planningGraph.errors.size, 0);
  assert.deepEqual(reconciliationIssueNumbers(planningGraph), []);

  const crossDomain = inspectBlockerGraph(
    [implementation, map, decision],
    { nativeDependencies: new Map([[1, [decision]]]) },
  );
  assert.match(crossDomain.errors.get(1), /cross-domain/);
  assert.throws(
    () =>
      validatedExecutionIssue([implementation, map, decision], 1, {
        nativeDependencies: new Map([[1, [decision]]]),
      }),
    /cross-domain/,
  );
  assert.equal(crossDomain.errors.has(2), false);
  assert.equal(crossDomain.errors.has(3), false);

  const unavailable = inspectBlockerGraph([implementation], {
    nativeDependencies: new Map([[1, null]]),
  });
  assert.equal(
    unavailable.errors.get(1),
    "native-dependency-response-invalid",
  );
  assert.equal(classifyDependentBlockers(unavailable, 1).state, "triage");
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
  const multiple = classifyDependentBlockers(
    inspectBlockerGraph([
      issue(1, [2, 3]),
      issue(2, [], { state: "closed", state_reason: "completed" }),
      issue(3),
    ]),
    1,
  );
  assert.equal(multiple.state, "blocked");
  assert.deepEqual(
    multiple.blockers.map(({ number, status }) => ({ number, status })),
    [
      { number: 2, status: "completed" },
      { number: 3, status: "open" },
    ],
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
