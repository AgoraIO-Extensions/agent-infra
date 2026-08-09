import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTrustedBlockerReviewResult,
  publishBlockerReview,
  sanitizeBlockerReviewMarkdown,
  validateBlockerReviewOutput,
} from "./claude-blocker-review.mjs";
import {
  BLOCKER_REVIEW_COMMENT,
  buildBlockerIssue,
  buildBlockerReviewAck,
} from "./blocker-contract.mjs";

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

function fixture() {
  const rendered = buildBlockerIssue({
    sourceIssue: 42,
    sourceCycle: 3,
    executionContentHash: "a".repeat(64),
    proposal: {
      proposal_id: "missing-migration",
      title: "add the missing migration",
      problem: "The required table does not exist.",
      deliverable: "A versioned migration that creates the missing table.",
      scope: ["Add the migration."],
      acceptance_criteria: [{ id: "AC-1", text: "Migration applies." }],
      validation: ["Run migration tests."],
    },
  });
  const issue = {
    id: 9_000,
    number: 90,
    state: "open",
    title: rendered.title,
    body: rendered.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const comments = [
    appComment(1, rendered.identityComment),
    appComment(2, BLOCKER_REVIEW_COMMENT),
    appComment(3, buildBlockerReviewAck(90, rendered.record)),
  ];
  const calls = [];
  const request = async (apiPath, options = {}) => {
    calls.push({ apiPath, options });
    if (apiPath.endsWith("/issues/90") && !options.method) return issue;
    if (apiPath.endsWith("/issues/90/comments") && options.method === "POST") {
      const comment = appComment(comments.length + 1, JSON.parse(options.body).body);
      comments.push(comment);
      return comment;
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  return {
    rendered,
    issue,
    comments,
    calls,
    request,
    paginate: async () => comments,
  };
}

function output(overrides = {}) {
  return JSON.stringify({
    completed: true,
    issue_number: 90,
    summary: "The blocker is actionable.",
    findings: [],
    ...overrides,
  });
}

test("validates bounded blocker Review output and sanitizes active Markdown", () => {
  assert.equal(validateBlockerReviewOutput(output(), 90).findings.length, 0);
  assert.throws(() => validateBlockerReviewOutput(output({ issue_number: 91 }), 90));
  assert.throws(() =>
    validateBlockerReviewOutput(output({ labels: ["ready-for-agent"] }), 90),
  );
  assert.equal(
    sanitizeBlockerReviewMarkdown("@team <!-- hidden --> ```"),
    "@\u200bteam &lt;!-- hidden --&gt; `\u200b``",
  );
});

test("publishes one trusted advisory result and suppresses a replay", async () => {
  const github = fixture();
  assert.deepEqual(
    await publishBlockerReview({
      repository: "example/agent-infra",
      issueNumber: 90,
      analysisResult: "success",
      structuredOutput: output({
        findings: [
          {
            severity: "P1",
            title: "Missing rollback",
            body: "Add rollback validation.",
          },
        ],
      }),
      token: "test-token",
      request: github.request,
      paginate: github.paginate,
    }),
    { published: true, status: "success" },
  );
  assert.equal(
    hasTrustedBlockerReviewResult(github.comments, 90, github.rendered.record),
    true,
  );
  assert.match(github.comments.at(-1).body, /Missing rollback/);

  const mutations = github.calls.filter(
    (call) => call.options.method && call.options.method !== "GET",
  ).length;
  assert.deepEqual(
    await publishBlockerReview({
      repository: "example/agent-infra",
      issueNumber: 90,
      analysisResult: "success",
      structuredOutput: output(),
      token: "test-token",
      request: github.request,
      paginate: github.paginate,
    }),
    { published: false, reason: "already-published" },
  );
  assert.equal(
    github.calls.filter((call) => call.options.method && call.options.method !== "GET")
      .length,
    mutations,
  );
});

test("publishes a stable failure result without exposing model output", async () => {
  const github = fixture();
  assert.deepEqual(
    await publishBlockerReview({
      repository: "example/agent-infra",
      issueNumber: 90,
      analysisResult: "failure",
      structuredOutput: "secret raw output",
      token: "test-token",
      request: github.request,
      paginate: github.paginate,
    }),
    { published: true, status: "infrastructure_failure" },
  );
  assert.doesNotMatch(github.comments.at(-1).body, /secret raw output/);
  assert.match(github.comments.at(-1).body, /infrastructure_failure/);
});
