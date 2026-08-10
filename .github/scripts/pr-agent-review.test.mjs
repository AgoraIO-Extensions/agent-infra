import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCurrentPrAgentTarget,
  buildPrAgentReview,
  parsePrAgentEvent,
  parsePrAgentOutput,
  validatePrAgentLocations,
} from "./pr-agent-review.mjs";

const head = "a".repeat(40);

function validReview(overrides = {}) {
  return JSON.stringify({
    key_issues_to_review: [],
    ...overrides,
  });
}

function validIssue(overrides = {}) {
  return {
    relevant_file: "src/app.ts",
    issue_header: "Missing guard",
    issue_content: "The new branch accepts an invalid state.",
    start_line: 2,
    end_line: 2,
    ...overrides,
  };
}

test("parses the bounded PR-Agent review schema", () => {
  const issue = validIssue();
  assert.deepEqual(
    parsePrAgentOutput(validReview({ key_issues_to_review: [issue] })),
    { key_issues_to_review: [issue] },
  );
});

test("rejects malformed, extended, oversized, and unbounded PR-Agent output", () => {
  assert.throws(() => parsePrAgentOutput(""));
  assert.throws(() => parsePrAgentOutput("{"), { name: "PrAgentOutputError" });
  assert.throws(() => parsePrAgentOutput(validReview({ extra: true })));
  assert.throws(() =>
    parsePrAgentOutput(
      validReview({ key_issues_to_review: [validIssue({ end_line: 103 })] }),
    ),
  );
  assert.throws(() =>
    parsePrAgentOutput(
      validReview({
        key_issues_to_review: Array.from({ length: 11 }, () => validIssue()),
      }),
    ),
  );
});

test("requires every PR-Agent finding range to cover a changed RIGHT line", () => {
  const files = [
    {
      filename: "src/app.ts",
      patch: "@@ -1,2 +1,3 @@\n old\n+new\n old",
    },
  ];
  assert.doesNotThrow(() => validatePrAgentLocations([validIssue()], files));
  assert.throws(
    () => validatePrAgentLocations([validIssue({ start_line: 3, end_line: 3 })], files),
    { name: "PrAgentOutputError" },
  );
  assert.throws(
    () =>
      validatePrAgentLocations(
        [validIssue({ relevant_file: "missing.ts" })],
        files,
      ),
    { name: "PrAgentOutputError" },
  );
});

test("accepts only an open current-head same-repository PR", () => {
  const target = {
    state: "open",
    head: { sha: head, repo: { full_name: "example/repo" } },
    base: { repo: { full_name: "example/repo" } },
  };
  assert.doesNotThrow(() => assertCurrentPrAgentTarget(target, head));
  assert.throws(() =>
    assertCurrentPrAgentTarget(
      { ...target, head: { ...target.head, sha: "b".repeat(40) } },
      head,
    ),
  );
  assert.throws(() =>
    assertCurrentPrAgentTarget(
      { ...target, head: { ...target.head, repo: { full_name: "fork/repo" } } },
      head,
    ),
  );
});

test("records only a same-repository 40-hex event head", () => {
  const event = {
    pull_request: {
      head: { sha: head, repo: { full_name: "example/repo" } },
      base: { repo: { full_name: "example/repo" } },
    },
  };
  assert.equal(parsePrAgentEvent(JSON.stringify(event)), head);
  assert.throws(() =>
    parsePrAgentEvent(
      JSON.stringify({
        pull_request: {
          ...event.pull_request,
          head: { sha: head, repo: { full_name: "fork/repo" } },
        },
      }),
    ),
  );
  assert.throws(() => parsePrAgentEvent("{}"));
});

test("renders sanitized fixed Markdown instead of model-controlled API requests", () => {
  const body = buildPrAgentReview(
    {
      key_issues_to_review: [
        validIssue({
          issue_header: "Ping @team <!-- hidden -->",
          issue_content: "Check @owner.",
        }),
      ],
    },
    head,
  );
  assert.match(body, /agent-infra-pr-agent-review/);
  assert.match(body, /src\/app\.ts:2/);
  assert.equal(body.includes("@team"), false);
  assert.equal(body.includes("<!-- hidden -->"), false);
});
