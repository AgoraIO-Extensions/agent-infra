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
        json: async () => ({ permission: "maintain" }),
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
