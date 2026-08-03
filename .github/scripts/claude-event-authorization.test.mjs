import assert from "node:assert/strict";
import test from "node:test";

import { authorizeClaudeEvent } from "./claude-event-authorization.mjs";

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
