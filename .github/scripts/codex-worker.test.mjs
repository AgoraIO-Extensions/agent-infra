import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import * as worker from "./codex-worker.mjs";
import {
  authorizationEditInvalidation,
  buildWorkerPullRequestBody,
  buildWorkerPrompt,
  classifyWorkerEvent,
  createWorkerPlan,
  evaluateFrontierIssue,
  evaluatePublicationState,
  humanValidationLabelAction,
  parseBlockedBy,
  sanitizeWorkerMarkdown,
  shouldConsumeAuthorization,
  validateWorkerConfiguration,
  validateWorkerPlan,
  validateWorkerResult,
} from "./codex-worker.mjs";
import { extractPrimaryIssueNumbers } from "./pr-gates.mjs";
import {
  buildBlockerIssue,
  buildBlockerStateComment,
  classifyDependentBlockers,
  inspectBlockerGraph,
} from "./blocker-contract.mjs";

test("parses deterministic Blocked by declarations", () => {
  assert.deepEqual(parseBlockedBy("## Blocked by\n\nNone\n"), []);
  assert.deepEqual(
    parseBlockedBy("## Blocked by\n\n- #12\n- #34\n\n## Notes\nLater"),
    [12, 34],
  );
});

test("rejects missing, duplicated, self-referential, or free-form blockers", () => {
  assert.throws(() => parseBlockedBy("## Scope\nNone"), /Blocked by/);
  assert.throws(() => parseBlockedBy("## Blocked by\nNone\n\n## Blocked by\nNone"));
  assert.throws(() => parseBlockedBy("## Blocked by\nWaiting for #12"));
  assert.throws(() => parseBlockedBy("## Blocked by\n- #12\n- #12"));
  assert.throws(() => parseBlockedBy("## Blocked by\n- #16", { issueNumber: 16 }));
});

test("classifies only explicit Worker control and execution events", () => {
  assert.equal(
    classifyWorkerEvent({
      eventName: "repository_dispatch",
      dispatchOperation: "evaluate",
    }),
    "evaluate",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "repository_dispatch",
      dispatchOperation: "delete",
    }),
    "noop",
  );
  assert.equal(
    classifyWorkerEvent({ eventName: "issues", action: "labeled", label: "bug" }),
    "noop",
  );
  assert.equal(
    classifyWorkerEvent({ eventName: "issues", action: "edited" }),
    "evaluate",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "issues",
      action: "labeled",
      label: "ready-for-agent",
    }),
    "evaluate",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "issues",
      action: "unlabeled",
      label: "needs-triage",
    }),
    "evaluate",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "issues",
      action: "unlabeled",
      label: "ready-for-agent",
    }),
    "pause",
  );
  assert.equal(
    classifyWorkerEvent({ eventName: "issues", action: "labeled", label: "wontfix" }),
    "close",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "pull_request_target",
      action: "closed",
      headRef: "codex/issue-42-cycle-1",
      merged: false,
      sameRepository: true,
    }),
    "closed-pr",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "pull_request_target",
      action: "closed",
      headRef: "codex/issue-42-cycle-1",
      merged: false,
      sameRepository: false,
    }),
    "noop",
  );
});

test("invalidates protected or untrusted blocker edits but permits checkbox and trusted metadata edits", () => {
  const body = "## Blocked by\n\nNone\n";
  const blocked = "## Blocked by\n\n- #7\n";
  assert.equal(
    authorizationEditInvalidation({
      executionContentMatches: true,
      contractValid: true,
      bodyWasEdited: true,
      currentBody: blocked,
      previousBody: body,
      issueNumber: 42,
      actor: { login: "issue-author", type: "User" },
    }),
    "untrusted-blocker-edit",
  );
  assert.equal(
    authorizationEditInvalidation({
      executionContentMatches: true,
      contractValid: true,
      bodyWasEdited: true,
      currentBody: blocked,
      previousBody: body,
      issueNumber: 42,
      actor: { login: "github-actions[bot]", type: "Bot" },
    }),
    "trusted-blocker-edit",
  );
  assert.equal(
    authorizationEditInvalidation({
      executionContentMatches: true,
      contractValid: true,
      bodyWasEdited: true,
      currentBody: body,
      previousBody: body,
      issueNumber: 42,
      actor: { login: "owner", type: "User" },
    }),
    null,
  );
  assert.equal(
    authorizationEditInvalidation({
      executionContentMatches: false,
      contractValid: true,
      bodyWasEdited: true,
      currentBody: body,
      previousBody: body,
      issueNumber: 42,
      actor: { login: "github-actions[bot]", type: "Bot" },
    }),
    "content-changed",
  );
});

test("consumes every non-consumed authorization state for the matching cycle", () => {
  for (const state of ["active", "paused", "invalidated"]) {
    assert.equal(shouldConsumeAuthorization({ state, cycle: 3 }), true);
    assert.equal(
      shouldConsumeAuthorization({ state, cycle: 3 }, { cycle: 3 }),
      true,
    );
  }
  assert.equal(shouldConsumeAuthorization({ state: "consumed", cycle: 3 }), false);
  assert.equal(
    shouldConsumeAuthorization({ state: "active", cycle: 3 }, { cycle: 4 }),
    false,
  );
  assert.equal(shouldConsumeAuthorization(null), false);
});

test("Worker Publisher can add but never remove ready-for-human", () => {
  assert.equal(humanValidationLabelAction(true, []), "add");
  assert.equal(humanValidationLabelAction(true, ["ready-for-human"]), "noop");
  assert.equal(humanValidationLabelAction(false, ["ready-for-human"]), "noop");
  assert.equal(humanValidationLabelAction(false, []), "noop");
});

const workerContract = {
  hash: "c".repeat(64),
  blockedByHash: "d".repeat(64),
  acceptanceCriteriaIds: ["AC-1"],
};
const workerAuthorization = {
  issueNumber: 42,
  cycle: 1,
  state: "active",
  executionContentHash: workerContract.hash,
  blockedByHash: workerContract.blockedByHash,
  authorizationEventId: 1234,
};

function frontier(overrides = {}) {
  return evaluateFrontierIssue({
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "ready-for-agent" }],
    },
    contract: workerContract,
    authorizationRecord: workerAuthorization,
    blockers: [],
    workerPullRequests: [],
    branchSha: null,
    defaultSha: "a".repeat(40),
    ...overrides,
  });
}

test("starts from default branch or resumes the fixed branch and Draft PR", () => {
  assert.deepEqual(frontier(), {
    operation: "implement",
    reason: "frontier",
    startSha: "a".repeat(40),
    branch: "codex/issue-42-cycle-1",
    pullRequestNumber: null,
  });
  assert.deepEqual(
    frontier({
      branchSha: "b".repeat(40),
      workerPullRequests: [
        {
          number: 9,
          state: "open",
          draft: true,
          merged_at: null,
          head: {
            ref: "codex/issue-42-cycle-1",
            repo: { full_name: "AgoraIO-Extensions/agent-infra" },
          },
          base: { ref: "main" },
        },
      ],
    }),
    {
      operation: "implement",
      reason: "frontier",
      startSha: "b".repeat(40),
      branch: "codex/issue-42-cycle-1",
      pullRequestNumber: 9,
    },
  );
});

test("does not execute blocked or Ready-for-review Issues", () => {
  assert.equal(
    frontier({ blockers: [{ number: 12, state: "open" }] }).operation,
    "noop",
  );
  assert.deepEqual(
    frontier({
      branchSha: "b".repeat(40),
      workerPullRequests: [
        { number: 9, state: "open", draft: false, merged_at: null },
      ],
    }),
    {
      operation: "noop",
      reason: "ready-pr-exists",
      pullRequestNumber: 9,
    },
  );
});

test("requires completed state_reason and no wontfix label for every blocker", () => {
  assert.deepEqual(
    frontier({
      blockers: [{ number: 12, state: "closed", state_reason: "not_planned" }],
    }),
    { operation: "triage", reason: "blocker-not-planned" },
  );
  assert.deepEqual(
    frontier({ blockers: [{ number: 12, state: "closed", state_reason: null }] }),
    { operation: "triage", reason: "invalid-blocker-state" },
  );
  assert.equal(
    frontier({
      blockers: [
        {
          number: 12,
          state: "closed",
          state_reason: "completed",
          labels: [{ name: "wontfix" }],
        },
      ],
    }).reason,
    "blocker-not-planned",
  );
  assert.equal(
    frontier({
      blockers: [{ number: 12, state: "closed", state_reason: "completed" }],
    }).operation,
    "implement",
  );
});

test("accepts each reconciler dispatch signature only once", async () => {
  const source = {
    number: 42,
    state: "open",
    labels: [{ name: "ready-for-agent" }],
  };
  const blocker = { number: 43, state: "closed", state_reason: "completed" };
  const state = classifyDependentBlockers(
    inspectBlockerGraph([
      {
        ...source,
        body: "## Blocked by\n\n- #43\n",
      },
      { ...blocker, body: "## Blocked by\n\nNone\n" },
    ]),
    42,
  );
  let nextCommentId = 2;
  const comments = [
    {
      id: 1,
      body: buildBlockerStateComment(state),
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
      created_at: "2026-08-06T00:00:00Z",
      updated_at: "2026-08-06T00:00:00Z",
    },
  ];
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/42") && !options.method) return source;
    if (apiPath.endsWith("/issues/42/comments") && options.method === "POST") {
      const body = JSON.parse(options.body).body;
      comments.push({
        id: nextCommentId,
        body,
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
        created_at: "2026-08-06T00:00:01Z",
        updated_at: "2026-08-06T00:00:01Z",
      });
      nextCommentId += 1;
      return comments.at(-1);
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  const paginate = async () => comments;
  const event = {
    action: "codex-worker",
    client_payload: {
      issue_number: 42,
      operation: "evaluate",
      reason: state.reason,
      blocker_state_signature: state.signature,
    },
  };
  assert.equal(
    await worker.authorizeReconcilerDispatch({
      repository: "example/agent-infra",
      event,
      token: "test-token",
      request,
      paginate,
    }),
    true,
  );
  assert.equal(
    await worker.authorizeReconcilerDispatch({
      repository: "example/agent-infra",
      event,
      token: "test-token",
      request,
      paginate,
    }),
    false,
  );
  assert.equal(comments.length, 2);
});

test("rejects an out-of-order dispatch after a newer blocker state audit", async () => {
  const completed = classifyDependentBlockers(
    inspectBlockerGraph([
      {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
        body: "## Blocked by\n\n- #43\n",
      },
      {
        number: 43,
        state: "closed",
        state_reason: "completed",
        body: "## Blocked by\n\nNone\n",
      },
    ]),
    42,
  );
  const blocked = classifyDependentBlockers(
    inspectBlockerGraph([
      {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
        body: "## Blocked by\n\n- #43\n",
      },
      {
        number: 43,
        state: "open",
        state_reason: null,
        body: "## Blocked by\n\nNone\n",
      },
    ]),
    42,
  );
  const appComment = (id, body) => ({
    id,
    body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    created_at: `2026-08-06T00:00:0${id}Z`,
    updated_at: `2026-08-06T00:00:0${id}Z`,
  });
  const comments = [
    appComment(1, buildBlockerStateComment(completed)),
    appComment(2, buildBlockerStateComment(blocked)),
  ];
  let mutations = 0;
  assert.equal(
    await worker.authorizeReconcilerDispatch({
      repository: "example/agent-infra",
      event: {
        action: "codex-worker",
        client_payload: {
          issue_number: 42,
          operation: "evaluate",
          reason: completed.reason,
          blocker_state_signature: completed.signature,
        },
      },
      token: "test-token",
      request: async (apiPath, options = {}) => {
        if (!options.method) return { number: 42, state: "open" };
        mutations += 1;
        throw new Error(`Unexpected mutation: ${apiPath}`);
      },
      paginate: async () => comments,
    }),
    false,
  );
  assert.equal(mutations, 0);
});

test("routes inconsistent branch and PR state to triage without duplication", () => {
  assert.equal(
    frontier({
      branchSha: "b".repeat(40),
      workerPullRequests: [
        { number: 9, state: "closed", draft: false, merged_at: null },
      ],
    }).reason,
    "closed-worker-pr",
  );
  assert.equal(
    frontier({
      workerPullRequests: [
        { number: 9, state: "open", draft: true, merged_at: null },
        { number: 10, state: "open", draft: true, merged_at: null },
      ],
    }).operation,
    "triage",
  );
  assert.equal(
    frontier({
      branchSha: null,
      workerPullRequests: [
        { number: 9, state: "open", draft: true, merged_at: null },
      ],
    }).reason,
    "worker-branch-missing",
  );
});

test("creates one immutable plan from a frontier Issue", () => {
  assert.deepEqual(
    createWorkerPlan({
      repository: "AgoraIO-Extensions/agent-infra",
      defaultBranch: "main",
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [],
      branchSha: null,
      defaultSha: "a".repeat(40),
    }),
    {
      operation: "implement",
      reason: "frontier",
      plan: workerPlan,
    },
  );
});

test("refuses to start or publish beside an active PR from another cycle", () => {
  const conflictingPullRequest = {
    number: 8,
    state: "open",
    merged_at: null,
    head: { ref: "codex/issue-42-cycle-7" },
  };
  assert.deepEqual(
    createWorkerPlan({
      repository: "AgoraIO-Extensions/agent-infra",
      defaultBranch: "main",
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [],
      allWorkerPullRequests: [conflictingPullRequest],
      branchSha: null,
      defaultSha: "a".repeat(40),
    }),
    { operation: "triage", reason: "conflicting-worker-pr" },
  );
  assert.deepEqual(
    evaluatePublicationState({
      plan: workerPlan,
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [],
      allWorkerPullRequests: [conflictingPullRequest],
      branchSha: null,
    }),
    { operation: "triage", reason: "conflicting-worker-pr" },
  );
});

test("publication requires the recorded branch and Draft PR state", () => {
  const issue = {
    number: 42,
    state: "open",
    labels: [{ name: "ready-for-agent" }],
  };
  assert.deepEqual(
    evaluatePublicationState({
      plan: workerPlan,
      issue,
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [],
      branchSha: null,
    }),
    { operation: "publish", reason: "authorized" },
  );
  assert.deepEqual(
    evaluatePublicationState({
      plan: workerPlan,
      issue,
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [],
      branchSha: "b".repeat(40),
    }),
    { operation: "triage", reason: "stale-worker-branch" },
  );
  assert.equal(
    evaluatePublicationState({
      plan: { ...workerPlan, branchExisted: true, pullRequestNumber: 9 },
      issue,
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [
        {
          number: 9,
          state: "open",
          draft: true,
          merged_at: null,
          head: {
            ref: "codex/issue-42-cycle-1",
            repo: { full_name: "AgoraIO-Extensions/agent-infra" },
          },
          base: { ref: "main" },
        },
      ],
      branchSha: "a".repeat(40),
    }).operation,
    "publish",
  );
  assert.deepEqual(
    evaluatePublicationState({
      plan: { ...workerPlan, branchExisted: true, pullRequestNumber: 9 },
      issue,
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [
        {
          number: 9,
          state: "open",
          draft: true,
          merged_at: null,
          head: {
            ref: "codex/issue-42-cycle-1",
            repo: { full_name: "someone/fork" },
          },
          base: { ref: "main" },
        },
      ],
      branchSha: "a".repeat(40),
    }),
    { operation: "triage", reason: "foreign-worker-pr" },
  );
  assert.equal(
    evaluatePublicationState({
      plan: workerPlan,
      issue: { ...issue, labels: [] },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [],
      branchSha: null,
    }).operation,
    "pause",
  );
});

test("accepts only official checkout HTTPS remotes for Worker publication", () => {
  const repository = "AgoraIO-Extensions/agent-infra";

  assert.equal(
    worker.isExpectedPublicationRemote(
      "https://github.com/AgoraIO-Extensions/agent-infra",
      repository,
    ),
    true,
  );
  assert.equal(
    worker.isExpectedPublicationRemote(
      "https://github.com/AgoraIO-Extensions/agent-infra.git",
      repository,
    ),
    true,
  );
  for (const remote of [
    "https://github.com/AgoraIO-Extensions/agent-infra/",
    "https://github.com/AgoraIO-Extensions/agent-infra-other",
    "https://user@github.com/AgoraIO-Extensions/agent-infra",
    "git@github.com:AgoraIO-Extensions/agent-infra.git",
    "https://example.com/AgoraIO-Extensions/agent-infra",
  ]) {
    assert.equal(worker.isExpectedPublicationRemote(remote, repository), false);
  }
});

test("marks the Worker PR ready through the fixed GraphQL mutation", async () => {
  const calls = [];
  const result = await worker.markPullRequestReadyForReview({
    pullRequest: { number: 41, node_id: "PR_node_id" },
    token: "test-token",
    request: async (apiPath, options) => {
      calls.push({ apiPath, options });
      return {
        data: {
          markPullRequestReadyForReview: {
            pullRequest: { number: 41, isDraft: false },
          },
        },
      };
    },
  });

  assert.equal(result, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiPath, "/graphql");
  assert.equal(calls[0].options.token, "test-token");
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.query, /markPullRequestReadyForReview/);
  assert.doesNotMatch(payload.query, /\bmergePullRequest\b/);
  assert.deepEqual(payload.variables, { pullRequestId: "PR_node_id" });
  await assert.rejects(
    () =>
      worker.markPullRequestReadyForReview({
        pullRequest: { number: 41 },
        token: "test-token",
        request: async () => ({}),
      }),
    /node_id/,
  );
});

const workerPlan = {
  version: 3,
  repository: "AgoraIO-Extensions/agent-infra",
  defaultBranch: "main",
  issueNumber: 42,
  cycle: 1,
  executionContentHash: workerContract.hash,
  authorizationEventId: 1234,
  acceptanceCriteriaIds: ["AC-1"],
  startSha: "a".repeat(40),
  branch: "codex/issue-42-cycle-1",
  branchExisted: false,
  pullRequestNumber: null,
  mode: "implement",
  repairRound: null,
  workerRunId: createHash("sha256")
    .update(
      JSON.stringify([
        "AgoraIO-Extensions/agent-infra",
        42,
        1,
        "a".repeat(40),
        "implement",
        null,
      ]),
    )
    .digest("hex"),
  attempt: 1,
  modelSlot: 1,
  checkpointRunId: null,
  checkpointArtifactName: null,
  checkpointSourceAttempt: null,
  remainingAcceptanceCriteria: ["AC-1"],
};

test("routes malformed current Worker attempt audit to prepare triage", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "agent-infra-worker-prepare-"));
  const eventPath = path.join(root, "event.json");
  const outputPath = path.join(root, "output.txt");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: "labeled",
      label: { name: "ready-for-agent" },
      issue: { number: 42 },
      repository: { default_branch: "main" },
    }),
  );
  writeFileSync(outputPath, "");
  const environment = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: workerPlan.repository,
    GITHUB_EVENT_NAME: "issues",
    GITHUB_OUTPUT: outputPath,
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const malformedRecord = {
    version: 1,
    issueNumber: workerPlan.issueNumber,
    cycle: workerPlan.cycle,
    workerRunId: workerPlan.workerRunId,
    baseSha: workerPlan.startSha,
    attempt: 0,
    outcome: "completed",
    terminationReason: "completed",
    remainingAcceptanceCriteria: [],
    checkpoint: null,
    recordedAt: "2026-08-10T00:00:00.000Z",
  };

  await worker.prepareCommand({
    fetchState: async () => ({
      issue: {
        number: workerPlan.issueNumber,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      comments: [
        {
          id: 105,
          body: `<!-- agent-infra-worker-attempt:${Buffer.from(
            JSON.stringify(malformedRecord),
            "utf8",
          ).toString("base64url")} -->`,
          user: { login: "github-actions[bot]", type: "Bot" },
          performed_via_github_app: { id: 15368 },
          created_at: "2026-08-10T00:00:00Z",
          updated_at: "2026-08-10T00:00:00Z",
        },
      ],
      workerPullRequests: [],
      branchSha: null,
      defaultSha: workerPlan.startSha,
    }),
  });

  assert.match(
    readFileSync(outputPath, "utf8"),
    /^operation=triage\nreason=prepare-failed\nissue_number=42\n/,
  );
});

test("resumes a later attempt from the last validated checkpoint", () => {
  const workerRunId = workerPlan.workerRunId;
  const checkpoint = {
    issueNumber: 42,
    cycle: 1,
    workerRunId,
    baseSha: "a".repeat(40),
    sourceAttempt: 1,
    patchSha256: "b".repeat(64),
    artifactRunId: 123,
    artifactName: `codex-worker-checkpoint-${workerRunId}-attempt-1`,
    remainingAcceptanceCriteria: ["AC-1"],
  };
  const result = createWorkerPlan({
    repository: "AgoraIO-Extensions/agent-infra",
    defaultBranch: "main",
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "ready-for-agent" }],
    },
    contract: workerContract,
    authorizationRecord: workerAuthorization,
    blockers: [],
    workerPullRequests: [],
    branchSha: null,
    defaultSha: "a".repeat(40),
    attempts: [
      { attempt: 1, outcome: "recoverable", checkpoint },
      { attempt: 2, outcome: "started", checkpoint: null },
    ],
  });

  assert.equal(result.plan.attempt, 3);
  assert.equal(result.plan.checkpointSourceAttempt, 1);
  assert.equal(result.plan.checkpointArtifactName, checkpoint.artifactName);
});

test("creates a bounded repair plan for the current ready Worker PR", () => {
  const headSha = "f".repeat(40);
  const pullRequest = {
    number: 90,
    state: "open",
    draft: false,
    merged_at: null,
    head: {
      ref: "codex/issue-42-cycle-1",
      sha: headSha,
      repo: { full_name: "AgoraIO-Extensions/agent-infra" },
    },
    base: { ref: "main" },
  };
  const result = createWorkerPlan({
    repository: "AgoraIO-Extensions/agent-infra",
    defaultBranch: "main",
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "ready-for-agent" }],
    },
    contract: workerContract,
    authorizationRecord: workerAuthorization,
    blockers: [],
    workerPullRequests: [pullRequest],
    branchSha: headSha,
    defaultSha: "a".repeat(40),
    mode: "repair",
    repairRound: 1,
    repairPullRequest: pullRequest,
  });

  assert.equal(result.operation, "implement");
  assert.equal(result.plan.mode, "repair");
  assert.equal(result.plan.repairRound, 1);
  assert.equal(result.plan.pullRequestNumber, 90);
  assert.equal(result.plan.startSha, headSha);
  assert.equal(result.plan.branchExisted, true);
  assert.deepEqual(
    evaluatePublicationState({
      plan: result.plan,
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [],
      workerPullRequests: [pullRequest],
      branchSha: headSha,
    }),
    { operation: "publish", reason: "authorized" },
  );
  assert.match(
    buildWorkerPrompt({
      issue: { number: 42, title: "Repair worker", body: "## Scope\nFix it" },
      plan: result.plan,
      recoveryContext: ["Run tests failed on the current head."],
    }),
    /Repair round: 1\/2[\s\S]*Run tests failed on the current head\./,
  );
  assert.deepEqual(
    createWorkerPlan({
      repository: "AgoraIO-Extensions/agent-infra",
      defaultBranch: "main",
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      contract: workerContract,
      authorizationRecord: workerAuthorization,
      blockers: [{ number: 12, state: "open" }],
      workerPullRequests: [pullRequest],
      branchSha: headSha,
      defaultSha: "a".repeat(40),
      mode: "repair",
      repairRound: 1,
      repairPullRequest: pullRequest,
    }),
    { operation: "noop", reason: "open-blockers" },
  );
});

test("preserves repair mode when retrying a recoverable repair attempt", () => {
  const headSha = "f".repeat(40);
  const pullRequest = {
    number: 90,
    state: "open",
    draft: false,
    merged_at: null,
    head: {
      ref: "codex/issue-42-cycle-1",
      sha: headSha,
      repo: { full_name: "AgoraIO-Extensions/agent-infra" },
    },
    base: { ref: "main" },
  };
  const state = {
    repository: "AgoraIO-Extensions/agent-infra",
    defaultBranch: "main",
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "ready-for-agent" }],
    },
    contract: workerContract,
    authorizationRecord: workerAuthorization,
    blockers: [],
    workerPullRequests: [pullRequest],
    branchSha: headSha,
    defaultSha: "a".repeat(40),
  };
  const first = createWorkerPlan({
    ...state,
    mode: "repair",
    repairRound: 1,
    repairPullRequest: pullRequest,
  });
  const checkpoint = {
    issueNumber: 42,
    cycle: 1,
    workerRunId: first.plan.workerRunId,
    baseSha: headSha,
    sourceAttempt: 1,
    patchSha256: "b".repeat(64),
    artifactRunId: 123,
    artifactName: `codex-worker-checkpoint-${first.plan.workerRunId}-attempt-1`,
    remainingAcceptanceCriteria: ["AC-1"],
  };

  const retry = createWorkerPlan({
    ...state,
    attempts: [{ attempt: 1, outcome: "recoverable", checkpoint }],
    retryIdentity: {
      issue_number: 42,
      cycle: 1,
      worker_run_id: first.plan.workerRunId,
      base_sha: headSha,
      attempt: 1,
    },
  });

  assert.equal(retry.operation, "implement");
  assert.equal(retry.plan.mode, "repair");
  assert.equal(retry.plan.repairRound, 1);
  assert.equal(retry.plan.attempt, 2);
  assert.equal(retry.plan.workerRunId, first.plan.workerRunId);
  assert.equal(retry.plan.pullRequestNumber, 90);
});

test("validates bounded repository configuration before invoking Codex", () => {
  assert.deepEqual(
    validateWorkerConfiguration({
      endpoint: "https://api.example.com/v1/responses",
      model: "gpt-5.4",
      effort: "high",
      timeout: "60",
    }),
    {
      endpoint: "https://api.example.com/v1/responses",
      model: "gpt-5.4",
      effort: "high",
      timeout: 60,
    },
  );
  assert.throws(() =>
    validateWorkerConfiguration({
      endpoint: "http://127.0.0.1/v1/responses",
      model: "gpt-5.4",
      effort: "high",
      timeout: "60",
    }),
  );
  assert.throws(() =>
    validateWorkerConfiguration({
      endpoint: "https://api.example.com/v1/responses",
      model: "$(bad)",
      effort: "extreme",
      timeout: "0",
    }),
  );
});

test("binds a Worker plan and file-based prompt to one fixed Issue branch", () => {
  assert.deepEqual(
    validateWorkerPlan(workerPlan, {
      repository: "AgoraIO-Extensions/agent-infra",
      issueNumber: 42,
      startSha: "a".repeat(40),
    }),
    workerPlan,
  );
  assert.throws(() =>
    validateWorkerPlan({ ...workerPlan, branch: "codex/issue-7-cycle-1" }),
  );
  assert.throws(() =>
    validateWorkerPlan({ ...workerPlan, unexpected: true }),
  );

  const prompt = buildWorkerPrompt({
    issue: { number: 42, title: "Implement worker", body: "## Scope\nShip it" },
    plan: workerPlan,
  });
  assert.match(prompt, /\$implement/);
  assert.match(prompt, /\.codex-worker-artifact\/output\/change\.patch/);
  assert.match(prompt, /Issue #42/);
  assert.match(prompt, /## Scope\nShip it/);
  assert.match(prompt, /human_handoffs/);
  assert.match(prompt, /protected path/);
  assert.match(prompt, /Model attempt: 1\/3/);
  assert.match(prompt, /Remaining AC: AC-1/);
  assert.doesNotMatch(prompt, /Closes #42/);
  assert.throws(
    () =>
      buildWorkerPrompt({
        issue: {
          number: 42,
          title: "Implement worker",
          body: `api_key=sk-${"a".repeat(40)}`,
        },
        plan: workerPlan,
      }),
    /secret-like content/,
  );
});

function workerResult(overrides = {}) {
  return JSON.stringify({
    completed: true,
    issue_number: 42,
    cycle: 1,
    execution_content_hash: workerContract.hash,
    start_sha: "a".repeat(40),
    branch: "codex/issue-42-cycle-1",
    summary: "Implemented the requested behavior.",
    blocker_proposals: [],
    human_handoffs: [],
    acceptance_criteria: [
      { id: "AC-1", status: "pass", evidence: "The behavior is covered." },
    ],
    tests: ["node --test"],
    not_run: [],
    human_validation_required: false,
    human_validation: [],
    risks: ["None known."],
    ...overrides,
  });
}

const blockerProposal = {
  proposal_id: "missing-migration",
  title: "add the required migration",
  problem: "The requested implementation depends on a missing database table.",
  deliverable: "A migration that creates the required database table.",
  scope: ["Add the missing migration."],
  acceptance_criteria: [
    { id: "AC-1", text: "The migration applies cleanly." },
  ],
  validation: ["Run the migration test."],
};

const humanHandoff = {
  handoff_id: "protected-workflow-change",
  reason: "protected_path_change",
  required_action: "Model-authored action delta must be reviewed by a person.",
};

function jsonScalarType(value) {
  if (value === null || !["boolean", "number", "string"].includes(typeof value)) {
    throw new TypeError("Expected a scalar JSON Schema value");
  }
  return typeof value;
}

function assertExplicitScalarTypes(schema, location = "schema") {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) =>
      assertExplicitScalarTypes(value, `${location}[${index}]`),
    );
    return;
  }
  if (!schema || typeof schema !== "object") return;

  if (Object.hasOwn(schema, "const")) {
    assert.equal(
      schema.type,
      jsonScalarType(schema.const),
      `${location} must declare the scalar type used by const`,
    );
  }
  if (Array.isArray(schema.enum)) {
    const enumTypes = new Set(schema.enum.map(jsonScalarType));
    assert.equal(enumTypes.size, 1, `${location} enum must use one scalar type`);
    assert.equal(
      schema.type,
      [...enumTypes][0],
      `${location} must declare the scalar type used by enum`,
    );
  }

  for (const [key, value] of Object.entries(schema)) {
    assertExplicitScalarTypes(value, `${location}.${key}`);
  }
}

test("declares explicit scalar types throughout the Codex output schema", () => {
  const schemaPath = path.join(
    import.meta.dirname,
    "..",
    "codex-worker-result.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  assertExplicitScalarTypes(schema);
});

function assertOpenAiStrictSchemaSubset(schema, location = "schema") {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) =>
      assertOpenAiStrictSchemaSubset(value, `${location}[${index}]`),
    );
    return;
  }
  if (!schema || typeof schema !== "object") return;

  for (const [key, value] of Object.entries(schema)) {
    assert.equal(
      ["allOf", "if", "then", "else"].includes(key),
      false,
      `${location}.${key} is not accepted by the OpenAI strict schema subset`,
    );
    assertOpenAiStrictSchemaSubset(value, `${location}.${key}`);
  }
}

test("keeps the Codex output schema within the OpenAI strict subset", () => {
  const schemaPath = path.join(
    import.meta.dirname,
    "..",
    "codex-worker-result.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  assertOpenAiStrictSchemaSubset(schema);
  assert.ok(schema.required.includes("human_handoffs"));
  assert.deepEqual(schema.properties.human_handoffs.items, {
    $ref: "#/$defs/humanHandoff",
  });
  assert.ok(schema.$defs.blockerProposal.required.includes("deliverable"));
  assert.deepEqual(schema.$defs.humanHandoff.properties.reason.enum, [
    "permission_required",
    "protected_path_change",
    "requirements_conflict",
    "credential_required",
    "architecture_decision",
  ]);
});

test("accepts only bounded Worker results for the recorded Issue and start commit", () => {
  const result = validateWorkerResult(workerResult(), workerPlan);
  assert.equal(result.issue_number, 42);
  assert.equal(result.human_validation_required, false);

  assert.throws(() =>
    validateWorkerResult(workerResult({ issue_number: 7 }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ start_sha: "b".repeat(40) }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ unexpected: true }), workerPlan),
  );
  const missingHandoffs = JSON.parse(workerResult());
  delete missingHandoffs.human_handoffs;
  assert.throws(() =>
    validateWorkerResult(JSON.stringify(missingHandoffs), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ summary: "x".repeat(4001) }), workerPlan),
  );
  assert.throws(
    () =>
      validateWorkerResult(
        workerResult({ summary: `api_key=sk-${"a".repeat(40)}` }),
        workerPlan,
      ),
    /secret-like content/,
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ tests: ["x".repeat(1001)] }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ acceptance_criteria: [] }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(
      workerResult({
        acceptance_criteria: [
          { id: "AC-2", status: "pass", evidence: "Wrong ID." },
        ],
      }),
      workerPlan,
    ),
  );
  assert.throws(() =>
    validateWorkerResult(
      workerResult({
        acceptance_criteria: [
          { id: "AC-1", status: "pending", evidence: "Not complete." },
        ],
      }),
      workerPlan,
    ),
  );
  assert.throws(() =>
    validateWorkerResult(
      workerResult({
        acceptance_criteria: [
          { id: "AC-1", status: "pass", evidence: "" },
        ],
      }),
      workerPlan,
    ),
  );
  assert.throws(() =>
    validateWorkerResult(
      workerResult({ human_validation_required: true, human_validation: [] }),
      workerPlan,
    ),
  );
});

test("accepts exactly one incomplete result mode and rejects mixed states", () => {
  const blocked = validateWorkerResult(
    workerResult({
      completed: false,
      blocker_proposals: [blockerProposal],
      acceptance_criteria: [
        { id: "AC-1", status: "blocked", evidence: "Missing migration." },
      ],
    }),
    workerPlan,
  );
  assert.equal(blocked.completed, false);
  assert.equal(blocked.blocker_proposals[0].proposal_id, "missing-migration");

  const handedOff = validateWorkerResult(
    workerResult({
      completed: false,
      human_handoffs: [humanHandoff],
      acceptance_criteria: [
        { id: "AC-1", status: "blocked", evidence: "Protected workflow path." },
      ],
    }),
    workerPlan,
  );
  assert.equal(handedOff.human_handoffs[0].reason, "protected_path_change");

  assert.throws(
    () =>
      validateWorkerResult(
        workerResult({ blocker_proposals: [blockerProposal] }),
        workerPlan,
      ),
    /Completed Worker result cannot contain incomplete work/,
  );
  assert.throws(
    () =>
      validateWorkerResult(
        workerResult({ completed: false, blocker_proposals: [] }),
        workerPlan,
      ),
    /exactly one incomplete mode/,
  );
  assert.throws(
    () =>
      validateWorkerResult(
        workerResult({
          completed: false,
          blocker_proposals: [blockerProposal],
          human_handoffs: [humanHandoff],
          acceptance_criteria: [
            { id: "AC-1", status: "blocked", evidence: "Mixed result." },
          ],
        }),
        workerPlan,
      ),
    /exactly one incomplete mode/,
  );
  assert.throws(
    () =>
      validateWorkerResult(
        workerResult({ human_handoffs: [humanHandoff] }),
        workerPlan,
      ),
    /Completed Worker result cannot contain incomplete work/,
  );
  assert.throws(
    () =>
      validateWorkerResult(
        workerResult({
          completed: false,
          blocker_proposals: [blockerProposal],
        }),
        workerPlan,
      ),
    /mark every AC as blocked/,
  );
});

test("maps completed, blocker, and handoff results to explicit operations", () => {
  assert.deepEqual(worker.workerResultOperation(JSON.parse(workerResult())), {
    operation: "publish",
    reason: "authorized",
  });
  assert.deepEqual(
    worker.workerResultOperation(
      JSON.parse(
        workerResult({ completed: false, blocker_proposals: [blockerProposal] }),
      ),
    ),
    { operation: "block", reason: "blocker-proposed" },
  );
  assert.deepEqual(
    worker.workerResultOperation(
      JSON.parse(
        workerResult({ completed: false, human_handoffs: [humanHandoff] }),
      ),
    ),
    { operation: "handoff", reason: "human-handoff" },
  );
});

test("publishes a human handoff once without creating a blocker Issue", async () => {
  let source = {
    number: 42,
    state: "open",
    labels: [{ name: "ready-for-agent" }],
  };
  const comments = [];
  const writes = [];
  let authorizationChecks = 0;
  const request = async (apiPath, options = {}) => {
    if (apiPath === "/repos/AgoraIO-Extensions/agent-infra/issues/42") {
      return source;
    }
    writes.push({ apiPath, options });
    if (apiPath.endsWith("/comments")) {
      const comment = {
        body: JSON.parse(options.body).body,
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
        created_at: "2026-08-09T00:00:00Z",
        updated_at: "2026-08-09T00:00:00Z",
      };
      comments.push(comment);
      return comment;
    }
    if (apiPath.endsWith("/labels")) {
      source = { ...source, labels: [...source.labels, { name: "needs-triage" }] };
      return source.labels;
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  const paginate = async (apiPath) => {
    assert.match(apiPath, /\/issues\/42\/comments$/);
    return comments;
  };
  const authorize = async () => {
    authorizationChecks += 1;
  };
  const result = validateWorkerResult(
    workerResult({
      completed: false,
      human_handoffs: [humanHandoff],
      acceptance_criteria: [
        { id: "AC-1", status: "blocked", evidence: "Protected workflow path." },
      ],
    }),
    workerPlan,
  );

  assert.deepEqual(
    await worker.publishHumanHandoffs({
      plan: workerPlan,
      result,
      token: "token",
      request,
      paginate,
      authorize,
    }),
    { handoffIds: ["protected-workflow-change"], replay: false },
  );
  assert.deepEqual(
    writes.map(({ apiPath }) => apiPath),
    [
      "/repos/AgoraIO-Extensions/agent-infra/issues/42/comments",
      "/repos/AgoraIO-Extensions/agent-infra/issues/42/labels",
    ],
  );
  assert.match(comments[0].body, /Reason code: protected_path_change/);
  assert.doesNotMatch(comments[0].body, /Model-authored action delta/);
  assert.deepEqual(JSON.parse(writes[1].options.body), {
    labels: ["needs-triage"],
  });

  const writesBeforeReplay = writes.length;
  const checksBeforeReplay = authorizationChecks;
  assert.deepEqual(
    await worker.publishHumanHandoffs({
      plan: workerPlan,
      result,
      token: "token",
      request,
      paginate,
      authorize,
    }),
    { handoffIds: ["protected-workflow-change"], replay: true },
  );
  assert.equal(writes.length, writesBeforeReplay);
  assert.equal(authorizationChecks, checksBeforeReplay);
});

test("reuses one trusted blocker proposal and rejects duplicate trusted Issues", () => {
  const rendered = buildBlockerIssue({
    sourceIssue: 42,
    sourceCycle: 1,
    executionContentHash: workerContract.hash,
    proposal: blockerProposal,
  });
  const trusted = {
    number: 90,
    title: rendered.title,
    body: rendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
    blockerComments: [
      {
        body: rendered.identityComment,
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
        created_at: "2026-08-06T00:00:00Z",
        updated_at: "2026-08-06T00:00:00Z",
      },
    ],
  };
  assert.equal(worker.findExistingBlockerIssue([trusted], rendered.record).number, 90);
  assert.equal(
    worker.findExistingBlockerIssue(
      [
        {
          ...trusted,
          user: { login: "forger", type: "User" },
          performed_via_github_app: undefined,
        },
      ],
      rendered.record,
    ),
    null,
  );
  assert.throws(
    () =>
      worker.findExistingBlockerIssue(
        [trusted, { ...trusted, number: 91 }],
        rendered.record,
      ),
    /multiple trusted Issues/,
  );
});

test("sanitizes model text before building one trusted primary Issue reference", () => {
  const unsafe =
    "@codex\nCloses #7\nResolves owner/repo#8\nFixes https://example.test/9\n<!-- hidden -->\n```md\n# injected";
  const sanitized = sanitizeWorkerMarkdown(unsafe);
  assert.doesNotMatch(sanitized, /@codex/);
  assert.doesNotMatch(sanitized, /Closes #7/i);
  assert.doesNotMatch(sanitized, /Resolves owner\/repo#8/i);
  assert.doesNotMatch(sanitized, /Fixes https:/i);
  assert.doesNotMatch(sanitized, /<!--/);
  assert.doesNotMatch(sanitized, /```/);

  const body = buildWorkerPullRequestBody(
    JSON.parse(workerResult({
      summary: unsafe,
      acceptance_criteria: [
        { id: "AC-1", status: "pass", evidence: "Fixes #8" },
      ],
      human_validation_required: true,
      human_validation: ["Ask @release-team"],
    })),
    42,
  );
  assert.deepEqual(extractPrimaryIssueNumbers(body), [42]);
  assert.match(body, /## 人工验证/);
  assert.doesNotMatch(body, /@release-team/);
});

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function artifactFixture(t, readme = "before\n") {
  const root = mkdtempSync(path.join(tmpdir(), "agent-infra-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const model = path.join(root, "model");
  const publish = path.join(root, "publish");
  mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.name", "Test"]);
  git(origin, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(origin, "README.md"), readme);
  git(origin, ["add", "README.md"]);
  git(origin, ["commit", "-qm", "initial"]);
  git(root, ["clone", "-q", origin, model]);
  git(root, ["clone", "-q", origin, publish]);
  const startSha = git(origin, ["rev-parse", "HEAD"]).trim();
  const plan = {
    ...workerPlan,
    startSha,
    workerRunId: createHash("sha256")
      .update(
        JSON.stringify([
          workerPlan.repository,
          workerPlan.issueNumber,
          workerPlan.cycle,
          startSha,
          workerPlan.mode,
          workerPlan.repairRound,
        ]),
      )
      .digest("hex"),
  };
  const resultPath = path.join(root, "result.json");
  writeFileSync(
    resultPath,
    workerResult({ start_sha: startSha }),
  );
  return { root, model, publish, plan, resultPath };
}

function writePatch(fixture) {
  git(fixture.model, ["add", "-N", "."]);
  const patchText = git(fixture.model, [
    "diff",
    "--full-index",
    "--no-renames",
    "HEAD",
    "--",
  ]);
  const patchPath = path.join(fixture.root, "change.patch");
  writeFileSync(patchPath, patchText);
  return patchPath;
}

function writeCheckpoint(fixture, patchPath, overrides = {}) {
  const patch = readFileSync(patchPath);
  const checkpointPath = path.join(fixture.root, "checkpoint.json");
  writeFileSync(
    checkpointPath,
    JSON.stringify({
      version: 1,
      issue_number: fixture.plan.issueNumber,
      cycle: fixture.plan.cycle,
      worker_run_id: "b".repeat(64),
      base_sha: fixture.plan.startSha,
      source_attempt: 1,
      patch_sha256: createHash("sha256").update(patch).digest("hex"),
      remaining_acceptance_criteria: ["AC-1"],
      error_classification: "timeout",
      ...overrides,
    }),
  );
  return checkpointPath;
}

function validateCheckpoint(fixture, patchPath, overrides = {}) {
  return worker.validateWorkerCheckpoint({
    workspace: fixture.publish,
    patchPath,
    checkpointPath: writeCheckpoint(fixture, patchPath, overrides),
    identity: {
      issueNumber: fixture.plan.issueNumber,
      cycle: fixture.plan.cycle,
      workerRunId: "b".repeat(64),
      baseSha: fixture.plan.startSha,
    },
    sourceAttempt: 1,
    acceptanceCriteriaIds: fixture.plan.acceptanceCriteriaIds,
  });
}

test("validates and applies a trusted text Patch checkpoint", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "checkpoint\n");
  const patchPath = writePatch(fixture);
  const checkpointPath = writeCheckpoint(fixture, patchPath);

  const checkpoint = await worker.validateWorkerCheckpoint({
    workspace: fixture.publish,
    patchPath,
    checkpointPath,
    identity: {
      issueNumber: fixture.plan.issueNumber,
      cycle: fixture.plan.cycle,
      workerRunId: "b".repeat(64),
      baseSha: fixture.plan.startSha,
    },
    sourceAttempt: 1,
    acceptanceCriteriaIds: fixture.plan.acceptanceCriteriaIds,
  });

  assert.deepEqual(checkpoint.remainingAcceptanceCriteria, ["AC-1"]);
  assert.equal(
    readFileSync(path.join(fixture.publish, "README.md"), "utf8"),
    "checkpoint\n",
  );
});

test("rejects secret-like content in a Worker checkpoint", async (t) => {
  for (const secret of [
    `OPENAI_API_KEY=sk-${"a".repeat(40)}`,
    `github_pat_${"a".repeat(82)}`,
  ]) {
    const fixture = artifactFixture(t);
    writeFileSync(path.join(fixture.model, "token.txt"), `${secret}\n`);
    const patchPath = writePatch(fixture);

    await assert.rejects(
      worker.validateWorkerCheckpoint({
        workspace: fixture.publish,
        patchPath,
        checkpointPath: writeCheckpoint(fixture, patchPath),
        identity: {
          issueNumber: fixture.plan.issueNumber,
          cycle: fixture.plan.cycle,
          workerRunId: "b".repeat(64),
          baseSha: fixture.plan.startSha,
        },
        sourceAttempt: 1,
        acceptanceCriteriaIds: fixture.plan.acceptanceCriteriaIds,
      }),
      /secret-like content/,
    );
  }
});

test("rejects secret-like content carried in checkpoint Patch context", async (t) => {
  const secretLine = `api_key=sk-${"a".repeat(40)}`;
  const fixture = artifactFixture(t, `${secretLine}\nbefore\n`);
  writeFileSync(path.join(fixture.model, "README.md"), `${secretLine}\nafter\n`);
  const patchPath = writePatch(fixture);

  await assert.rejects(validateCheckpoint(fixture, patchPath), /secret-like content/);
});

test("rejects tampered checkpoint metadata and Patch hashes", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "partial\n");
  const patchPath = writePatch(fixture);

  await assert.rejects(
    validateCheckpoint(fixture, patchPath, { patch_sha256: "0".repeat(64) }),
    /Patch hash is invalid/,
  );
  await assert.rejects(
    validateCheckpoint(fixture, patchPath, { unexpected: true }),
    /metadata is invalid/,
  );
});

test("rejects a checkpoint from a stale base", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "partial\n");
  const patchPath = writePatch(fixture);
  git(fixture.publish, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "advance base",
  ]);

  await assert.rejects(validateCheckpoint(fixture, patchPath), /base SHA is stale/);
});

test("rejects protected and forbidden files in a checkpoint Patch", async (t) => {
  const fixture = artifactFixture(t);
  mkdirSync(path.join(fixture.model, ".codex"), { recursive: true });
  writeFileSync(path.join(fixture.model, ".codex", "session.sqlite"), "session\n");
  const patchPath = writePatch(fixture);

  await assert.rejects(validateCheckpoint(fixture, patchPath), /protected path/);
  assert.equal(worker.isProtectedWorkerPath(".git/credentials"), true);
  assert.equal(worker.isProtectedWorkerPath(".codex/session.sqlite"), true);
  assert.equal(
    worker.isProtectedWorkerPath(".codex-worker-artifact/workspace.tar"),
    true,
  );
});

test("rejects oversized, binary, and invalid UTF-8 checkpoint Patches", async (t) => {
  const oversized = artifactFixture(t);
  const oversizedPatch = path.join(oversized.root, "oversized.patch");
  writeFileSync(oversizedPatch, "x".repeat(400 * 1024 + 1));
  await assert.rejects(validateCheckpoint(oversized, oversizedPatch), /400 KiB/);

  const binary = artifactFixture(t);
  writeFileSync(path.join(binary.model, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  const binaryPatch = writePatch(binary);
  await assert.rejects(validateCheckpoint(binary, binaryPatch), /binary/);

  const invalidUtf8 = artifactFixture(t);
  const invalidPatch = path.join(invalidUtf8.root, "invalid.patch");
  writeFileSync(invalidPatch, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(validateCheckpoint(invalidUtf8, invalidPatch), /UTF-8/);
});

test("rejects an unapplyable checkpoint Patch", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "partial\n");
  const patchPath = writePatch(fixture);
  writeFileSync(
    patchPath,
    readFileSync(patchPath, "utf8").replace("-before", "-missing-context"),
  );

  await assert.rejects(validateCheckpoint(fixture, patchPath), /apply --check/);
});

test("rejects symlinked checkpoint files", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "partial\n");
  const realPatch = writePatch(fixture);
  const checkpointPath = writeCheckpoint(fixture, realPatch);
  const linkedPatch = path.join(fixture.root, "linked-checkpoint.patch");
  symlinkSync(realPatch, linkedPatch);

  await assert.rejects(
    worker.validateWorkerCheckpoint({
      workspace: fixture.publish,
      patchPath: linkedPatch,
      checkpointPath,
      identity: {
        issueNumber: fixture.plan.issueNumber,
        cycle: fixture.plan.cycle,
        workerRunId: "b".repeat(64),
        baseSha: fixture.plan.startSha,
      },
      sourceAttempt: 1,
      acceptanceCriteriaIds: fixture.plan.acceptanceCriteriaIds,
    }),
    /regular files/,
  );
});

test("creates a trusted checkpoint for a recoverable model interruption", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "partial\n");
  const patchPath = writePatch(fixture);
  const checkpointDirectory = path.join(fixture.root, "trusted-checkpoint");

  const checkpoint = await worker.createWorkerCheckpoint({
    workspace: fixture.publish,
    patchPath,
    checkpointDirectory,
    plan: fixture.plan,
    errorClassification: "timeout",
  });

  assert.equal(checkpoint.sourceAttempt, 1);
  assert.equal(checkpoint.errorClassification, "timeout");
  assert.equal(
    readFileSync(path.join(checkpointDirectory, "change.patch"), "utf8"),
    readFileSync(patchPath, "utf8"),
  );
  assert.equal(
    JSON.parse(
      readFileSync(path.join(checkpointDirectory, "checkpoint.json"), "utf8"),
    ).worker_run_id,
    fixture.plan.workerRunId,
  );
});

test("validates and applies a bounded text Patch in a clean checkout", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "after\n");
  writeFileSync(path.join(fixture.model, "feature.txt"), "new file\n");
  const patchPath = writePatch(fixture);

  const validated = await worker.validateAndApplyWorkerArtifact({
    workspace: fixture.publish,
    patchPath,
    resultPath: fixture.resultPath,
    plan: fixture.plan,
  });

  assert.deepEqual(validated.changedPaths, ["README.md", "feature.txt"]);
  assert.equal(readFileSync(path.join(fixture.publish, "README.md"), "utf8"), "after\n");
  assert.equal(readFileSync(path.join(fixture.publish, "feature.txt"), "utf8"), "new file\n");
});

test("allows an empty Patch only when reusing an existing Draft PR", async (t) => {
  const resumed = artifactFixture(t);
  const emptyPatch = path.join(resumed.root, "empty.patch");
  writeFileSync(emptyPatch, "");
  const validated = await worker.validateAndApplyWorkerArtifact({
    workspace: resumed.publish,
    patchPath: emptyPatch,
    resultPath: resumed.resultPath,
    plan: {
      ...resumed.plan,
      branchExisted: true,
      pullRequestNumber: 9,
    },
  });
  assert.deepEqual(validated.changedPaths, []);

  const firstRun = artifactFixture(t);
  writeFileSync(path.join(firstRun.root, "empty.patch"), "");
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: firstRun.publish,
      patchPath: path.join(firstRun.root, "empty.patch"),
      resultPath: firstRun.resultPath,
      plan: { ...firstRun.plan, branchExisted: false },
    }),
    /existing Draft PR/,
  );

  const orphanBranch = artifactFixture(t);
  writeFileSync(path.join(orphanBranch.root, "empty.patch"), "");
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: orphanBranch.publish,
      patchPath: path.join(orphanBranch.root, "empty.patch"),
      resultPath: orphanBranch.resultPath,
      plan: { ...orphanBranch.plan, branchExisted: true },
    }),
    /existing Draft PR/,
  );

  const repair = artifactFixture(t);
  writeFileSync(path.join(repair.root, "empty.patch"), "");
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: repair.publish,
      patchPath: path.join(repair.root, "empty.patch"),
      resultPath: repair.resultPath,
      plan: {
        ...repair.plan,
        branchExisted: true,
        pullRequestNumber: 9,
        mode: "repair",
        repairRound: 1,
      },
    }),
    /existing Draft PR/,
  );
});

test("requires blocker-only results to publish an empty Patch", async (t) => {
  const blocked = artifactFixture(t);
  const emptyPatch = path.join(blocked.root, "blocked.patch");
  writeFileSync(emptyPatch, "");
  writeFileSync(
    blocked.resultPath,
    workerResult({
      completed: false,
      blocker_proposals: [blockerProposal],
      start_sha: blocked.plan.startSha,
      acceptance_criteria: [
        { id: "AC-1", status: "blocked", evidence: "Missing migration." },
      ],
    }),
  );
  const validated = await worker.validateAndApplyWorkerArtifact({
    workspace: blocked.publish,
    patchPath: emptyPatch,
    resultPath: blocked.resultPath,
    plan: { ...blocked.plan, branchExisted: false },
  });
  assert.deepEqual(validated.changedPaths, []);

  writeFileSync(path.join(blocked.model, "partial.txt"), "partial\n");
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: blocked.publish,
      patchPath: writePatch(blocked),
      resultPath: blocked.resultPath,
      plan: blocked.plan,
    }),
    /cannot publish a partial Patch/,
  );
});

test("requires #67-equivalent human handoffs to publish an empty Patch", async (t) => {
  const handedOff = artifactFixture(t);
  const emptyPatch = path.join(handedOff.root, "handoff.patch");
  writeFileSync(emptyPatch, "");
  writeFileSync(
    handedOff.resultPath,
    workerResult({
      completed: false,
      human_handoffs: [humanHandoff],
      start_sha: handedOff.plan.startSha,
      acceptance_criteria: [
        { id: "AC-1", status: "blocked", evidence: "Protected workflow path." },
      ],
    }),
  );
  const validated = await worker.validateAndApplyWorkerArtifact({
    workspace: handedOff.publish,
    patchPath: emptyPatch,
    resultPath: handedOff.resultPath,
    plan: handedOff.plan,
  });
  assert.deepEqual(validated.changedPaths, []);
  assert.equal(validated.result.human_handoffs[0].reason, "protected_path_change");

  writeFileSync(path.join(handedOff.model, "partial.txt"), "partial\n");
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: handedOff.publish,
      patchPath: writePatch(handedOff),
      resultPath: handedOff.resultPath,
      plan: handedOff.plan,
    }),
    /cannot publish a partial Patch/,
  );
});

test("rejects protected paths before applying a Worker Patch", async (t) => {
  const fixture = artifactFixture(t);
  mkdirSync(path.join(fixture.model, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(fixture.model, ".github", "workflows", "owned.yml"), "on: push\n");
  const patchPath = writePatch(fixture);

  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: fixture.publish,
      patchPath,
      resultPath: fixture.resultPath,
      plan: fixture.plan,
    }),
    /protected path/,
  );
  assert.equal(readFileSync(path.join(fixture.publish, "README.md"), "utf8"), "before\n");
  assert.equal(worker.isProtectedWorkerPath(".git/config"), true);
  assert.equal(worker.isProtectedWorkerPath(".gitmodules"), true);
});

test("rejects binary, executable, and oversized Worker Patches", async (t) => {
  const binary = artifactFixture(t);
  writeFileSync(path.join(binary.model, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: binary.publish,
      patchPath: writePatch(binary),
      resultPath: binary.resultPath,
      plan: binary.plan,
    }),
    /binary/,
  );

  const executable = artifactFixture(t);
  writeFileSync(path.join(executable.model, "run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(executable.model, "run.sh"), 0o755);
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: executable.publish,
      patchPath: writePatch(executable),
      resultPath: executable.resultPath,
      plan: executable.plan,
    }),
    /file mode/,
  );

  const oversized = artifactFixture(t);
  writeFileSync(path.join(oversized.root, "change.patch"), "x".repeat(400 * 1024 + 1));
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: oversized.publish,
      patchPath: path.join(oversized.root, "change.patch"),
      resultPath: oversized.resultPath,
      plan: oversized.plan,
    }),
    /400 KiB/,
  );
});

test("rejects symlinked Artifact files", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "after\n");
  const realPatch = writePatch(fixture);
  const linkedPatch = path.join(fixture.root, "linked.patch");
  symlinkSync(realPatch, linkedPatch);

  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: fixture.publish,
      patchPath: linkedPatch,
      resultPath: fixture.resultPath,
      plan: fixture.plan,
    }),
    /regular files/,
  );
});

test("rejects an oversized result before reading it", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "after\n");
  writeFileSync(fixture.resultPath, "x".repeat(256 * 1024 + 1));

  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: fixture.publish,
      patchPath: writePatch(fixture),
      resultPath: fixture.resultPath,
      plan: fixture.plan,
    }),
    /256 KiB/,
  );
});
