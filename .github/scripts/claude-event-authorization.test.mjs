import assert from "node:assert/strict";
import test from "node:test";

import * as authorization from "./claude-event-authorization.mjs";

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

test("uses a verified Issue association when the event association is not trusted", () => {
  for (const authorAssociation of ["NONE", undefined]) {
    for (const verifiedIssueAuthorAssociation of trustedAssociations) {
      assert.equal(
        authorizeClaudeEvent(
          "issues",
          {
            action: "opened",
            issue: { number: 10, author_association: authorAssociation },
          },
          { verifiedIssueAuthorAssociation },
        ),
        true,
      );
    }
  }
});

test("rejects an untrusted verified Issue association", () => {
  for (const verifiedIssueAuthorAssociation of [
    "CONTRIBUTOR",
    "FIRST_TIMER",
    "FIRST_TIME_CONTRIBUTOR",
    "NONE",
    undefined,
  ]) {
    assert.equal(
      authorizeClaudeEvent(
        "issues",
        {
          action: "opened",
          issue: { number: 10, author_association: undefined },
        },
        { verifiedIssueAuthorAssociation },
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
      { verifiedIssueAuthorAssociation: "NONE" },
    ),
    true,
  );
});

test("reads the authoritative Issue association from the GitHub API", async () => {
  assert.equal(typeof authorization.fetchIssueAuthorAssociation, "function");

  const calls = [];
  const result = await authorization.fetchIssueAuthorAssociation({
    repository: "example/agent-infra",
    issueNumber: 10,
    token: "test-token",
    request: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ author_association: "COLLABORATOR" }),
      };
    },
  });

  assert.equal(result, "COLLABORATOR");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/example/agent-infra/issues/10",
  );
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
});

test("fails closed when the Issue association lookup fails", async () => {
  assert.equal(typeof authorization.fetchIssueAuthorAssociation, "function");

  await assert.rejects(
    authorization.fetchIssueAuthorAssociation({
      repository: "example/agent-infra",
      issueNumber: 10,
      token: "test-token",
      request: async () => ({ ok: false, status: 503 }),
    }),
    /GitHub Issue lookup failed: 503/,
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
