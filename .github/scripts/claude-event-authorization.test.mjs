import assert from "node:assert/strict";
import test from "node:test";

import * as authorization from "./claude-event-authorization.mjs";
import {
  BLOCKER_REVIEW_COMMENT,
  buildBlockerIssue,
} from "./blocker-contract.mjs";

const { authorizeClaudeEvent } = authorization;

const trustedAssociations = ["MEMBER", "OWNER", "COLLABORATOR"];

test("authorizes a new Issue from every trusted association", () => {
  for (const authorAssociation of trustedAssociations) {
    assert.equal(
      authorizeClaudeEvent("issues", {
        action: "opened",
        issue: { author_association: authorAssociation },
      }),
      true,
    );
  }
});

test("rejects a new Issue from an untrusted association", () => {
  for (const authorAssociation of ["CONTRIBUTOR", "FIRST_TIMER", "NONE", undefined]) {
    assert.equal(
      authorizeClaudeEvent("issues", {
        action: "opened",
        issue: { author_association: authorAssociation },
      }),
      false,
    );
  }
});

test("uses a verified repository permission when the event association is not trusted", () => {
  for (const authorAssociation of ["NONE", undefined]) {
    for (const verifiedRepositoryPermission of [
      "admin",
      "maintain",
      "write",
      "triage",
    ]) {
      assert.equal(
        authorizeClaudeEvent(
          "issues",
          {
            action: "opened",
            issue: { number: 10, author_association: authorAssociation },
          },
          { verifiedRepositoryPermission },
        ),
        true,
      );
    }
  }
});

test("rejects repository permissions below triage", () => {
  for (const verifiedRepositoryPermission of ["read", "none", undefined]) {
    assert.equal(
      authorizeClaudeEvent(
        "issues",
        {
          action: "opened",
          issue: { number: 10, author_association: undefined },
        },
        { verifiedRepositoryPermission },
      ),
      false,
    );
  }
});

test("keeps a trusted event association authoritative", () => {
  assert.equal(
    authorizeClaudeEvent(
      "issues",
      {
        action: "opened",
        issue: { number: 10, author_association: "OWNER" },
      },
      { verifiedRepositoryPermission: "read" },
    ),
    true,
  );
});

test("reads the Issue author's repository permission from the GitHub API", async () => {
  assert.equal(typeof authorization.fetchRepositoryPermission, "function");

  const calls = [];
  const result = await authorization.fetchRepositoryPermission({
    repository: "example/agent-infra",
    username: "member-user",
    token: "test-token",
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ permission: "write", role_name: "maintain" }),
      };
    },
  });

  assert.equal(result, "maintain");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/example/agent-infra/collaborators/member-user/permission",
  );
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
});

test("fails closed when the repository permission lookup fails", async () => {
  assert.equal(typeof authorization.fetchRepositoryPermission, "function");

  await assert.rejects(
    authorization.fetchRepositoryPermission({
      repository: "example/agent-infra",
      username: "member-user",
      token: "test-token",
      request: async () => ({ ok: false, status: 503 }),
    }),
    /GitHub repository permission lookup failed: 503/,
  );
});

test("authorizes only the claude label on labeled Issue events", () => {
  assert.equal(
    authorizeClaudeEvent("issues", { action: "labeled", label: { name: "claude" } }),
    true,
  );
  assert.equal(
    authorizeClaudeEvent("issues", { action: "labeled", label: { name: "bug" } }),
    false,
  );
});

test("authorizes member mentions across Issue and PR Review comments", () => {
  assert.equal(
    authorizeClaudeEvent("issue_comment", {
      comment: { body: "@claude review this", author_association: "MEMBER" },
    }),
    true,
  );
  assert.equal(
    authorizeClaudeEvent("pull_request_review_comment", {
      comment: { body: "please ask @claude", author_association: "OWNER" },
    }),
    true,
  );
  assert.equal(
    authorizeClaudeEvent("pull_request_review", {
      review: { body: "@claude check the update", author_association: "COLLABORATOR" },
    }),
    true,
  );
});

test("rejects untrusted or absent mentions", () => {
  assert.equal(
    authorizeClaudeEvent("issue_comment", {
      comment: { body: "@claude review this", author_association: "NONE" },
    }),
    false,
  );
  assert.equal(
    authorizeClaudeEvent("pull_request_review", {
      review: { body: "looks good", author_association: "MEMBER" },
    }),
    false,
  );
  assert.equal(authorizeClaudeEvent("workflow_dispatch", {}), false);
});

test("authorizes one live-verified blocker review repository dispatch", async () => {
  const blocker = buildBlockerIssue({
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
    number: 90,
    title: blocker.title,
    body: blocker.body,
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  const comments = [
    {
      body: blocker.identityComment,
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
      created_at: "2026-08-06T00:00:00Z",
      updated_at: "2026-08-06T00:00:00Z",
    },
    {
      body: BLOCKER_REVIEW_COMMENT,
      author_association: "NONE",
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
      created_at: "2026-08-06T00:00:00Z",
      updated_at: "2026-08-06T00:00:00Z",
    },
  ];
  const request = async (apiPath, options = {}) => {
    if (apiPath.endsWith("/issues/90")) return issue;
    if (apiPath.includes("/issues/90/comments?") && !options.method) return comments;
    if (apiPath.endsWith("/issues/90/comments") && options.method === "POST") {
      comments.push({
        body: JSON.parse(options.body).body,
        user: { login: "github-actions[bot]", type: "Bot" },
        performed_via_github_app: { id: 15368 },
        created_at: "2026-08-06T00:00:01Z",
        updated_at: "2026-08-06T00:00:01Z",
      });
      return comments.at(-1);
    }
    throw new Error(`Unexpected request: ${apiPath}`);
  };
  assert.equal(
    authorizeClaudeEvent(
      "repository_dispatch",
      { action: "claude-blocker-review" },
      { verifiedBlockerReview: true },
    ),
    true,
  );
  assert.equal(
    authorizeClaudeEvent(
      "repository_dispatch",
      { action: "claude-blocker-review" },
      { verifiedBlockerReview: false },
    ),
    false,
  );
  assert.equal(
    await authorization.authorizeBlockerReviewDispatch({
      repository: "example/agent-infra",
      issueNumber: 90,
      token: "test-token",
      request,
    }),
    true,
  );
  assert.equal(
    await authorization.authorizeBlockerReviewDispatch({
      repository: "example/agent-infra",
      issueNumber: 90,
      token: "test-token",
      request,
    }),
    false,
  );
  assert.equal(comments.length, 3);
});
