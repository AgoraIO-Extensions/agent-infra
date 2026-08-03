import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewSummary,
  collectAddedRightLines,
  isTrustedReviewComment,
  parseReviewOutput,
  sanitizeMarkdown,
  validateFindingLocations,
} from "./claude-review.mjs";

const head = "a".repeat(40);

function validOutput(overrides = {}) {
  return JSON.stringify({
    completed: true,
    head_sha: head,
    summary: "Review completed.",
    findings: [],
    ...overrides,
  });
}

test("parses a bounded Review result for the expected head", () => {
  assert.deepEqual(parseReviewOutput(validOutput(), head), {
    completed: true,
    head_sha: head,
    summary: "Review completed.",
    findings: [],
  });
});

test("rejects stale, incomplete, extended, or malformed Review output", () => {
  assert.throws(() => parseReviewOutput(validOutput({ head_sha: "b".repeat(40) }), head));
  assert.throws(() => parseReviewOutput(validOutput({ completed: false }), head));
  assert.throws(() => parseReviewOutput(validOutput({ unexpected: true }), head));
  assert.throws(() =>
    parseReviewOutput(
      validOutput({
        findings: [{ severity: "P3", title: "x", body: "x", path: "a.ts", line: 1 }],
      }),
      head,
    ),
  );
});

test("collects only added RIGHT-side lines from a unified patch", () => {
  const patch = "@@ -10,2 +10,3 @@\n same\n-old\n+new\n+more";
  assert.deepEqual([...collectAddedRightLines(patch)], [11, 12]);
});

test("rejects findings outside the changed RIGHT-side lines", () => {
  const files = [{ filename: "src/a.ts", patch: "@@ -1 +1,2 @@\n old\n+new" }];
  assert.doesNotThrow(() =>
    validateFindingLocations(
      [{ severity: "P1", title: "Bug", body: "Impact", path: "src/a.ts", line: 2 }],
      files,
    ),
  );
  assert.throws(() =>
    validateFindingLocations(
      [{ severity: "P1", title: "Bug", body: "Impact", path: "src/a.ts", line: 1 }],
      files,
    ),
  );
});

test("P0 and P1 become blocking threads while P2 stays in the summary", () => {
  const summary = buildReviewSummary({
    summary: "Review completed.",
    findings: [
      { severity: "P1", title: "Broken", body: "Impact", path: "a.ts", line: 1 },
      { severity: "P2", title: "Minor", body: "Small impact", path: "b.ts", line: 2 },
    ],
  });
  assert.deepEqual(summary.blocking.map((finding) => finding.severity), ["P1"]);
  assert.match(summary.markdown, /P2 Minor/);
  assert.doesNotMatch(summary.markdown, /P1 Broken/);
});

test("sanitizes mentions and trusted comment markers", () => {
  assert.equal(
    sanitizeMarkdown("@team <!-- claude-review-summary -->\u0000"),
    "@\u200bteam &lt;!-- claude-review-summary --&gt;",
  );
});

test("deduplicates findings only against github-actions bot comments", () => {
  const marker = "<!-- agent-infra-claude-review:head:key -->";
  assert.equal(
    isTrustedReviewComment(
      { user: { login: "github-actions[bot]", type: "Bot" }, body: marker },
      marker,
    ),
    true,
  );
  assert.equal(
    isTrustedReviewComment(
      { user: { login: "contributor", type: "User" }, body: marker },
      marker,
    ),
    false,
  );
});
